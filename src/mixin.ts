// The mixin device: one implementation of the Scrypted-facing half — ffmpeg, real-time pacing,
// the bounded queue, `Intercom`, and `PanTiltZoom` for the drivers whose protocol carries it.
//
// Everything vendor-specific lives in drivers/. This file exists once so a fourth vendor is a
// driver, not another plugin.

import type {
    FFmpegInput, Intercom, MediaObject, MixinDeviceOptions, Settings, VideoCamera,
} from '@scrypted/sdk';
import { MixinDeviceBase, ScryptedMimeTypes } from '@scrypted/sdk';
import * as child_process from 'child_process';
import { DriverConfig, IntercomDriver } from './drivers/driver';
import { resolveHost } from './ptzMixin';
import { sdk } from './sdkFix';

/** Bound the queue so a bursty producer costs latency, not unbounded memory.
 *
 * Trimming discards the OLDEST audio, which for live talkback is the right end to lose -- but it
 * is also, literally, the start of the caller's sentence, so the cap must be generous enough that
 * ordinary jitter never reaches it. At these rates a second of audio is ~16 KB, so headroom is
 * nearly free and the cap is set well above the opening padding (WARMUP_MS + LEAD_MS) plus any
 * plausible transcoder stall. */
const MAX_QUEUED_SECONDS = 3;
/** Silence sent immediately after the talk session opens, before any real audio.
 *
 * These devices are not ready to play the moment they accept a session: audio sent in the first
 * moments is partly dropped while the speaker path comes up. Measured on the Reolink as
 * "beep — gap — steady tone": the device played a little, lost the rest of the opening, then ran
 * cleanly. Feeding SILENCE through that window instead means the loss lands on silence and the
 * caller's first words survive. It costs no added latency for the caller, unlike buffering real
 * audio ahead of the first frame, which is what made this worse. */
const WARMUP_MS = 300;
/** Audio to hold before real frames start flowing, and to re-earn after the source stalls.
 *
 * ffmpeg's first read arrives as an early lump followed by a pause, so playing audio the instant
 * any exists reproduces that shape audibly. This is latency added to the front of a talk session,
 * so it stays small -- large enough to cover transcoder startup, small enough to stay unnoticed
 * next to the WARMUP_MS of silence that already precedes it. */
const LEAD_MS = 250;

export type DriverFactory = (host: string, console: Console) => Promise<IntercomDriver>;

export class CameraIntercomMixin extends MixinDeviceBase<VideoCamera & Partial<Settings>> implements Intercom {
    private driver?: IntercomDriver;
    private ffmpeg?: child_process.ChildProcess;
    private pump?: Promise<void>;
    private stopping = false;
    private queue: Buffer[] = [];
    private queuedBytes = 0;

    constructor(
        options: MixinDeviceOptions<VideoCamera & Partial<Settings>>,
        private createDriver: DriverFactory,
    ) {
        super(options);
    }

    async startIntercom(media: MediaObject): Promise<void> {
        await this.stopIntercom();
        this.stopping = false;
        const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);

        const host = await resolveHost(this.mixinDevice);
        const driver = await this.createDriver(host, this.console);
        await driver.open();
        this.driver = driver;
        const format = driver.format;
        this.console.log(`intercom: ${driver.name} talking to ${host} at ${format.sampleRate} Hz, `
            + `${format.pcmFrameBytes}-byte frames`);
        for (const note of driver.notes)
            this.console.log(`intercom: ${note}`);

        // One ffmpeg configuration for every vendor: the drivers all accept s16le PCM at their
        // own native rate and encode internally.
        //
        // The resample is tuned rather than left to the default. Callers arrive as 16 or 24 kHz
        // Opus from HomeKit and every device here wants 8 or 16 kHz, so a downsample always
        // happens; soxr with triangular dither costs nothing at these rates and avoids adding
        // aliasing and quantisation noise on top of what the vendor codecs already do to speech
        // (the 8 kHz A-law devices have no headroom to spare).
        //
        // These are passed as swresample OUTPUT OPTIONS, deliberately NOT as an `-af aresample=`
        // filter: ffmpeg lets the LAST `-af` win, so a filter here would silently discard any
        // filter chain the caller supplied in `inputArguments`. That is not hypothetical -- it
        // ate a `volume=` filter during testing and looked exactly like the device playing quietly.
        //
        // soxr is a compile-time option, so its presence in whichever ffmpeg Scrypted hands us is
        // checked rather than assumed: naming a resampler that was not built in fails the whole
        // process, which would take talkback down for a marginal quality gain.
        const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
        const resampler = await hasSoxr(ffmpegPath, this.console);
        const inputArgs = ffmpegInput.inputArguments?.length ? ffmpegInput.inputArguments : ['-i', ffmpegInput.url!];
        const args = [
            '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
            ...inputArgs,
            '-vn', '-sn', '-dn',
            '-acodec', 'pcm_s16le', '-ar', String(format.sampleRate), '-ac', '1',
            ...(resampler ? ['-resampler', 'soxr', '-precision', '28'] : []),
            '-dither_method', 'triangular',
            '-f', 's16le', '-flush_packets', '1', 'pipe:1',
        ];
        const proc = child_process.spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.ffmpeg = proc;
        proc.stderr?.resume(); // ffmpeg logs to stderr even on a clean run; nothing here is actionable
        proc.on('exit', code => this.console.log(`intercom: ffmpeg exited (code ${code})`));

        const maxQueued = format.sampleRate * 2 * MAX_QUEUED_SECONDS;
        proc.stdout?.on('data', (chunk: Buffer) => {
            this.queue.push(chunk);
            this.queuedBytes += chunk.length;
            while (this.queuedBytes > maxQueued && this.queue.length > 1)
                this.queuedBytes -= this.queue.shift()!.length;
        });

        this.pump = this.pumpAudio(driver);
    }

    async stopIntercom(): Promise<void> {
        this.stopping = true;
        this.ffmpeg?.kill('SIGTERM');
        this.ffmpeg = undefined;
        const pump = this.pump;
        this.pump = undefined;
        await pump?.catch(e => this.console.warn('intercom: pump failed:', e.message));
        this.queue = [];
        this.queuedBytes = 0;
        const driver = this.driver;
        this.driver = undefined;
        if (!driver)
            return;
        await driver.close().catch(e => this.console.warn(`intercom: ${driver.name} close failed:`, e.message));
    }

    override release(): void {
        this.stopIntercom().catch(e => this.console.warn('intercom: stopIntercom during release failed:', e.message));
        super.release();
    }

    /** Emits exactly one device frame per frame-duration, for as long as the session lasts.
     *
     * Three invariants, each learned from an audible failure on real hardware. A standalone sender
     * that synthesises audio and paces it perfectly sounds flawless on these cameras, so anything
     * audible here is this pipeline's doing, not the device's or the protocol's.
     *
     * 1. The stream is CONTINUOUS. When there is nothing to send the frame is silence, never a
     *    hole, and the session opens on WARMUP_MS of silence: a device drops audio while its
     *    speaker path comes up, and silence is what should land in that window. Sending real audio
     *    into it was heard on the Reolink as "beep, gap, steady tone".
     *
     * 2. Pacing NEVER accumulates debt. Frames are due on a monotonic clock so transcode jitter
     *    cannot drift, but falling behind resets the clock to now instead of firing frames back to
     *    back. Every device here discards audio arriving faster than real time, so a catch-up
     *    burst is thrown away and heard as a gap -- and this is live audio, so there is nothing to
     *    catch up to.
     *
     * 3. Real audio only flows once a LEAD exists, and a stall re-earns it. ffmpeg does not begin
     *    smoothly: its first read lands early as a lump, then pauses before reaching steady state.
     *    Playing that lump immediately produced "beep, pause, then continuous" -- the pump had
     *    faithfully rendered ffmpeg's own startup shape. Holding a small lead absorbs it, and
     *    re-priming after a stall keeps a struggling source sounding like a clean pause instead of
     *    audio alternating with silence every other frame.
     *
     * A device that QUEUES rather than discards gets `format.prebufferMs` written flat out first,
     * giving its player slack that a hardware camera's internal buffer provides for free.
     */
    private async pumpAudio(driver: IntercomDriver): Promise<void> {
        const { sampleRate, pcmFrameBytes, prebufferMs } = driver.format;
        const frameMs = (pcmFrameBytes / 2 / sampleRate) * 1000;
        const silence = Buffer.alloc(pcmFrameBytes);
        const leadBytes = Math.max(pcmFrameBytes, Math.ceil(LEAD_MS / frameMs) * pcmFrameBytes);

        // Unpaced prebuffer: silence written as fast as the socket takes it, so the device's own
        // player starts with slack instead of running on the edge of underrun. It doubles as the
        // warm-up for such a device, hence the deduction below rather than padding twice.
        const prebufferFrames = Math.ceil((prebufferMs ?? 0) / frameMs);
        for (let i = 0; i < prebufferFrames && !this.stopping; i++)
            await driver.write(silence);
        if (prebufferFrames)
            this.console.log(`intercom: prebuffered ${(prebufferFrames * frameMs).toFixed(0)} ms of silence unpaced`);

        let warmupFrames = Math.max(0, Math.round(WARMUP_MS / frameMs) - prebufferFrames);
        let primed = false;
        let filled = 0;
        let stalls = 0;
        let nextDue = Date.now();

        while (!this.stopping) {
            let frame: Buffer<ArrayBufferLike> = silence;
            if (warmupFrames > 0) {
                warmupFrames--;
            }
            else if (primed && this.queuedBytes >= pcmFrameBytes) {
                frame = this.take(pcmFrameBytes);
            }
            else {
                // Not primed, or primed and just ran dry: send silence and (re-)earn the lead.
                if (primed) {
                    primed = false;
                    stalls++;
                }
                if (this.queuedBytes >= leadBytes)
                    primed = true;
                filled++;
            }

            await driver.write(frame);

            nextDue += frameMs;
            const slack = nextDue - Date.now();
            if (slack > 0) {
                const paced = Promise.withResolvers<void>();
                setTimeout(paced.resolve, slack);
                await paced.promise;
            } else {
                nextDue = Date.now();
            }
        }
        if (filled)
            this.console.log(`intercom: ${(filled * frameMs).toFixed(0)} ms sent as silence`
                + ` (${stalls} source stall(s) after the opening lead)`);
    }

    private take(bytes: number): Buffer {
        const parts: Buffer[] = [];
        let need = bytes;
        while (need > 0) {
            const head = this.queue[0];
            if (head.length <= need) {
                parts.push(head);
                this.queue.shift();
                need -= head.length;
            } else {
                parts.push(head.subarray(0, need));
                this.queue[0] = head.subarray(need);
                need = 0;
            }
        }
        this.queuedBytes -= bytes;
        return parts.length === 1 ? parts[0] : Buffer.concat(parts);
    }

}

/** Whether this ffmpeg was built with libsoxr, probed once per plugin run.
 *
 * Cached because it cannot change while the process lives, and because probing on every talk
 * session would put a process spawn in the path of pressing the talk button. A probe failure is
 * treated as "not available": the default resampler is perfectly usable, so the quality knob is
 * never worth risking the session over. */
let soxrProbe: Promise<boolean> | undefined;
function hasSoxr(ffmpegPath: string, console: Console): Promise<boolean> {
    soxrProbe ??= new Promise<boolean>(resolve => {
        const proc = child_process.spawn(ffmpegPath, ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        proc.stdout.on('data', (c: Buffer) => { out += c.toString(); });
        proc.on('error', () => resolve(false));
        proc.on('close', () => {
            const available = out.includes('--enable-libsoxr');
            console.log(`intercom: ffmpeg ${available ? 'has libsoxr, using it for the downsample' : 'lacks libsoxr, using the default resampler'}`);
            resolve(available);
        });
    });
    return soxrProbe;
}

export type { DriverConfig };

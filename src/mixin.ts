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

/** How much audio may sit queued ahead of the pump, as a multiple of the lead, plus a floor.
 *
 * This bounds LATENCY, which is the thing that matters -- an earlier version bounded memory
 * instead (3 seconds' worth) and that was a mistake with a directly audible cost: the pump drains
 * at exactly real time and never faster, so any burst from the source becomes a backlog that
 * persists for the whole session. Measured over HomeKit on a doorbell: 1-2 seconds between
 * speaking and hearing it, none of which was the device or the network.
 *
 * When the queue exceeds the target the OLDEST audio goes, because in a live conversation the
 * freshest audio is the only audio worth hearing; dropping a moment is strictly better than
 * talking into a growing delay. The source and sink both run at real time, so this only triggers
 * when the source genuinely runs ahead.
 *
 * The target must stay ABOVE the source's normal burst size, or it trims continuously, and each
 * trim is a discontinuity -- on a continuous tone that is an audible phase jump, reported as "two
 * tones overlaid" with crackle. Real clients (HomeKit, the Scrypted app) were measured bursting to
 * ~206 ms, so the target sits above that. It is deliberately NOT sized for ffmpeg's `lavfi` test
 * source, which delivers in much larger lumps (~450 ms) and would drag the standing latency to
 * ~350 ms if it set the budget; the tone tools ask lavfi for small frames instead. The drop
 * counter in the session telemetry is the check: it should be zero on a healthy source. */
const QUEUE_TARGET_SLACK_MS = 150;
const QUEUE_TARGET_FLOOR_MS = 250;
/** How far behind schedule the pump may fall before it gives up on catching up and resyncs.
 *
 * Deliberately large. Resetting the clock on ordinary lateness is what made the sink run slower
 * than real time -- the frame period became "frameMs + whatever the write cost" -- so the backlog
 * grew all session and the device was starved. Ordinary lateness is therefore caught up by
 * sending the next frame immediately; only a gap no catch-up could cover starts a new clock. */
const RESYNC_THRESHOLD_MS = 1000;
/** Past this the delay is worse than a glitch, so audio is dropped whatever its level. */
const QUEUE_HARD_CEILING_MS = 1200;
/** Below this RMS a chunk is treated as a pause, and is what catch-up is allowed to discard.
 * ~1% of full scale: comfortably above a quiet room's noise floor through these codecs, well
 * below speech. */
const QUIET_RMS = 300;
/** Silence sent immediately after the talk session opens, before any real audio.
 *
 * These devices are not ready to play the moment they accept a session: audio sent in the first
 * moments is partly dropped while the speaker path comes up. Measured on the Reolink as
 * "beep — gap — steady tone": the device played a little, lost the rest of the opening, then ran
 * cleanly. Feeding SILENCE through that window instead means the loss lands on silence and the
 * caller's first words survive. It costs no added latency for the caller, unlike buffering real
 * audio ahead of the first frame, which is what made this worse. */
export const DEFAULT_WARMUP_MS = 300;
/** Audio to hold before real frames start flowing, and to re-earn after the source stalls.
 *
 * ffmpeg's first read arrives as an early lump followed by a pause, so playing audio the instant
 * any exists reproduces that shape audibly. This is latency added to the front of a talk session,
 * so it stays small -- large enough to cover transcoder startup, small enough to stay unnoticed
 * next to the warm-up silence that already precedes it. */
export const DEFAULT_LEAD_MS = 250;

/** The two timings above, resolved per talk session so they can be tuned against real hardware
 * without a rebuild. A wired device on a quiet LAN tolerates a much smaller lead than a camera
 * behind wifi, and the right value is a property of the install, not of this code. */
export interface PumpTiming {
    warmupMs: number;
    leadMs: number;
}

export type DriverFactory = (host: string, console: Console) => Promise<IntercomDriver>;

export class CameraIntercomMixin extends MixinDeviceBase<VideoCamera & Partial<Settings>> implements Intercom {
    private driver?: IntercomDriver;
    private ffmpeg?: child_process.ChildProcess;
    private pump?: Promise<void>;
    private stopping = false;
    private queue: { chunk: Buffer; at: number }[] = [];
    private queuedBytes = 0;
    /** Session telemetry: how deep the queue got, and how much had to be dropped to hold the
     * latency target. Both are reported at stop, because "1-2 seconds of delay" is otherwise
     * impossible to attribute between this process, the caller's network and the device. */
    private peakQueuedBytes = 0;
    private droppedBytes = 0;
    /** Age-at-send accumulators: this pipeline's own latency contribution, in milliseconds. */
    private ageSumMs = 0;
    private ageSamples = 0;
    private peakAgeMs = 0;

    constructor(
        options: MixinDeviceOptions<VideoCamera & Partial<Settings>>,
        private createDriver: DriverFactory,
        private timing: (host: string) => PumpTiming,
        private report: (line: string) => void,
    ) {
        super(options);
    }

    async startIntercom(media: MediaObject): Promise<void> {
        await this.stopIntercom();
        this.stopping = false;
        const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);

        const host = await resolveHost(this.mixinDevice);
        const tStart = Date.now();
        const driver = await this.createDriver(host, this.console);
        const tDriverCreated = Date.now();
        await driver.open();
        const tDriverOpen = Date.now();
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
        // HomeKit delivers talkback as an rtsp:// input (it stands up a local RTSP server and
        // re-serves the phone's Opus through it), and ffmpeg's RTSP demuxer defaults are tuned for
        // playback smoothness rather than for a live conversation: `max_delay` alone is half a
        // second of deliberate buffering. These only apply to an RTSP input, so they are added
        // only when the caller actually gave us one.
        const rtspInput = inputArgs.some(arg => arg.startsWith('rtsp://'));
        const lowLatencyRtsp = rtspInput
            ? ['-max_delay', '0', '-reorder_queue_size', '0', '-rtsp_flags', 'prefer_tcp']
            : [];
        const args = [
            '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
            ...lowLatencyRtsp,
            ...inputArgs,
            '-vn', '-sn', '-dn',
            '-acodec', 'pcm_s16le', '-ar', String(format.sampleRate), '-ac', '1',
            ...(resampler ? ['-resampler', 'soxr', '-precision', '28'] : []),
            '-dither_method', 'triangular',
            '-f', 's16le', '-flush_packets', '1', 'pipe:1',
        ];
        const tSpawn = Date.now();
        const proc = child_process.spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.ffmpeg = proc;
        let firstByteLogged = false;
        proc.stderr?.resume(); // ffmpeg logs to stderr even on a clean run; nothing here is actionable
        proc.on('exit', code => this.console.log(`intercom: ffmpeg exited (code ${code})`));

        // Bound the queue by LATENCY, not by memory: see QUEUE_TARGET_* above.
        //
        // Trimming is deliberately CONDITIONAL. Discarding audio mid-sound is audible -- each
        // drop is a discontinuity, and a run of them was reported as "two tones overlaid" and
        // then as "a slight repeating rattle" while tuning the target. So catch-up happens where
        // it cannot be heard: only the oldest chunk is dropped, only when that chunk is quiet
        // (a pause between words, which a real conversation supplies constantly). A caller who
        // never pauses keeps their latency instead of hearing damage -- the right trade, since
        // the delay is recovered at the next breath.
        //
        // A hard ceiling still exists so a pathological source cannot grow the delay without
        // bound; past it, audio is dropped regardless of level.
        const { leadMs } = this.timing(host);
        const bytesPerMs = format.sampleRate * 2 / 1000;
        const maxQueued = Math.ceil(Math.max(QUEUE_TARGET_FLOOR_MS, leadMs + QUEUE_TARGET_SLACK_MS) * bytesPerMs);
        const hardCeiling = Math.ceil(QUEUE_HARD_CEILING_MS * bytesPerMs);
        this.droppedBytes = 0;
        this.peakQueuedBytes = 0;
        this.ageSumMs = 0;
        this.ageSamples = 0;
        this.peakAgeMs = 0;
        proc.stdout?.on('data', (chunk: Buffer) => {
            const at = Date.now();
            if (!firstByteLogged) {
                firstByteLogged = true;
                this.console.log(`intercom: startup -- driver create ${tDriverCreated - tStart} ms, `
                    + `driver open ${tDriverOpen - tDriverCreated} ms, ffmpeg spawn to first audio `
                    + `${Date.now() - tSpawn} ms (total ${Date.now() - tStart} ms before any real `
                    + 'audio could be sent)');
            }
            this.queue.push({ chunk, at });
            this.queuedBytes += chunk.length;
            if (this.queuedBytes > this.peakQueuedBytes)
                this.peakQueuedBytes = this.queuedBytes;
            while (this.queuedBytes > maxQueued && this.queue.length > 1) {
                const head = this.queue[0].chunk;
                if (this.queuedBytes <= hardCeiling && !isQuiet(head))
                    break; // audible: carry the latency rather than punch a hole in speech
                this.queue.shift();
                this.queuedBytes -= head.length;
                this.droppedBytes += head.length;
            }
        });
        this.console.log(`intercom: queue capped at ${(maxQueued / bytesPerMs).toFixed(0)} ms `
            + `(lead ${leadMs} ms), so latency cannot accumulate beyond that`);

        this.pump = this.pumpAudio(driver, host);
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
     *    hole, and the session opens on the warm-up of silence: a device drops audio while its
     *    speaker path comes up, and silence is what should land in that window. Sending real audio
     *    into it was heard on the Reolink as "beep, gap, steady tone".
     *
     * 2. Pacing holds the EXACT frame period on average, and only resyncs after a gross gap
     *    (RESYNC_THRESHOLD_MS). Ordinary lateness is caught up by sending the next frame
     *    immediately. Resetting the clock on every small delay instead makes the period
     *    "frameMs + processing time", so the sink runs slower than real time and the backlog
     *    grows for the whole session -- audibly, as sound that starts fine then degrades. An
     *    UNDERRUN is the one case with nothing to catch up to, and silence is sent for it.
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
    private async pumpAudio(driver: IntercomDriver, host: string): Promise<void> {
        const { sampleRate, pcmFrameBytes, prebufferMs } = driver.format;
        const frameMs = (pcmFrameBytes / 2 / sampleRate) * 1000;
        const silence = Buffer.alloc(pcmFrameBytes);
        const { warmupMs, leadMs } = this.timing(host);
        const leadBytes = Math.max(pcmFrameBytes, Math.ceil(leadMs / frameMs) * pcmFrameBytes);

        // Unpaced prebuffer: silence written as fast as the socket takes it, so the device's own
        // player starts with slack instead of running on the edge of underrun. It doubles as the
        // warm-up for such a device, hence the deduction below rather than padding twice.
        const prebufferFrames = Math.ceil((prebufferMs ?? 0) / frameMs);
        for (let i = 0; i < prebufferFrames && !this.stopping; i++)
            await driver.write(silence);
        if (prebufferFrames)
            this.console.log(`intercom: prebuffered ${(prebufferFrames * frameMs).toFixed(0)} ms of silence unpaced`);

        let warmupFrames = Math.max(0, Math.round(warmupMs / frameMs) - prebufferFrames);
        let primed = false;
        let filled = 0;
        let stalls = 0;
        let nextDue = Date.now();

        while (!this.stopping) {
            let frame: Buffer<ArrayBufferLike> = silence;
            if (warmupFrames > 0) {
                warmupFrames--;
                // Stay CURRENT through the warm-up instead of letting audio queue up behind the
                // silence. The device is dropping whatever arrives in this window anyway, so
                // queueing it only buys latency that persists for the rest of the session: it was
                // measured as ~780 ms of added delay with ~600 ms of caller audio discarded a
                // moment later to hold the latency cap. Discarding it here costs the same audio
                // and none of the delay.
                this.take(Math.min(this.queuedBytes, pcmFrameBytes));
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
                // Priming is the one moment when trimming is free: nothing has been sent yet, so
                // dropping the excess cannot produce a discontinuity -- it only chooses where the
                // stream starts. ffmpeg's startup delivers a lump (measured ~700 ms) and without
                // this the session carries it as delay for as long as the caller keeps talking.
                if (this.queuedBytes >= leadBytes) {
                    if (this.queuedBytes > leadBytes)
                        this.take(this.queuedBytes - leadBytes);
                    primed = true;
                }
                filled++;
            }

            await driver.write(frame);

            // Hold the EXACT frame period on average. Small lateness (a slow socket write, a
            // late timer) must NOT reset the schedule: doing so makes the period
            // "frameMs + processing time", so the sink runs permanently slower than real time,
            // the backlog grows for the whole session, and the device is fed slower than it
            // plays. Measured that way: a 6 s tone ended with a 704 ms backlog, heard as audio
            // that started loud, went quiet, then garbled.
            //
            // Only a gross gap resyncs -- a suspended process or a device that blocked for
            // longer than any catch-up could sensibly cover.
            nextDue += frameMs;
            const slack = nextDue - Date.now();
            if (slack > 0) {
                const paced = Promise.withResolvers<void>();
                setTimeout(paced.resolve, slack);
                await paced.promise;
            } else if (slack < -RESYNC_THRESHOLD_MS) {
                nextDue = Date.now();
            }
        }
        const bytesPerMs = sampleRate * 2 / 1000;
        const summary = `${driver.name} @ ${host}: ${(filled * frameMs).toFixed(0)} ms silence `
            + `(${stalls} stall(s)), queue peak ${(this.peakQueuedBytes / bytesPerMs).toFixed(0)} ms, `
            + `${(this.droppedBytes / bytesPerMs).toFixed(0)} ms dropped, lead ${leadMs} ms, `
            + `frames ${frameMs.toFixed(0)} ms, OUR LATENCY avg `
            + `${this.ageSamples ? (this.ageSumMs / this.ageSamples).toFixed(0) : '0'} ms / peak `
            + `${this.peakAgeMs} ms`;
        this.console.log(`intercom: session ended -- ${summary}`);
        this.report(summary);
    }

    /** Pulls `bytes` off the queue, recording how stale the oldest of it was.
     *
     * That staleness is this pipeline's own contribution to mouth-to-speaker delay: the gap
     * between ffmpeg handing us audio and this process putting it on the wire. Everything else in
     * the chain (the caller's device and network, ffmpeg's internal buffering, the device's own
     * playback buffer) is outside it, so separating them requires measuring this part directly --
     * a microphone cannot, because these devices echo-cancel adaptively. */
    private take(bytes: number): Buffer {
        const parts: Buffer[] = [];
        let need = bytes;
        if (this.queue.length) {
            const age = Date.now() - this.queue[0].at;
            this.ageSumMs += age;
            this.ageSamples++;
            if (age > this.peakAgeMs)
                this.peakAgeMs = age;
        }
        while (need > 0) {
            const head = this.queue[0];
            if (head.chunk.length <= need) {
                parts.push(head.chunk);
                this.queue.shift();
                need -= head.chunk.length;
            } else {
                parts.push(head.chunk.subarray(0, need));
                this.queue[0] = { chunk: head.chunk.subarray(need), at: head.at };
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

/** Whether a PCM chunk is quiet enough that dropping it cannot be heard.
 *
 * Used to make queue catch-up inaudible: the delay is recovered during the pauses a conversation
 * naturally contains, instead of by cutting holes in speech. Sampled rather than fully summed --
 * every fourth sample is plenty to distinguish a pause from a voice, and this runs on every
 * chunk that arrives. */
function isQuiet(pcm: Buffer): boolean {
    const samples = Math.floor(pcm.length / 2);
    if (!samples)
        return true;
    let sum = 0;
    let counted = 0;
    for (let i = 0; i < samples; i += 4) {
        const v = pcm.readInt16LE(i * 2);
        sum += v * v;
        counted++;
    }
    return Math.sqrt(sum / counted) < QUIET_RMS;
}

export type { DriverConfig };

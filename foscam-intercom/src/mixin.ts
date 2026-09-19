// The mixin device: attaches to a Foscam camera that Scrypted already streams over RTSP (the
// plain `@scrypted/rtsp` plugin, or any other provider) and adds the two things that stream
// cannot carry:
//
//   * `Intercom` -- two-way audio, over Foscam's proprietary low-level talk protocol on the
//     camera's media port (see foscamTalk.ts for the wire format and how it was established).
//     This is the only audio-in path the firmware has: its ONVIF service answers
//     `ter:AudioOutputNotSupported`, and its LIVE555 RTSP server offers no backchannel track.
//   * `PanTiltZoom` -- pan/tilt over the documented CGI API (see foscamCgi.ts). The camera has
//     no absolute positioning, only continuous moves plus named presets, so relative moves are
//     synthesised as a timed continuous move.

import type {
    FFmpegInput, Intercom, MediaObject, MixinDeviceOptions,
    PanTiltZoom, PanTiltZoomCommand, VideoCamera,
} from '@scrypted/sdk';
import { MixinDeviceBase, PanTiltZoomMovement, ScryptedMimeTypes } from '@scrypted/sdk';
import * as child_process from 'child_process';
import { FoscamCgiClient, PtzDirection } from './foscamCgi';
import { FoscamTalkClient, SAMPLE_RATE } from './foscamTalk';
import { sdk } from './sdkFix';
import { FoscamConfig } from './types';

/** A relative move of magnitude 1.0 becomes this many milliseconds of continuous movement. */
const RELATIVE_MOVE_FULL_SCALE_MS = 1000;
const RELATIVE_MOVE_MIN_MS = 120;
/** A continuous move with no explicit timeout is stopped by the client sending a zero vector.
 * If that never arrives (client crash, dropped websocket) this stops the gimbal anyway. */
const CONTINUOUS_MOVE_WATCHDOG_MS = 5000;

export class FoscamMixin extends MixinDeviceBase<VideoCamera> implements Intercom, PanTiltZoom {
    private talk?: FoscamTalkClient;
    private ffmpeg?: child_process.ChildProcess;
    private moveStopTimer?: NodeJS.Timeout;
    private appliedSpeed?: number;

    constructor(options: MixinDeviceOptions<VideoCamera>, private getConfig: () => FoscamConfig) {
        super(options);
        this.ptzCapabilities = { pan: true, tilt: true, zoom: false };
        this.refreshPresets().catch(e => this.console.warn('foscam: could not read preset list:', e.message));
    }

    // ---- Intercom ----

    async startIntercom(media: MediaObject): Promise<void> {
        await this.stopIntercom();
        const config = this.getConfig();
        const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);

        const talk = new FoscamTalkClient({ ...config, console: this.console });
        await talk.connect();
        await talk.login();
        await talk.startTalk();
        this.talk = talk;
        this.console.log(`foscam: talk session open on ${config.host}:${talk.port} (speaker accepted)`);

        const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
        const inputArgs = ffmpegInput.inputArguments?.length ? ffmpegInput.inputArguments : ['-i', ffmpegInput.url!];
        // The camera plays raw 8 kHz mono s16le and nothing else; whatever the caller speaks
        // (HomeKit Opus/AAC-ELD, WebRTC Opus, a browser's mic) is transcoded down to that here.
        const args = [
            '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
            ...inputArgs,
            '-vn', '-acodec', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '1',
            '-f', 's16le', '-flush_packets', '1', 'pipe:1',
        ];
        this.console.log(`foscam: intercom ffmpeg: ${ffmpegPath} ${args.join(' ')}`);
        const proc = child_process.spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.ffmpeg = proc;
        proc.stderr?.resume(); // ffmpeg always logs to stderr; nothing here is actionable.
        proc.on('exit', code => this.console.log(`foscam: intercom ffmpeg exited (code ${code})`));
        proc.stdout?.on('data', (chunk: Buffer) => talk.write(chunk));
    }

    async stopIntercom(): Promise<void> {
        this.ffmpeg?.kill('SIGTERM');
        this.ffmpeg = undefined;
        const talk = this.talk;
        this.talk = undefined;
        if (!talk)
            return;
        this.console.log(`foscam: talk session closing (${talk.stats.framesSent} frames, ${talk.stats.bytesSent} bytes sent, ${talk.stats.bytesDropped} dropped)`);
        await talk.stopTalk().catch(e => this.console.warn('foscam: stopTalk failed:', e.message));
        talk.close();
    }

    // ---- PanTiltZoom ----

    async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
        const cgi = new FoscamCgiClient(this.getConfig());
        clearTimeout(this.moveStopTimer);
        this.moveStopTimer = undefined;

        if (command.movement === PanTiltZoomMovement.Preset) {
            if (!command.preset)
                throw new Error('foscam: preset movement with no preset name');
            await cgi.gotoPreset(command.preset);
            return;
        }
        if (command.movement === PanTiltZoomMovement.Home) {
            await cgi.recentre();
            return;
        }

        const pan = command.pan ?? 0;
        const tilt = command.tilt ?? 0;
        if (!pan && !tilt) {
            // Every client's "stop dragging" is a zero vector.
            await cgi.stop();
            return;
        }
        if (command.movement === PanTiltZoomMovement.Absolute)
            this.console.warn('foscam: camera has no absolute positioning; treating this as a relative move');

        const speed = command.speed?.pan ?? command.speed?.tilt;
        if (speed !== undefined) {
            // Scrypted: 0..1, fast at 1. Foscam: 0..4, fast at 0.
            const foscamSpeed = Math.round(4 * (1 - Math.max(0, Math.min(1, speed))));
            if (foscamSpeed !== this.appliedSpeed) {
                await cgi.setSpeed(foscamSpeed);
                this.appliedSpeed = foscamSpeed;
            }
        }

        const vertical = tilt > 0 ? 'Top' : tilt < 0 ? 'Bottom' : '';
        const horizontal = pan > 0 ? 'Right' : pan < 0 ? 'Left' : '';
        const direction = (vertical && horizontal
            ? `${vertical}${horizontal}`
            : vertical ? (tilt > 0 ? 'Up' : 'Down') : horizontal) as PtzDirection;
        await cgi.move(direction);

        if (command.movement === PanTiltZoomMovement.Continuous) {
            const timeout = command.timeout ?? CONTINUOUS_MOVE_WATCHDOG_MS;
            this.moveStopTimer = setTimeout(() => void this.stopQuietly(), timeout);
            return;
        }
        const magnitude = Math.min(1, Math.max(Math.abs(pan), Math.abs(tilt)));
        const durationMs = command.timeout
            ?? Math.max(RELATIVE_MOVE_MIN_MS, magnitude * RELATIVE_MOVE_FULL_SCALE_MS);
        const { promise: elapsed, resolve: onElapsed } = Promise.withResolvers<void>();
        setTimeout(onElapsed, durationMs);
        await elapsed;
        await cgi.stop();
    }

    override release(): void {
        clearTimeout(this.moveStopTimer);
        this.moveStopTimer = undefined;
        this.stopIntercom().catch(e => this.console.warn('foscam: stopIntercom during release failed:', e.message));
        super.release();
    }

    private async stopQuietly(): Promise<void> {
        try {
            await new FoscamCgiClient(this.getConfig()).stop();
        } catch (e) {
            this.console.warn('foscam: watchdog stop failed:', (e as Error).message);
        }
    }

    private async refreshPresets(): Promise<void> {
        const names = await new FoscamCgiClient(this.getConfig()).listPresets();
        if (!names.length)
            return;
        this.ptzCapabilities = {
            pan: true,
            tilt: true,
            zoom: false,
            presets: Object.fromEntries(names.map(name => [name, name])),
        };
    }
}

// Foscam: proprietary "low level" protocol on the media port, plus pan/tilt over the CGI API.
//
// Why proprietary at all: the R2C has no standards-based audio-in whatsoever. ONVIF answers
// AudioOutputNotSupported, its RTSP server is a LIVE555 build from 2014 with no backchannel and
// no ANNOUNCE, and the CGI API has no talk command. See protocols/foscamTalk.ts for the wire
// format and the two corrections to the published notes that make it work.

import type { PanTiltZoomCapabilities, PanTiltZoomCommand } from '@scrypted/sdk';
import { PanTiltZoomMovement } from '@scrypted/sdk';
import { FoscamCgiClient, PtzDirection } from '../protocols/foscamCgi';
import { FoscamTalkClient, SAMPLE_RATE, TALK_FRAME_BYTES } from '../protocols/foscamTalk';
import { DriverConfig, IntercomDriver, PtzCapableDriver, TalkFormat } from './driver';

/** A relative move of magnitude 1.0 becomes this many milliseconds of continuous movement. */
const RELATIVE_MOVE_FULL_SCALE_MS = 1000;
const RELATIVE_MOVE_MIN_MS = 120;
/** A continuous move is normally stopped by the client's zero vector; if that never arrives
 * (client crash, dropped socket) this stops the gimbal anyway. */
const CONTINUOUS_MOVE_WATCHDOG_MS = 5000;

export class FoscamDriver implements IntercomDriver, PtzCapableDriver {
    readonly name = 'foscam' as const;
    /** The R2C records its own speaker happily, so an acoustic self-test is conclusive here. */
    readonly echoCancels = false;
    readonly notes: string[] = [];
    readonly format: TalkFormat = { sampleRate: SAMPLE_RATE, pcmFrameBytes: TALK_FRAME_BYTES };

    private talk?: FoscamTalkClient;
    private moveStopTimer?: NodeJS.Timeout;
    private appliedSpeed?: number;

    constructor(private config: DriverConfig) { }

    async open(): Promise<void> {
        const talk = new FoscamTalkClient({
            host: this.config.host,
            username: this.config.username,
            password: this.config.password,
            console: this.config.console,
        });
        await talk.connect();
        await talk.login();
        await talk.startTalk();
        this.talk = talk;
        this.notes.push(`speaker accepted on the media port (${this.config.host}:${talk.port})`);
    }

    async write(pcm: Buffer): Promise<void> {
        this.talk?.write(pcm);
    }

    async close(): Promise<void> {
        clearTimeout(this.moveStopTimer);
        this.moveStopTimer = undefined;
        const talk = this.talk;
        this.talk = undefined;
        if (!talk)
            return;
        await talk.stopTalk().catch(e => this.config.console.warn('foscam: stopTalk failed:', e.message));
        talk.close();
    }

    // ---- pan/tilt ----

    async ptzCapabilities(): Promise<PanTiltZoomCapabilities> {
        const capabilities: PanTiltZoomCapabilities = { pan: true, tilt: true, zoom: false };
        const names = await new FoscamCgiClient(this.cgiOptions()).listPresets()
            .catch(() => [] as string[]);
        if (names.length)
            capabilities.presets = Object.fromEntries(names.map(name => [name, name]));
        return capabilities;
    }

    /** The camera has no absolute positioning, only continuous moves plus named presets, so a
     * relative move is synthesised as a timed continuous move. */
    async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
        const cgi = new FoscamCgiClient(this.cgiOptions());
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
            await cgi.stop(); // every client's "stop dragging" is a zero vector
            return;
        }
        if (command.movement === PanTiltZoomMovement.Absolute)
            this.config.console.warn('foscam: no absolute positioning; treating this as relative');

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
            this.moveStopTimer = setTimeout(() => void this.stopQuietly(), command.timeout ?? CONTINUOUS_MOVE_WATCHDOG_MS);
            return;
        }
        const magnitude = Math.min(1, Math.max(Math.abs(pan), Math.abs(tilt)));
        const durationMs = command.timeout ?? Math.max(RELATIVE_MOVE_MIN_MS, magnitude * RELATIVE_MOVE_FULL_SCALE_MS);
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, durationMs);
        await promise;
        await cgi.stop();
    }

    private cgiOptions() {
        return {
            host: this.config.host,
            username: this.config.username,
            password: this.config.password,
        };
    }

    private async stopQuietly(): Promise<void> {
        try {
            await new FoscamCgiClient(this.cgiOptions()).stop();
        } catch (e) {
            this.config.console.warn('foscam: watchdog stop failed:', (e as Error).message);
        }
    }
}

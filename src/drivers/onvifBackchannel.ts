// ONVIF-style RTSP backchannel: the standards-based driver, and the only one that is not a
// vendor workaround.
//
// A camera supports this when DESCRIBE with `Require: www.onvif.org/ver20/backchannel` returns an
// extra SDP section marked `a=sendonly` — a track the client can SETUP and push RTP into. It is
// entirely a SERVER-side capability: if the camera does not offer that section there is nothing
// to set up, which is why the Foscam, Reolink and Tapo cameras here need their own drivers (all
// three return SDP byte-identical to a plain DESCRIBE).
//
// Known to work with: the Kibble feeder (whose RTSP server implements it deliberately), and
// per Scrypted's own camera support notes, Amcrest/Dahua, Hikvision and Reolink doorbells.

import { RtspBackchannelClient } from '../protocols/rtspBackchannel';
import { DriverConfig, IntercomDriver, TalkFormat } from './driver';

/** L16/16000 mono: 320 samples is 20 ms, and 2 bytes per sample. Wideband end to end — no G.711
 * companding or 8 kHz band-limit between the caller's Opus and the device. */
const L16_RATE = 16000;
const L16_FRAME_BYTES = 640;
/** Silence written flat out before pacing starts, to fill the far end's jitter buffer at once.
 *
 * Unlike the vendor cameras -- which discard anything faster than real time, making a prebuffer
 * pointless -- a backchannel server generally queues what it receives.
 *
 * This was 400 ms while the feeder's firmware had no jitter buffer of its own: it wrote decoded
 * PCM straight into ALSA, so this process's scheduling jitter surfaced as underruns and audible
 * choppiness. That was the wrong layer to fix it at, and it is now fixed properly in
 * `librefeed-media` (a 120 ms preroll plus silence concealment, so every backchannel client
 * benefits, not just this one). What remains here is small and has a different job: filling the
 * device's preroll immediately rather than making it wait 120 ms of real time for the paced
 * stream to supply it. */
const PREBUFFER_MS = 120;

export class OnvifBackchannelDriver implements IntercomDriver {
    readonly name = 'onvif-backchannel' as const;
    /** A device implementing the standard streams its mic and the backchannel in one session, so
     * it generally does record its own speaker; the self-test can be trusted. */
    readonly echoCancels = false;
    readonly notes: string[] = [];
    readonly format: TalkFormat = { sampleRate: L16_RATE, pcmFrameBytes: L16_FRAME_BYTES, prebufferMs: PREBUFFER_MS };

    private client?: RtspBackchannelClient;
    private pending = Buffer.alloc(0);

    constructor(private config: DriverConfig) { }

    async open(): Promise<void> {
        const port = this.config.rtspPort ?? 554;
        const path = this.config.rtspPath ?? 'sub';
        const client = new RtspBackchannelClient(this.config.host, port, path, this.config.console);
        await client.connect();
        const { offered } = await client.describeWithBackchannel();
        if (!offered) {
            client.close();
            throw new Error(`onvif-backchannel: ${this.config.host}:${port}/${path} offers no `
                + 'sendonly audio section, so it has no backchannel to push into');
        }
        const setup = await client.setupBackchannel('tcp');
        if (setup.code !== 200) {
            client.close();
            throw new Error(`onvif-backchannel: SETUP failed: ${setup.code} ${setup.reason}`);
        }
        const play = await client.play();
        if (play.code !== 200) {
            client.close();
            throw new Error(`onvif-backchannel: PLAY failed: ${play.code} ${play.reason}`);
        }
        this.client = client;
        this.pending = Buffer.alloc(0);
        this.notes.push(`backchannel negotiated over RTP/AVP/TCP interleaved, L16/${L16_RATE}`);
    }

    async write(pcm: Buffer): Promise<void> {
        const client = this.client;
        if (!client)
            return;
        // L16 is big-endian on the wire; ffmpeg hands us little-endian.
        this.pending = Buffer.concat([this.pending, pcm]);
        while (this.pending.length >= L16_FRAME_BYTES) {
            const frame = Buffer.from(this.pending.subarray(0, L16_FRAME_BYTES));
            frame.swap16();
            client.sendL16Frame(frame);
            this.pending = this.pending.subarray(L16_FRAME_BYTES);
        }
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = undefined;
        if (!client)
            return;
        await client.teardown().catch(e => this.config.console.warn('onvif-backchannel: teardown failed:', e.message));
        client.close();
    }
}

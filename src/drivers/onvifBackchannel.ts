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

import { BackchannelOffer, RtspBackchannelClient } from '../protocols/rtspBackchannel';
import { linearToAlaw, linearToUlaw } from '../protocols/g711';
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
/** How long a finished session is held open streaming silence, unless overridden. Long enough to
 * cover the gaps in a real conversation, short enough that an abandoned session does not keep the
 * camera's speaker path (and this RTSP session's video) running indefinitely. */
export const DEFAULT_KEEP_ALIVE_MS = 20_000;
/** The cadence the device expects: one 20 ms frame every 20 ms, exactly as during real speech. */
const KEEP_ALIVE_FRAME_MS = 20;

/** A session that has been closed by its caller but is deliberately still running, with silence
 * on the wire. Keyed by device so the next `open()` for the same camera adopts it. */
interface LingeringSession {
    client: RtspBackchannelClient;
    offer: BackchannelOffer;
    format: TalkFormat;
    pump: ReturnType<typeof setInterval>;
    expiry: ReturnType<typeof setTimeout>;
}

export class OnvifBackchannelDriver implements IntercomDriver {
    readonly name = 'onvif-backchannel' as const;
    /** A device implementing the standard streams its mic and the backchannel in one session, so
     * it generally does record its own speaker; the self-test can be trusted. */
    readonly echoCancels = false;
    readonly notes: string[] = [];
    /** Filled in by `open()` from the device's own SDP: the rate is whatever it offered, so this
     * is not final until the session exists. The mixin reads `format` after `open()`. */
    format: TalkFormat = { sampleRate: L16_RATE, pcmFrameBytes: L16_FRAME_BYTES, prebufferMs: PREBUFFER_MS };

    private client?: RtspBackchannelClient;
    private offer?: BackchannelOffer;
    private pending = Buffer.alloc(0);
    /** Shared across driver instances on purpose: the mixin builds a NEW driver for every talk
     * session, so a per-instance field could never span the gap between two utterances. */
    private static readonly lingering = new Map<string, LingeringSession>();

    constructor(private config: DriverConfig) { }

    private get deviceKey(): string {
        return `${this.config.host}:${this.config.rtspPort ?? 554}/${this.config.rtspPath ?? 'sub'}`;
    }

    async open(): Promise<void> {
        const port = this.config.rtspPort ?? 554;
        const path = this.config.rtspPath ?? 'sub';

        // Adopt a session still lingering from the previous utterance. This skips DESCRIBE, SETUP
        // and PLAY entirely, and -- the point of the whole exercise -- the device's speaker path
        // has never stopped, so the first word is not eaten.
        const parked = OnvifBackchannelDriver.lingering.get(this.deviceKey);
        if (parked) {
            OnvifBackchannelDriver.lingering.delete(this.deviceKey);
            clearInterval(parked.pump);
            clearTimeout(parked.expiry);
            this.client = parked.client;
            this.offer = parked.offer;
            this.pending = Buffer.alloc(0);
            this.format = parked.format;
            this.notes.push('adopted a still-live backchannel session: no RTSP setup, and the '
                + "device's speaker path never idled");
            return;
        }

        const client = new RtspBackchannelClient(this.config.host, port, path, this.config.console,
            this.config.username, this.config.password);
        await client.connect();
        const { offered, offer } = await client.describeWithBackchannel();
        if (!offered || !offer) {
            client.close();
            throw new Error(`onvif-backchannel: ${this.config.host}:${port}/${path} offers no `
                + 'sendonly audio section in a codec this driver can produce, so there is no '
                + 'backchannel to push into');
        }
        const setup = await client.setupBackchannel('tcp', offer.control);
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
        this.offer = offer;
        this.pending = Buffer.alloc(0);
        // 20 ms frames at the device's own clock: short enough to keep latency low, long enough
        // that the per-frame RTP overhead stays irrelevant.
        const samplesPerFrame = Math.round(offer.clock / 50);
        this.format = {
            sampleRate: offer.clock,
            pcmFrameBytes: samplesPerFrame * 2,
            prebufferMs: PREBUFFER_MS,
        };
        this.notes.push(`backchannel negotiated over RTP/AVP/TCP interleaved, `
            + `${offer.codec}/${offer.clock} (payload type ${offer.payloadType}) at ${offer.control}`);
    }

    async write(pcm: Buffer): Promise<void> {
        const client = this.client;
        const offer = this.offer;
        if (!client || !offer)
            return;
        const frameBytes = this.format.pcmFrameBytes;
        this.pending = Buffer.concat([this.pending, pcm]);
        while (this.pending.length >= frameBytes) {
            const pcmFrame = Buffer.from(this.pending.subarray(0, frameBytes));
            this.pending = this.pending.subarray(frameBytes);
            let payload: Buffer;
            if (offer.codec === 'L16') {
                pcmFrame.swap16(); // L16 is big-endian on the wire; ffmpeg hands us little-endian
                payload = pcmFrame;
            } else {
                payload = offer.codec === 'PCMU' ? linearToUlaw(pcmFrame) : linearToAlaw(pcmFrame);
            }
            client.sendOfferedFrame(offer, payload);
        }
    }

    async close(): Promise<void> {
        const client = this.client;
        const offer = this.offer;
        this.client = undefined;
        this.offer = undefined;
        if (!client)
            return;

        const keepAliveMs = this.config.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
        if (!offer || keepAliveMs <= 0) {
            await this.teardown(client);
            return;
        }

        // Park it: keep writing silence on the same cadence real speech used. A device that is
        // still being fed never re-initialises, so the next utterance starts instantly.
        const silence = this.silenceFrame(offer);
        const key = this.deviceKey;
        const pump = setInterval(() => {
            try {
                client.sendOfferedFrame(offer, silence);
            } catch (e) {
                // The socket died while parked; drop the entry rather than pump into nothing.
                clearInterval(pump);
                OnvifBackchannelDriver.lingering.delete(key);
                client.close();
            }
        }, KEEP_ALIVE_FRAME_MS);
        const expiry = setTimeout(() => {
            clearInterval(pump);
            if (OnvifBackchannelDriver.lingering.get(key)?.client === client)
                OnvifBackchannelDriver.lingering.delete(key);
            void this.teardown(client);
        }, keepAliveMs);
        // Neither timer should hold the process open.
        pump.unref?.();
        expiry.unref?.();
        OnvifBackchannelDriver.lingering.set(key, { client, offer, format: this.format, pump, expiry });
        this.config.console.log(`onvif-backchannel: holding ${key} open with silence for `
            + `${keepAliveMs} ms so the next utterance keeps the speaker path warm`);
    }

    /** One frame of digital silence in the negotiated codec: G.711's encoding of zero is not zero
     * (0xff for mu-law, 0xd5 for A-law), so a zero-filled buffer would be full-scale noise. */
    private silenceFrame(offer: BackchannelOffer): Buffer {
        const pcm = Buffer.alloc(Math.round(offer.clock / 50) * 2);
        if (offer.codec === 'L16')
            return pcm;
        // G.711's encoding of zero is not a zero byte (0xff mu-law, 0xd5 A-law), so the companded
        // form has to be produced rather than assumed -- a zero-filled payload is full-scale noise.
        return offer.codec === 'PCMU' ? linearToUlaw(pcm) : linearToAlaw(pcm);
    }

    private async teardown(client: RtspBackchannelClient): Promise<void> {
        await client.teardown().catch(e => this.config.console.warn('onvif-backchannel: teardown failed:', e.message));
        client.close();
    }
}

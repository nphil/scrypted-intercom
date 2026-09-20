// A small, from-scratch RTSP/1.0 + RTP-over-TCP-interleaved client for exactly the ONVIF-style
// backchannel `agent/src/rtsp.rs` implements (see that module's doc comment and
// `docs/23-audio-codec.md` §7.2/§14): DESCRIBE with `Require: www.onvif.org/ver20/backchannel`
// offers a fourth SDP section (`m=audio 0 RTP/AVP 98 0 8`, L16/16000 + G.711, `a=sendonly`, `trackID=2`); SETUP for
// trackID=2 accepts only `RTP/AVP/TCP;unicast;interleaved=4-5` (a UDP transport request gets a
// clean `461 Unsupported Transport`, by design, so a generic ONVIF/Scrypted client's documented
// UDP-then-TCP fallback fires); PLAY starts the whole session (video + mic-audio + backchannel
// together -- the device's RTSP server has no way to PLAY a single track in isolation).
//
// This does not reuse Scrypted's own `@scrypted/common/src/rtsp-server.ts` `RtspClient` (that
// lives inside the Scrypted monorepo and is not what the published `@scrypted/common` npm
// package exposes) or the real ONVIF plugin's `werift`-based RTP forwarder (monorepo-relative
// imports, not resolvable from a standalone plugin). The protocol this one device speaks is small
// and fully pinned by `agent/src/rtsp.rs`, so a self-contained ~200 line client is more auditable
// than pulling in a general-purpose RTP/WebRTC dependency for one 12-byte header.

import * as net from 'net';

const ONVIF_BACKCHANNEL = 'www.onvif.org/ver20/backchannel';
/** Matches `agent/src/rtsp.rs`'s `BACKCHANNEL_TRACK`/`BACKCHANNEL_RTP_CHANNEL`/etc. exactly. */
const BACKCHANNEL_TRACK = 2;
const BACKCHANNEL_RTP_CHANNEL = 4;
const VIDEO_RTP_CHANNEL = 0;
const AUDIO_RTP_CHANNEL = 2;
/** RTP static payload type for PCMU (G.711 mu-law) -- `backchannel.rs`'s `PT_PCMU`. */
const PCMU_PAYLOAD_TYPE = 0;
/** Dynamic payload type the feeder's SDP maps to `L16/16000` -- `backchannel.rs`'s `PT_L16_16K`. */
const L16_PAYLOAD_TYPE = 98;
const MAX_HEADER_BYTES = 16 * 1024;

/** What a device's SDP says its backchannel accepts: the codec to encode, the clock to encode at,
 * the RTP payload type to stamp, and the control URL to SETUP. */
export interface BackchannelOffer {
    codec: 'L16' | 'PCMU' | 'PCMA';
    clock: number;
    payloadType: number;
    control: string;
}

export interface RtspResponse {
    code: number;
    reason: string;
    headers: Record<string, string>;
    body: string;
}

/** Wire-level counters a caller can read back as evidence that PLAY produced a genuinely live,
 * full-duplex session -- receiving real video/audio frames is only possible if the device's own
 * ring poller is actively feeding this exact TCP connection. */
export interface BackchannelStats {
    videoFramesReceived: number;
    micFramesReceived: number;
    audioFramesSent: number;
}

export class RtspBackchannelClient {
    private socket?: net.Socket;
    private recv: Buffer = Buffer.alloc(0);
    private pending?: { resolve: (r: RtspResponse) => void; reject: (e: Error) => void };
    private cseq = 1;
    private session?: string;
    private seq = Math.floor(Math.random() * 0x10000);
    private ssrc = 0x4b424c49; // "KBLI" -- arbitrary but fixed for this client's lifetime.
    private rtpTimestamp = 0;
    private videoFramesReceived = 0;
    private micFramesReceived = 0;
    private audioFramesSent = 0;

    constructor(private host: string, private port: number, private mountPath: string, private console: Console) { }

    private get baseUrl(): string {
        return `rtsp://${this.host}:${this.port}/${this.mountPath}`;
    }

    get stats(): BackchannelStats {
        return {
            videoFramesReceived: this.videoFramesReceived,
            micFramesReceived: this.micFramesReceived,
            audioFramesSent: this.audioFramesSent,
        };
    }

    async connect(): Promise<void> {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const socket = net.createConnection({ host: this.host, port: this.port });
        socket.once('connect', () => resolve());
        socket.once('error', reject);
        socket.on('data', chunk => this.onData(chunk));
        socket.on('close', () => {
            this.pending?.reject(new Error('rtsp: connection closed'));
            this.pending = undefined;
        });
        this.socket = socket;
        await promise;
    }

    async options(): Promise<RtspResponse> {
        return this.request('OPTIONS', this.baseUrl);
    }

    /** DESCRIBE with the ONVIF backchannel `Require` header, and negotiate what to send.
     *
     * The offer is READ, never assumed. The feeder offers `L16/16000` plus G.711 at `trackID=2`;
     * a Reolink doorbell offers `PCMU/8000` alone, at its own control URL. Sending L16 to that
     * doorbell would be noise, so the codec and the control URL both come from the device's own
     * SDP. `offered` is true only when a real `sendonly` audio section exists with a codec this
     * client can produce. */
    async describeWithBackchannel(): Promise<{ response: RtspResponse; offered: boolean; offer?: BackchannelOffer }> {
        const response = await this.request('DESCRIBE', this.baseUrl, {
            Require: ONVIF_BACKCHANNEL,
            Accept: 'application/sdp',
        });
        if (response.code !== 200)
            return { response, offered: false };
        const offer = parseBackchannelOffer(response.body, this.baseUrl);
        return { response, offered: !!offer, offer };
    }

    /** SETUP the negotiated backchannel track. `transport: 'udp'` is the self-test path proving a
     * device's documented UDP-then-TCP fallback: on the feeder it must come back `461`, never
     * `200`. `control` defaults to the feeder's `trackID=2` for callers that already know it. */
    async setupBackchannel(transport: 'tcp' | 'udp', control?: string): Promise<RtspResponse> {
        const transportHeader = transport === 'tcp'
            ? `RTP/AVP/TCP;unicast;interleaved=${BACKCHANNEL_RTP_CHANNEL}-${BACKCHANNEL_RTP_CHANNEL + 1}`
            : 'RTP/AVP;unicast;client_port=13000-13001';
        const url = control ?? `${this.baseUrl}/trackID=${BACKCHANNEL_TRACK}`;
        const response = await this.request('SETUP', url, {
            Require: ONVIF_BACKCHANNEL,
            Transport: transportHeader,
        });
        const session = response.headers['session'];
        if (response.code === 200 && session)
            this.session = session.split(';')[0];
        return response;
    }

    async play(): Promise<RtspResponse> {
        return this.request('PLAY', this.baseUrl, { Range: 'npt=0.000-' });
    }

    /** Waits `ms` while counting real incoming interleaved frames -- proof the session is live,
     * not just that PLAY returned 200. */
    async waitForActivity(ms: number): Promise<void> {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        await promise;
    }

    /** RTP-packetizes one 8kHz PCMU frame (12-byte header per RFC 3550, CC=0 so
     * `backchannel.rs`'s CSRC-aware `rtp_payload` parser sees a bare 12-byte header) and writes
     * it as an interleaved TCP frame on the backchannel's channel. */
    sendPcmuFrame(payload: Buffer): void {
        this.sendRtp(PCMU_PAYLOAD_TYPE, payload, payload.length); // 1 byte == 1 sample @ 8 kHz
    }

    /** Same, for one frame of L16/16000 (16-bit big-endian samples; the feeder's native rate). */
    sendL16Frame(payload: Buffer): void {
        this.sendRtp(L16_PAYLOAD_TYPE, payload, payload.length / 2);
    }

    /** One frame in whatever codec the device's own SDP offered. `samples` drives the RTP
     * timestamp, which is in clock units, so it is the sample count and not the byte count --
     * one byte per sample for G.711, two for L16. */
    sendOfferedFrame(offer: BackchannelOffer, payload: Buffer): void {
        this.sendRtp(offer.payloadType, payload, offer.codec === 'L16' ? payload.length / 2 : payload.length);
    }

    private sendRtp(payloadType: number, payload: Buffer, samples: number): void {
        if (!this.socket) throw new Error('rtsp: not connected');
        const header = Buffer.alloc(12);
        header[0] = 0x80; // V=2, P=0, X=0, CC=0
        header[1] = payloadType; // M=0
        header.writeUInt16BE(this.seq, 2);
        this.seq = (this.seq + 1) & 0xffff;
        header.writeUInt32BE(this.rtpTimestamp, 4);
        this.rtpTimestamp = (this.rtpTimestamp + samples) >>> 0;
        header.writeUInt32BE(this.ssrc, 8);
        this.writeInterleaved(BACKCHANNEL_RTP_CHANNEL, Buffer.concat([header, payload]));
        this.audioFramesSent++;
    }

    async teardown(): Promise<RtspResponse | undefined> {
        if (!this.session)
            return undefined;
        const response = await this.request('TEARDOWN', this.baseUrl);
        this.session = undefined;
        return response;
    }

    close(): void {
        this.socket?.destroy();
        this.socket = undefined;
    }

    private writeInterleaved(channel: number, data: Buffer): void {
        const frame = Buffer.alloc(4 + data.length);
        frame[0] = 0x24; // '$'
        frame[1] = channel;
        frame.writeUInt16BE(data.length, 2);
        data.copy(frame, 4);
        this.socket!.write(frame);
    }

    private request(method: string, url: string, extraHeaders: Record<string, string> = {}): Promise<RtspResponse> {
        if (!this.socket) throw new Error('rtsp: not connected');
        if (this.pending) throw new Error('rtsp: a request is already in flight on this connection');
        const { promise, resolve, reject } = Promise.withResolvers<RtspResponse>();
        this.pending = { resolve, reject };
        const headers = [`${method} ${url} RTSP/1.0`, `CSeq: ${this.cseq++}`];
        for (const [key, value] of Object.entries(extraHeaders))
            headers.push(`${key}: ${value}`);
        if (this.session)
            headers.push(`Session: ${this.session}`);
        const text = headers.join('\r\n') + '\r\n\r\n';
        this.console.log(`kibble intercom: -> ${method} ${url}`);
        this.socket.write(text, 'utf8');
        return promise.then(response => {
            this.console.log(`kibble intercom: <- ${response.code} ${response.reason}`);
            return response;
        });
    }

    /** Consumes as many complete frames (binary `$...` or textual RTSP responses) as `this.recv`
     * currently holds, leaving any trailing partial frame buffered for the next `data` event. */
    private onData(chunk: Buffer): void {
        this.recv = this.recv.length ? Buffer.concat([this.recv, chunk]) : chunk;
        for (; ;) {
            if (this.recv.length === 0)
                return;
            if (this.recv[0] === 0x24) { // '$' -- RFC 2326 §10.12 interleaved binary frame
                if (this.recv.length < 4)
                    return;
                const channel = this.recv[1];
                const length = this.recv.readUInt16BE(2);
                if (this.recv.length < 4 + length)
                    return;
                this.dispatchInterleavedFrame(channel);
                this.recv = this.recv.subarray(4 + length);
                continue;
            }
            const headerEnd = this.recv.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                if (this.recv.length > MAX_HEADER_BYTES)
                    throw new Error('rtsp: response headers exceeded sanity limit without a terminator');
                return;
            }
            const contentLength = this.readContentLength(headerEnd);
            const totalLength = headerEnd + 4 + contentLength;
            if (this.recv.length < totalLength)
                return;
            this.dispatchResponse(headerEnd, totalLength);
            this.recv = this.recv.subarray(totalLength);
        }
    }

    private dispatchInterleavedFrame(channel: number): void {
        if (channel === VIDEO_RTP_CHANNEL)
            this.videoFramesReceived++;
        else if (channel === AUDIO_RTP_CHANNEL)
            this.micFramesReceived++;
        // Anything else (the backchannel's own RTCP channel, 5) is drained and ignored: nothing
        // in this client's protocol needs it.
    }

    private readContentLength(headerEnd: number): number {
        const headText = this.recv.subarray(0, headerEnd).toString('utf8');
        const match = /^content-length:\s*(\d+)/im.exec(headText);
        return match ? parseInt(match[1], 10) : 0;
    }

    private dispatchResponse(headerEnd: number, totalLength: number): void {
        const headText = this.recv.subarray(0, headerEnd).toString('utf8');
        const body = this.recv.subarray(headerEnd + 4, totalLength).toString('utf8');
        const lines = headText.split('\r\n');
        const statusMatch = /^RTSP\/1\.0 (\d+) (.*)$/.exec(lines[0]);
        const pending = this.pending;
        this.pending = undefined;
        if (!statusMatch) {
            pending?.reject(new Error(`rtsp: unparseable status line: ${lines[0]}`));
            return;
        }
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
            const idx = line.indexOf(':');
            if (idx === -1)
                continue;
            headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
        pending?.resolve({ code: parseInt(statusMatch[1], 10), reason: statusMatch[2], headers, body });
    }
}

/** Picks the best codec out of the `sendonly` audio section of an SDP, or returns undefined when
 * there is no backchannel (or none this client can feed).
 *
 * Preference is by audio quality: L16 is uncompressed and usually 16 kHz, G.711 is companded and
 * 8 kHz. A-law and mu-law are equivalent in quality; mu-law is listed first only because it is
 * the payload type every ONVIF backchannel is required to support.
 *
 * Hand-rolled rather than pulled from a library for the same reason as the rest of this client:
 * the grammar needed here is three line types, and Scrypted's own SDP utilities are monorepo-only.
 */
export function parseBackchannelOffer(sdp: string, baseUrl: string): BackchannelOffer | undefined {
    // Split into m-sections, keeping the session-level preamble out of the way.
    const sections = sdp.split(/^m=/m).slice(1).map(s => 'm=' + s);
    for (const section of sections) {
        if (!section.startsWith('m=audio'))
            continue;
        if (!/^a=sendonly\s*$/m.test(section))
            continue;

        // `a=control:` may be absolute or relative; RFC 2326 resolves the relative form against
        // the request URL. Absent or `*` means the session URL itself.
        const controlMatch = section.match(/^a=control:(\S+)\s*$/m);
        const controlValue = controlMatch?.[1];
        let control = baseUrl;
        if (controlValue && controlValue !== '*') {
            control = controlValue.startsWith('rtsp://')
                ? controlValue
                : `${baseUrl}/${controlValue.replace(/^\//, '')}`;
        }

        // Static payload types 0 (PCMU) and 8 (PCMA) may appear on the m= line with no rtpmap.
        const formats = section.split('\n')[0].trim().split(/\s+/).slice(3);
        const rtpmaps = [...section.matchAll(/^a=rtpmap:(\d+)\s+([A-Za-z0-9-]+)\/(\d+)/gm)]
            .map(m => ({ payloadType: Number(m[1]), name: m[2].toUpperCase(), clock: Number(m[3]) }));

        const candidates: BackchannelOffer[] = [];
        for (const { payloadType, name, clock } of rtpmaps) {
            if (name === 'L16')
                candidates.push({ codec: 'L16', clock, payloadType, control });
            else if (name === 'PCMU')
                candidates.push({ codec: 'PCMU', clock, payloadType, control });
            else if (name === 'PCMA')
                candidates.push({ codec: 'PCMA', clock, payloadType, control });
        }
        for (const format of formats) {
            const payloadType = Number(format);
            if (candidates.some(c => c.payloadType === payloadType))
                continue;
            if (payloadType === 0)
                candidates.push({ codec: 'PCMU', clock: 8000, payloadType, control });
            else if (payloadType === 8)
                candidates.push({ codec: 'PCMA', clock: 8000, payloadType, control });
        }
        if (!candidates.length)
            continue;

        const rank = (c: BackchannelOffer) => (c.codec === 'L16' ? 0 : c.codec === 'PCMU' ? 1 : 2);
        candidates.sort((a, b) => rank(a) - rank(b) || b.clock - a.clock);
        return candidates[0];
    }
    return undefined;
}

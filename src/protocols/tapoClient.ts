// Tapo local talk protocol client: HTTP Digest on port 8800 /stream, then a long-lived
// bidirectional multipart stream carrying JSON requests and MPEG-TS audio.
//
// Everything here is spoken directly over a socket rather than through an HTTP client, because
// after the 200 the same connection stops being request/response and becomes a two-way multipart
// stream: the client keeps appending parts, and the camera interleaves its own parts back.
//
// THE REASON THIS PLUGIN EXISTS -- measured on three real cameras:
// the camera's own `encrypt_type` flag in the auth challenge cannot be trusted. All three
// advertise `encrypt_type="3"` (meaning "derive the digest password with SHA256"), but a C120 on
// firmware 1.4.3 accepts ONLY the MD5-derived secret and 401s on SHA256. The first-party plugin
// does `useSHA256 = wwwAuthenticate.includes('encrypt_type="3"')` and therefore can never
// authenticate against that camera. So: try what it advertises, then try the other one.
//
//   10.0.0.13  C225  fw 1.3.1  advertises sha256, accepts sha256
//   10.0.0.15  C120  fw 1.9.2  advertises sha256, accepts sha256
//   10.0.0.14  C120  fw 1.4.3  advertises sha256, accepts MD5     <-- the liar
//
// No cloud contact occurs: the secret is a hash of the Tapo cloud password which the camera
// verifies locally. The local camera-account credentials are not accepted by this endpoint.

import * as crypto from 'crypto';
import * as net from 'net';
import { DigestChallenge, digestAuthHeader, parseChallenge } from './digestAuth';
import { MpegTsMuxer, STREAM_TYPE_PCMA_TAPO } from './mpegts';

export type TapoSecretKind = 'sha256' | 'md5';

/** The `params` object of a camera reply. `session_id` is what a talk request yields;
 * `error_code` is present and non-zero when the camera refuses. */
export interface TapoResponseParams {
    session_id?: string | number;
    error_code?: number;
}

export interface TapoClientOptions {
    host: string;
    port?: number;
    cloudPassword: string;
    /** A previous Tapo cloud password, tried if the current one is rejected.
     *
     * Needed because a password change does NOT reach every camera at once: after one was
     * changed here, both C120s had been re-provisioned with the new password within minutes
     * while a C225 still accepted only the old one. Without this, rotating the account password
     * silently breaks talkback on whichever cameras have not synced yet. */
    previousCloudPassword?: string;
    console?: Console;
}

const CLIENT_BOUNDARY = '----client-stream-boundary--';
const DEVICE_BOUNDARY = '----device-stream-boundary--';
/** Upstream uses PID 68 for the audio elementary stream; the camera expects that PID. */
const AUDIO_PID = 68;

export class TapoClient {
    private socket?: net.Socket;
    private rx = Buffer.alloc(0);
    private seq = 0;
    // Keyed by the request's `seq`, inserted and removed at runtime -- a Map, not a Record.
    private pending = new Map<number, {
        resolve: (params: TapoResponseParams) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
    }>();
    private sessionId?: string;
    private muxer?: MpegTsMuxer;
    private log: Console;

    readonly auth: {
        used?: TapoSecretKind;
        advertised?: TapoSecretKind;
        /** Which configured password authenticated, for the operator's benefit. */
        password?: 'current' | 'previous';
    } = {};
    readonly stats = { partsSent: 0, audioBytesSent: 0 };

    constructor(private options: TapoClientOptions) {
        this.log = options.console ?? console;
    }

    get port(): number {
        return this.options.port ?? 8800;
    }

    private secret(kind: TapoSecretKind, password: string): string {
        return crypto.createHash(kind).update(Buffer.from(password)).digest('hex').toUpperCase();
    }

    async connect(timeoutMs = 8000): Promise<void> {
        const challenge = await this.challenge(timeoutMs);
        this.auth.advertised = challenge.raw.includes('encrypt_type="3"') ? 'sha256' : 'md5';
        const kinds: TapoSecretKind[] = this.auth.advertised === 'sha256' ? ['sha256', 'md5'] : ['md5', 'sha256'];
        const passwords: { label: 'current' | 'previous'; value: string }[] = [
            { label: 'current', value: this.options.cloudPassword },
        ];
        if (this.options.previousCloudPassword)
            passwords.push({ label: 'previous', value: this.options.previousCloudPassword });

        // Four combinations at worst, and the camera's own advertisement orders them, so a
        // correctly-provisioned camera authenticates on the first try.
        for (const password of passwords) {
            for (const kind of kinds) {
                // A fresh challenge per attempt: the nonce is single-use, so retrying with a
                // stale one looks like a credential failure even when the secret is right.
                const fresh = await this.challenge(timeoutMs);
                const socket = await this.authenticate(fresh, this.secret(kind, password.value), timeoutMs);
                if (!socket)
                    continue;
                this.socket = socket;
                this.auth.used = kind;
                this.auth.password = password.label;
                socket.on('data', chunk => this.onData(chunk));
                socket.on('error', e => this.fail(e));
                socket.on('close', () => this.fail(new Error('camera closed the talk stream')));
                if (kind !== this.auth.advertised) {
                    this.log.warn(`tapo: ${this.options.host} advertised ${this.auth.advertised} `
                        + `but only accepts ${kind}; using ${kind}`);
                }
                if (password.label === 'previous') {
                    this.log.warn(`tapo: ${this.options.host} still uses the PREVIOUS cloud password; `
                        + 'it has not picked up the change yet');
                }
                return;
            }
        }
        throw new Error(`tapo: ${this.options.host} rejected every combination of the configured `
            + 'cloud password(s) with the SHA256 and MD5 derivations');
    }

    /** Resolves the session id for a talk session; the camera refuses audio without one. */
    async startTalk(timeoutMs = 6000): Promise<string> {
        const params = await this.request({ talk: { mode: 'aec' }, method: 'get' }, timeoutMs);
        if (params.error_code)
            throw new Error(`tapo: talk request failed: ${JSON.stringify(params)}`);
        const sessionId = params.session_id;
        if (!sessionId)
            throw new Error(`tapo: talk request returned no session_id: ${JSON.stringify(params)}`);
        this.sessionId = String(sessionId);
        return this.sessionId;
    }

    /** PAT + PMT for the audio stream; must be written once before the first audio frame. */
    muxHeader(): Buffer {
        const muxer = new MpegTsMuxer();
        muxer.addTrack(STREAM_TYPE_PCMA_TAPO, AUDIO_PID);
        this.muxer = muxer;
        return muxer.header();
    }

    muxAudio(alaw: Buffer): Buffer {
        if (!this.muxer)
            throw new Error('tapo: muxHeader() must be called before muxAudio()');
        // 90 kHz PTS ticks for this frame: A-law is one byte per sample at 8 kHz.
        return this.muxer.payload(AUDIO_PID, alaw, Math.round((alaw.length / 8000) * 90000));
    }

    writeAudio(mpegts: Buffer): void {
        if (!mpegts.length)
            return;
        this.writePart('audio/mp2t', mpegts, {
            'X-If-Encrypt': '0',
            ...(this.sessionId ? { 'X-Session-Id': this.sessionId } : {}),
        });
        this.stats.audioBytesSent += mpegts.length;
    }

    close(): void {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error('tapo: client closed'));
        }
        this.pending.clear();
        this.socket?.destroy();
        this.socket = undefined;
    }

    private async challenge(timeoutMs: number) {
        const { socket, head } = await this.open(undefined, timeoutMs);
        socket.destroy();
        const match = head.match(/WWW-Authenticate:\s*(.+)/i);
        if (!match)
            throw new Error(`tapo: no auth challenge from ${this.options.host}:${this.port}`);
        return parseChallenge(match[1].trim());
    }

    private async authenticate(challenge: DigestChallenge, secret: string, timeoutMs: number) {
        const { socket, head } = await this.open(digestAuthHeader(challenge, secret), timeoutMs);
        if (/^HTTP\/1\.[01] 200/.test(head))
            return socket;
        socket.destroy();
        return undefined;
    }

    /** Opens /stream and returns the socket plus the response head, leaving any bytes that
     * followed the head in `this.rx` -- the camera can start streaming immediately, and
     * discarding them loses the first reply. */
    private async open(authorization: string | undefined, timeoutMs: number) {
        const { promise, resolve, reject } = Promise.withResolvers<{ socket: net.Socket; head: string }>();
        const socket = net.createConnection({ host: this.options.host, port: this.port });
        socket.setNoDelay(true);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`tapo: ${this.options.host}:${this.port} timed out`));
        }, timeoutMs);
        let buffer = Buffer.alloc(0);
        const onError = (e: Error) => {
            clearTimeout(timer);
            socket.destroy();
            reject(e);
        };
        socket.once('error', onError);
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            const split = buffer.indexOf('\r\n\r\n');
            if (split < 0)
                return;
            clearTimeout(timer);
            socket.removeAllListeners('data');
            socket.off('error', onError);
            this.rx = buffer.subarray(split + 4);
            resolve({ socket, head: buffer.subarray(0, split).toString('utf8') });
        });
        socket.once('connect', () => {
            socket.write(
                `POST /stream HTTP/1.1\r\nHost: ${this.options.host}:${this.port}\r\n`
                + 'Content-Type: multipart/mixed; boundary=--client-stream-boundary--\r\n'
                + (authorization ? `Authorization: ${authorization}\r\n` : '')
                + 'Accept: */*\r\nConnection: keep-alive\r\n\r\n',
            );
        });
        return promise;
    }

    private request(params: Record<string, unknown>, timeoutMs: number): Promise<TapoResponseParams> {
        const seq = ++this.seq;
        const { promise, resolve, reject } = Promise.withResolvers<TapoResponseParams>();
        const timer = setTimeout(() => {
            this.pending.delete(seq);
            reject(new Error(`tapo: no reply to request seq ${seq} (the camera answers nothing at `
                + 'all when the part framing is wrong)'));
        }, timeoutMs);
        this.pending.set(seq, { resolve, reject, timer });
        this.writePart('application/json', Buffer.from(JSON.stringify({ params, seq, type: 'request' })), {});
        return promise;
    }

    private writePart(contentType: string, body: Buffer, headers: Record<string, string>): void {
        if (!this.socket)
            throw new Error('tapo: not connected');
        const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
        this.socket.write(
            `${CLIENT_BOUNDARY}\r\nContent-Type: ${contentType}\r\n${extra}`
            + `Content-Length: ${body.length}\r\n\r\n`,
        );
        this.socket.write(body);
        this.socket.write('\r\n');
        this.stats.partsSent++;
    }

    /** Pulls JSON replies out of the camera's multipart stream. Audio/video parts the camera
     * sends are skipped: this client only talks, the video comes over RTSP elsewhere. */
    private onData(chunk: Buffer): void {
        this.rx = Buffer.concat([this.rx, chunk]);
        for (;;) {
            const start = this.rx.indexOf(DEVICE_BOUNDARY);
            if (start < 0)
                return;
            const headEnd = this.rx.indexOf('\r\n\r\n', start);
            if (headEnd < 0)
                return;
            const head = this.rx.subarray(start + DEVICE_BOUNDARY.length, headEnd).toString('utf8');
            const lengthMatch = head.match(/Content-Length:\s*(\d+)/i);
            if (!lengthMatch) {
                this.rx = this.rx.subarray(headEnd + 4);
                continue;
            }
            const length = Number(lengthMatch[1]);
            const bodyStart = headEnd + 4;
            if (this.rx.length < bodyStart + length)
                return;
            const body = this.rx.subarray(bodyStart, bodyStart + length);
            this.rx = this.rx.subarray(bodyStart + length);
            if (head.toLowerCase().includes('application/json'))
                this.dispatch(body);
        }
    }

    private dispatch(body: Buffer): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(body.toString('utf8'));
        } catch {
            this.log.warn('tapo: unparseable JSON part:', body.toString('utf8').slice(0, 200));
            return;
        }
        if (!parsed || typeof parsed !== 'object')
            return;
        const message = parsed as { type?: unknown; seq?: unknown; params?: TapoResponseParams };
        if (message.type !== 'response' || typeof message.seq !== 'number')
            return;
        const entry = this.pending.get(message.seq);
        if (!entry)
            return;
        this.pending.delete(message.seq);
        clearTimeout(entry.timer);
        entry.resolve(message.params ?? {});
    }

    private fail(e: Error): void {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(e);
        }
        this.pending.clear();
    }
}

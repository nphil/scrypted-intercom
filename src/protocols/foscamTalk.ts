// Foscam "low level" protocol client, talk (speaker) direction only.
//
// Foscam's CGI API cannot send audio to a camera; the only path is the proprietary binary
// protocol that the vendor's own app and browser plugin speak on the camera's *media port*
// (`cmd=getPortInfo` -> `mediaPort`, 88 by default -- the same port as the HTTP CGI and the
// LIVE555 RTSP server, demultiplexed by the first request line).
//
// The framing below is the one documented for the FI9821W V2 in
// https://github.com/MStrecke/pyFosControl/blob/master/lowlevel/LowlevelProtocol.md
// with two corrections established live against an R2C on firmware 2.91.2.80, because the
// document's layouts are silently rejected by this firmware:
//
//   1. `Speaker on` (command 4) must carry the 164-byte *login* payload shape
//      (`user[64] pwd[64] uid[u32] pad[32]`), NOT the 161-byte `flag + user + pwd + uid + pad[28]`
//      shape the document lists. The camera answers command 20 either way, but the u32 in that
//      reply is a status: 0 = accepted, 1 = rejected. Only the 164-byte form gets a 0, and only
//      after a 0 does the camera actually route command 6 payloads to its speaker.
//   2. Command 6 payloads are `len[u32] + raw audio`, with NO frame header. Prefixing the
//      36-byte header the camera's own outbound audio frames (command 27) carry makes the
//      camera drop the connection.
//
// Audio format, measured acoustically (tone frequency and a 300->3200 Hz chirp pushed through
// this client and recovered from the camera's own RTSP audio track): raw signed 16-bit
// little-endian PCM, 8000 Hz, mono, in 960-byte (= 480 sample = 60 ms) frames, paced in real
// time. The camera has no meaningful jitter buffer: it absorbs a burst without any TCP
// backpressure and simply discards what it cannot play, so pacing is this client's job.

import * as net from 'net';

const MAGIC = Buffer.from('FOSC', 'ascii');

/** Client -> camera. */
export enum FoscCommand {
    VideoOn = 0,
    Close = 1,
    MicOn = 2,
    MicOff = 3,
    SpeakerOn = 4,
    SpeakerOff = 5,
    TalkData = 6,
    Login = 12,
    LoginCheck = 15,
}

/** Camera -> client (only the ones this client acts on). */
export enum FoscReply {
    SpeakerOnAck = 20,
    SpeakerOffAck = 21,
    AudioIn = 27,
    LoginCheckAck = 29,
    DeviceInfo = 100,
}

export const SAMPLE_RATE = 8000;
export const TALK_FRAME_BYTES = 960; // 480 samples @ 16-bit = 60 ms
const TALK_FRAME_MS = (TALK_FRAME_BYTES / 2 / SAMPLE_RATE) * 1000;
/** Hard cap on queued audio, so a bursty producer adds bounded latency instead of unbounded. */
const MAX_QUEUED_BYTES = SAMPLE_RATE * 2; // 1 s
const KEEPALIVE_MS = 15_000;

export interface FoscamTalkOptions {
    host: string;
    /** Foscam media port -- `cmd=getPortInfo` -> `mediaPort`. Default 88. */
    port?: number;
    username: string;
    password: string;
    console?: Console;
}

interface Pending {
    cmd: number;
    resolve: (payload: Buffer) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

export class FoscamTalkClient {
    private socket?: net.Socket;
    private rx = Buffer.alloc(0);
    private pending: Pending[] = [];
    private queue: Buffer[] = [];
    private queuedBytes = 0;
    private pacer?: NodeJS.Timeout;
    private keepalive?: NodeJS.Timeout;
    private nextFrameDue = 0;
    private closed = false;
    private readonly uid = (Date.now() / 1000) & 0x7fffffff;
    private readonly user: Buffer;
    private readonly pwd: Buffer;
    private readonly log: Console;

    /** Frames handed to the socket, and audio bytes dropped because the producer outran real time. */
    readonly stats = { framesSent: 0, bytesSent: 0, bytesDropped: 0 };

    constructor(private options: FoscamTalkOptions) {
        this.user = Buffer.alloc(64);
        this.user.write(options.username, 0, 'ascii');
        this.pwd = Buffer.alloc(64);
        this.pwd.write(options.password, 0, 'ascii');
        this.log = options.console ?? console;
    }

    get port(): number {
        return this.options.port ?? 88;
    }

    async connect(timeoutMs = 5000): Promise<void> {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const socket = net.createConnection({ host: this.options.host, port: this.port });
        socket.setNoDelay(true);
        const onError = (e: Error) => { socket.destroy(); reject(e); };
        const timer = setTimeout(() => onError(new Error(`connect to ${this.options.host}:${this.port} timed out`)), timeoutMs);
        socket.once('error', onError);
        socket.once('connect', () => {
            clearTimeout(timer);
            socket.off('error', onError);
            this.socket = socket;
            socket.on('data', chunk => this.onData(chunk));
            socket.on('error', e => this.fail(e));
            socket.on('close', () => this.fail(new Error('camera closed the connection')));
            // The low level protocol is entered through this one HTTP-shaped request; every
            // byte after it is binary FOSC framing.
            socket.write(
                `SERVERPUSH / HTTP/1.1\r\nHost: ${this.options.host}:${this.port}\r\n`
                + 'Accept:*/*\r\nConnection: Close\r\n\r\n\r\n',
            );
            resolve();
        });
        await promise;
    }

    /** Authenticates, then proves the session is authenticated (command 15 -> reply 29 == 0). */
    async login(): Promise<void> {
        const payload = Buffer.concat([this.user, this.pwd, u32(this.uid), Buffer.alloc(32)]);
        this.send(FoscCommand.Login, payload);
        const check = this.expect(FoscReply.LoginCheckAck, 5000);
        this.send(FoscCommand.LoginCheck, u32(this.uid));
        const status = (await check).readUInt32LE(0);
        if (status !== 0)
            throw new Error(`login rejected by camera (login check status ${status})`);
        this.keepalive = setInterval(() => {
            try {
                this.send(FoscCommand.LoginCheck, u32(this.uid));
            } catch {
                // fail() has already torn the session down.
            }
        }, KEEPALIVE_MS);
    }

    /** Opens the speaker and starts the real-time pacer. Throws if the camera rejects it. */
    async startTalk(): Promise<void> {
        const payload = Buffer.concat([this.user, this.pwd, u32(this.uid), Buffer.alloc(32)]);
        const ack = this.expect(FoscReply.SpeakerOnAck, 5000);
        this.send(FoscCommand.SpeakerOn, payload);
        const status = (await ack).readUInt32LE(0);
        if (status !== 0)
            throw new Error(`camera refused speaker on (reply 20 status ${status}; 164-byte payload required)`);
        this.nextFrameDue = Date.now();
        this.pacer = setInterval(() => this.drain(), Math.round(TALK_FRAME_MS / 2));
    }

    /** Queues PCM (s16le, 8 kHz, mono). Safe to call with arbitrary chunk sizes. */
    write(pcm: Buffer): void {
        if (this.closed)
            return;
        this.queue.push(pcm);
        this.queuedBytes += pcm.length;
        while (this.queuedBytes > MAX_QUEUED_BYTES && this.queue.length > 1) {
            const dropped = this.queue.shift()!;
            this.queuedBytes -= dropped.length;
            this.stats.bytesDropped += dropped.length;
        }
        this.drain();
    }

    async stopTalk(): Promise<void> {
        clearInterval(this.pacer);
        this.pacer = undefined;
        this.queue = [];
        this.queuedBytes = 0;
        if (this.closed || !this.socket)
            return;
        try {
            const ack = this.expect(FoscReply.SpeakerOffAck, 2000);
            this.send(FoscCommand.SpeakerOff, Buffer.concat([this.user, this.pwd, Buffer.alloc(32)]));
            await ack;
        } catch (e) {
            this.log.warn('foscam: speaker off not acknowledged:', (e as Error).message);
        }
    }

    close(): void {
        this.closed = true;
        clearInterval(this.pacer);
        clearInterval(this.keepalive);
        this.pacer = undefined;
        this.keepalive = undefined;
        for (const p of this.pending.splice(0)) {
            clearTimeout(p.timer);
            p.reject(new Error('client closed'));
        }
        this.socket?.destroy();
        this.socket = undefined;
    }

    /** Waits for the next frame with this command id. */
    expect(cmd: number, timeoutMs: number): Promise<Buffer> {
        const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
        const entry: Pending = {
            cmd, resolve, reject,
            timer: setTimeout(() => {
                this.pending = this.pending.filter(p => p !== entry);
                reject(new Error(`timed out waiting for camera reply ${cmd}`));
            }, timeoutMs),
        };
        this.pending.push(entry);
        return promise;
    }

    send(cmd: number, payload: Buffer): void {
        if (!this.socket)
            throw new Error('not connected');
        const header = Buffer.alloc(12);
        header.writeUInt32LE(cmd, 0);
        MAGIC.copy(header, 4);
        header.writeUInt32LE(payload.length, 8);
        this.socket.write(Buffer.concat([header, payload]));
    }

    /** Emits at most one frame per real-time frame interval; never sends a short frame. */
    private drain(): void {
        if (!this.socket || this.closed)
            return;
        const now = Date.now();
        if (this.nextFrameDue < now - 5 * TALK_FRAME_MS)
            this.nextFrameDue = now; // long idle: restart the clock instead of bursting to catch up
        while (this.queuedBytes >= TALK_FRAME_BYTES && this.nextFrameDue <= now) {
            const frame = this.take(TALK_FRAME_BYTES);
            const payload = Buffer.alloc(4 + frame.length);
            payload.writeUInt32LE(frame.length, 0);
            frame.copy(payload, 4);
            try {
                this.send(FoscCommand.TalkData, payload);
            } catch (e) {
                this.log.warn('foscam: talk frame write failed:', (e as Error).message);
                return;
            }
            this.stats.framesSent++;
            this.stats.bytesSent += frame.length;
            this.nextFrameDue += TALK_FRAME_MS;
        }
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

    private onData(chunk: Buffer): void {
        this.rx = Buffer.concat([this.rx, chunk]);
        for (;;) {
            if (this.rx.length < 12)
                return;
            if (this.rx.compare(MAGIC, 0, 4, 4, 8) !== 0) {
                this.rx = this.rx.subarray(1); // resync
                continue;
            }
            const cmd = this.rx.readUInt32LE(0);
            const size = this.rx.readUInt32LE(8);
            if (this.rx.length < 12 + size)
                return;
            const payload = this.rx.subarray(12, 12 + size);
            this.rx = this.rx.subarray(12 + size);
            const idx = this.pending.findIndex(p => p.cmd === cmd);
            if (idx >= 0) {
                const [entry] = this.pending.splice(idx, 1);
                clearTimeout(entry.timer);
                entry.resolve(Buffer.from(payload));
            }
        }
    }

    private fail(e: Error): void {
        if (this.closed)
            return;
        this.closed = true;
        for (const p of this.pending.splice(0)) {
            clearTimeout(p.timer);
            p.reject(e);
        }
        clearInterval(this.pacer);
        clearInterval(this.keepalive);
        this.pacer = undefined;
        this.keepalive = undefined;
    }
}

function u32(value: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0, 0);
    return b;
}

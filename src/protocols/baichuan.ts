// Reolink's proprietary Baichuan protocol (plain TCP, port 9000), talk (speaker) direction only.
//
// Ported from a working Python prototype (a thin wrapper around `reolink_aio`'s Baichuan client,
// preserved at /tmp/hatalk_standalone.py) that was proven to drive two-way audio on a Reolink
// RLC-833A (10.0.0.12, fw v3.1.0.3016_2312052457) -- the camera owner confirmed the audio
// audible standing in the room. Every constant and byte layout below comes from that prototype,
// cross-referenced against the public Baichuan header layout (neolink, reolink_aio,
// github.com/TinKurbatoff/reolink-init); none of it is re-derived, because this protocol has no
// public spec and a wrong byte order tends to fail silently rather than loudly.
//
// Wire shape, in short:
//   - Every message starts with a 4-byte magic (`f0debc0a`), then a header that is 20 bytes
//     total when the class is 0x1465 or 0x1466 (the nonce request and the camera's own nonce
//     reply -- the only two classes without a `payloadOffset` field) or 24 bytes total for every
//     other class this camera actually uses on the wire, including the 0x1464 we send for
//     everything after the nonce AND the 0x0000 ("legacy") class the camera sends back for
//     login and everything after -- see `hasPayloadOffsetField` for why this is not simply
//     "1464 vs everything else", then `messLen` bytes of body.
//   - Bodies are XML, encrypted one of two ways: XOR ("BC") for the nonce exchange and login,
//     AES-128-CFB (keyed from the login nonce) for everything after. cmd 202 (talk audio) is the
//     one exception: its Extension XML is AES-encrypted but the ADPCM payload after it is raw.
//   - See `talkFullBlockSize` below for the single most expensive-to-discover detail: the ADPCM
//     block size the camera actually wants on the wire is NOT `TalkAbility.lengthPerEncoder`.
//
// This camera's real TalkAbility (cmd 10, channel 0, AES) reply, for reference:
//   <TalkAbility version="1.1"><duplexList><duplex>FDX</duplex></duplexList>
//   <audioStreamModeList><audioStreamMode>followVideoStream</audioStreamMode></audioStreamModeList>
//   <audioConfigList><audioConfig><priority>0</priority><audioType>adpcm</audioType>
//   <sampleRate>16000</sampleRate><samplePrecision>16</samplePrecision>
//   <lengthPerEncoder>1024</lengthPerEncoder><soundTrack>mono</soundTrack></audioConfig></audioConfigList></TalkAbility>

import * as crypto from 'crypto';
import * as net from 'net';

export interface TalkAbility {
    duplex: string;
    audioStreamMode: string;
    audioType: string;
    priority?: number;
    sampleRate: number;
    samplePrecision: number;
    lengthPerEncoder: number;
    soundTrack: string;
}

export interface BaichuanOptions {
    host: string;
    /** Baichuan port. Always 9000 in practice; nothing reports it via CGI. */
    port?: number;
    username: string;
    password: string;
    console?: Console;
}

const HEADER_MAGIC = Buffer.from('f0debc0a', 'hex');

// Header shape (20 vs 24 bytes) is NOT simply "1464 = has payloadOffset, everything else
// doesn't": empirically (raw-socket trace against the real camera), the nonce exchange alone
// uses 1465 (request) / 1466 (reply), both 20-byte/no-offset -- but every other reply, including
// login's and every AES exchange after it, comes back as class 0x0000 (the "legacy" status/class
// pair neolink's own docs mention: status c8 00, class 00 00), which DOES carry the
// payloadOffset field, exactly like the 1464 we send. So the rule that actually matches the wire
// is "20-byte only for 1465/1466", not "24-byte only for 1464".
const MESSAGE_CLASS_1464 = 0x1464; // sent for every request except the nonce
const MESSAGE_CLASS_1465 = 0x1465; // sent only for the nonce request
const MESSAGE_CLASS_1466 = 0x1466; // the camera's own reply class for the nonce exchange

function hasPayloadOffsetField(messageClass: number): boolean {
    return messageClass !== MESSAGE_CLASS_1465 && messageClass !== MESSAGE_CLASS_1466;
}

/** XOR keystream bytes for "BC" body encryption (pre-login only). Self-inverse: the same
 *  function encrypts and decrypts. */
const XML_KEY: readonly number[] = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff];

/** Fixed IV for AES-128-CFB body encryption. Reused for every message in a session -- a known
 *  weak property of this protocol, not a bug in this port. */
const AES_IV = Buffer.from('0123456789abcdef', 'ascii');

const BCMEDIA_ADPCM_MAGIC = 0x62773130; // BcMedia ADPCM packet marker ("bw10"), written little-endian
const BCMEDIA_ADPCM_BLOCK_MAGIC = 0x0100; // fixed marker preceding the per-block size field

enum EncType { Bc, Aes }

interface BaichuanReply {
    cmdId: number;
    chId: number;
    statusCode: number;
    mainBody: Buffer;
}

interface PendingEntry {
    resolve: (msg: BaichuanReply) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

/**
 * The ADPCM block size this camera actually wants on the wire for talkback audio: half of
 * `lengthPerEncoder` (nibbles pack 2 samples/byte) plus the 4-byte predictor header -- NOT
 * `lengthPerEncoder` itself. Verified against a Reolink RLC-833A (fw v3.1.0.3016_2312052457),
 * whose TalkAbility advertises `lengthPerEncoder=1024`: 1024-byte blocks are accepted and ACKed
 * with zero errors but play back as silence, while 516-byte blocks play the actual audio. Callers
 * MUST size blocks with this before calling `encodeImaDviBlocks`, never with
 * `ability.lengthPerEncoder` directly.
 */
export function talkFullBlockSize(ability: TalkAbility): number {
    return ability.lengthPerEncoder / 2 + 4;
}

function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}

/** Its own inverse: `offset` (the message's chId, <=255) is XORed straight into the keystream. */
function bcXor(data: Buffer, offset: number): Buffer {
    if (offset > 255)
        throw new RangeError(`BC offset must be <= 255 (got ${offset})`);
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++)
        out[i] = data[i] ^ XML_KEY[(offset + i) % 8] ^ offset;
    return out;
}

/** Reolink's own MD5-derived digest: uppercase hex, truncated to 31 chars -- not 32, verified,
 *  not a typo. The camera rejects both the AES key and the login hashes if this is 32 chars. */
function md5Modern(s: string): string {
    return crypto.createHash('md5').update(Buffer.from(s, 'utf8')).digest('hex').slice(0, 31).toUpperCase();
}

/** The generic per-channel extension every channel-scoped command sends alongside its body. */
function channelExtensionXml(channel: number): string {
    return '<?xml version="1.0" encoding="UTF-8" ?>\n'
        + '<Extension version="1.1">\n'
        + `<channelId>${channel}</channelId>\n`
        + '</Extension>\n';
}

/** cmd 202's own extension shape: the generic one above plus the `binaryData` flag the camera
 *  expects whenever raw (unencrypted) audio bytes follow the (encrypted) extension. */
function talkExtensionXml(channel: number): string {
    return '<?xml version="1.0" encoding="UTF-8" ?>\n'
        + '<Extension version="1.1">\n'
        + '<binaryData>1</binaryData>\n'
        + `<channelId>${channel}</channelId>\n`
        + '</Extension>\n';
}

function loginXml(userNameHash: string, passwordHash: string): string {
    return '<?xml version="1.0" encoding="UTF-8" ?>\n'
        + '<body>\n'
        + '<LoginUser version="1.1">\n'
        + `<userName>${userNameHash}</userName>\n`
        + `<password>${passwordHash}</password>\n`
        + '<userVer>1</userVer>\n'
        + '</LoginUser>\n'
        + '<LoginNet version="1.1">\n'
        + '<type>LAN</type>\n'
        + '<udpPort>0</udpPort>\n'
        + '</LoginNet>\n'
        + '</body>\n';
}

function talkConfigXml(channel: number, ability: TalkAbility): string {
    const priorityLine = ability.priority !== undefined ? `<priority>${ability.priority}</priority>\n` : '';
    return '<?xml version="1.0" encoding="UTF-8" ?>\n'
        + '<body>\n'
        + '<TalkConfig version="1.1">\n'
        + `<channelId>${channel}</channelId>\n`
        + `<duplex>${ability.duplex}</duplex>\n`
        + `<audioStreamMode>${ability.audioStreamMode}</audioStreamMode>\n`
        + '<audioConfig>\n'
        + priorityLine
        + `<audioType>${ability.audioType}</audioType>\n`
        + `<sampleRate>${ability.sampleRate}</sampleRate>\n`
        + `<samplePrecision>${ability.samplePrecision}</samplePrecision>\n`
        + `<lengthPerEncoder>${ability.lengthPerEncoder}</lengthPerEncoder>\n`
        + `<soundTrack>${ability.soundTrack}</soundTrack>\n`
        + '</audioConfig>\n'
        + '</TalkConfig>\n'
        + '</body>\n';
}

/** First text of `<tag>` anywhere in `xml`, tolerating attributes on the opening tag. */
function extractTag(xml: string, tag: string): string | undefined {
    const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`));
    return match ? match[1].trim() : undefined;
}

/** Text of every `<tag>` anywhere in `xml`, in document order. */
function extractAllTags(xml: string, tag: string): string[] {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g');
    const out: string[] = [];
    for (const match of xml.matchAll(re)) {
        const text = match[1].trim();
        if (text)
            out.push(text);
    }
    return out;
}

/** Inner XML of the first `<tag>...</tag>` anywhere in `xml`. */
function extractElement(xml: string, tag: string): string | undefined {
    const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
    return match ? match[1] : undefined;
}

/**
 * Parses a TalkAbility (cmd 10) reply. Generic across firmwares: prefers `FDX` from the duplex
 * list and `mixAudioStream` from the stream-mode list when offered (full duplex, and independence
 * from the live video stream's own audio mode), else falls back to the first advertised entry --
 * matching the exact XML this camera returns (see the module comment above for that sample).
 */
function parseTalkAbility(xml: string): TalkAbility {
    const scoped = extractElement(xml, 'TalkAbility');
    if (scoped === undefined)
        throw new Error(`TalkAbility not found in response: ${xml.slice(0, 200)}`);

    const duplexList = extractAllTags(scoped, 'duplex');
    const streamModeList = extractAllTags(scoped, 'audioStreamMode');
    const duplex = duplexList.includes('FDX') ? 'FDX' : duplexList[0] ?? 'FDX';
    const audioStreamMode = streamModeList.includes('mixAudioStream') ? 'mixAudioStream' : streamModeList[0] ?? 'followVideoStream';

    const audioConfig = extractElement(scoped, 'audioConfig');
    if (audioConfig === undefined)
        throw new Error(`audioConfig not found in TalkAbility: ${xml.slice(0, 200)}`);

    const priorityText = extractTag(audioConfig, 'priority');
    return {
        duplex,
        audioStreamMode,
        audioType: extractTag(audioConfig, 'audioType') ?? 'adpcm',
        priority: priorityText !== undefined && /^\d+$/.test(priorityText) ? Number(priorityText) : undefined,
        sampleRate: Number(extractTag(audioConfig, 'sampleRate') ?? '16000'),
        samplePrecision: Number(extractTag(audioConfig, 'samplePrecision') ?? '16'),
        lengthPerEncoder: Number(extractTag(audioConfig, 'lengthPerEncoder') ?? '1024'),
        soundTrack: extractTag(audioConfig, 'soundTrack') ?? 'mono',
    };
}

function buildHeader(opts: {
    cmdId: number; chId: number; messId: number; messLen: number; messageClass: number; payloadOffset: number;
}): Buffer {
    const hasPayloadOffset = hasPayloadOffsetField(opts.messageClass);
    const header = Buffer.alloc(hasPayloadOffset ? 24 : 20);
    HEADER_MAGIC.copy(header, 0);
    header.writeUInt32LE(opts.cmdId, 4);
    header.writeUInt32LE(opts.messLen, 8);
    header.writeUInt8(opts.chId, 12);
    header.writeUIntLE(opts.messId, 13, 3);
    // Bytes 16-17: statusCode (always 0) for every header WE send that carries payloadOffset;
    // the 1465 nonce request instead carries a fixed 0x12dc marker in that position -- sending
    // 0x0000 there instead (as this used to) makes the camera reply with an empty stub, no nonce.
    header.writeUInt16BE(hasPayloadOffset ? 0x0000 : 0x12dc, 16);
    header.writeUInt16BE(opts.messageClass, 18);
    if (hasPayloadOffset)
        header.writeUInt32LE(opts.payloadOffset, 20);
    return header;
}

/** Wraps one raw ADPCM block (predictor header + payload) in its BcMedia packet framing. */
function frameBcMediaAdpcm(block: Buffer): Buffer {
    if (block.length < 5)
        throw new RangeError(`ADPCM block too small to frame (${block.length} bytes)`);
    const payloadLen = block.length + 4; // the block itself plus the trailing blockMagic+blockSize u16 pair
    const blockSize = (block.length - 4) / 2; // nibble-byte count of the ADPCM payload, header excluded
    const header = Buffer.alloc(12);
    header.writeUInt32LE(BCMEDIA_ADPCM_MAGIC, 0);
    header.writeUInt16LE(payloadLen, 4);
    header.writeUInt16LE(payloadLen, 6);
    header.writeUInt16LE(BCMEDIA_ADPCM_BLOCK_MAGIC, 8);
    header.writeUInt16LE(blockSize, 10);
    const padLen = (8 - (block.length % 8)) % 8; // pad to the next 8-byte boundary, based on block.length alone
    return Buffer.concat([header, block, Buffer.alloc(padLen)]);
}

export class BaichuanClient {
    private socket?: net.Socket;
    private rx: Buffer = Buffer.alloc(0);
    private readonly pending = new Map<number, PendingEntry[]>();
    private messIdCounter = 0;
    private aesKey?: Buffer;
    private loggedIn = false;
    private closed = false;
    private readonly log: Console;

    /** Payloads (cmd 202 messages) sent, and the individual ADPCM blocks they carried. */
    readonly stats = { payloadsSent: 0, blocksSent: 0 };

    constructor(private options: BaichuanOptions) {
        this.log = options.console ?? console;
    }

    get port(): number {
        return this.options.port ?? 9000;
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
            resolve();
        });
        await promise;
    }

    /** Fetches the login nonce, derives the AES session key from it, then logs in. A
     *  `<DeviceInfo>` element in the reply is the camera's own success signal; status 401 means
     *  bad credentials. */
    async login(): Promise<void> {
        const nonceReply = await this.request(1, { encType: EncType.Bc, messageClass: MESSAGE_CLASS_1465 });
        const nonceXml = nonceReply.body.toString('utf8');
        const nonce = extractTag(nonceXml, 'nonce');
        if (!nonce)
            throw new Error(`login failed: no <nonce> in camera response: ${nonceXml.slice(0, 200)}`);

        // Fixed (with AES_IV) for the rest of this session -- verified against
        // /tmp/hatalk_standalone.py's key derivation.
        this.aesKey = Buffer.from(md5Modern(`${nonce}-${this.options.password}`).slice(0, 16), 'utf8');

        const userNameHash = md5Modern(this.options.username + nonce);
        const passwordHash = md5Modern(this.options.password + nonce);
        const { statusCode, body } = await this.request(1, {
            encType: EncType.Bc,
            body: loginXml(userNameHash, passwordHash),
        });
        const xml = body.toString('utf8');
        if (statusCode === 401)
            throw new Error('login rejected by camera: bad credentials (status 401)');
        if (!/<DeviceInfo[\s>]/.test(xml))
            throw new Error(`login response missing <DeviceInfo> (status ${statusCode}): ${xml.slice(0, 200)}`);
        this.loggedIn = true;
    }

    async getTalkAbility(channel = 0): Promise<TalkAbility> {
        if (!this.loggedIn)
            throw new Error('call login() before getTalkAbility()');
        const { body } = await this.request(10, { channel, encType: EncType.Aes });
        return parseTalkAbility(body.toString('utf8'));
    }

    /** Sends TalkConfig (cmd 201), with the stop+retry recovery described below. */
    async startTalk(ability: TalkAbility, channel = 0): Promise<void> {
        if (!this.loggedIn)
            throw new Error('call login() before startTalk()');
        const body = talkConfigXml(channel, ability);
        const first = await this.request(201, { channel, body, encType: EncType.Aes });
        if (first.statusCode !== 400 && first.statusCode !== 422)
            return;

        // Some firmwares reject a fresh TalkConfig while they still think a previous talk
        // session is open. Stopping it and giving the camera ~100ms to settle before retrying
        // clears that state. Best-effort: a failed stop here just means there was nothing to stop.
        try {
            await this.stopTalk(channel);
        } catch (e) {
            this.log.warn('baichuan: pre-retry stopTalk failed (continuing):', (e as Error).message);
        }
        await sleep(100);
        const retry = await this.request(201, { channel, body, encType: EncType.Aes });
        if (retry.statusCode === 400 || retry.statusCode === 422)
            throw new Error(`TalkConfig rejected after stop+retry (status ${retry.statusCode})`);
    }

    /** Frames + sends one group of ADPCM blocks as cmd 202. Does NOT pace; caller paces (each
     *  block holds `(fullBlockSize - 4) * 2` samples, so a group's playback time is
     *  `blocks.length * (fullBlockSize - 4) * 2 / ability.sampleRate` seconds -- see
     *  `talkFullBlockSize` for `fullBlockSize`, and never `ability.lengthPerEncoder`). */
    async sendTalkBlocks(blocks: Buffer[], channel = 0): Promise<void> {
        if (!this.socket)
            throw new Error('not connected');
        if (!this.loggedIn)
            throw new Error('call login() before sendTalkBlocks()');
        if (blocks.length === 0)
            return;

        const chId = channel + 1;
        const extension = this.aesEncrypt(Buffer.from(talkExtensionXml(channel), 'utf8'));
        const framed = Buffer.concat(blocks.map(frameBcMediaAdpcm));
        const header = buildHeader({
            cmdId: 202,
            chId,
            messId: this.nextMessId(),
            messLen: extension.length + framed.length,
            messageClass: MESSAGE_CLASS_1464,
            payloadOffset: extension.length,
        });

        // cmd 202 is fire-and-forget: per spec no reply body is parsed for it, so this resolves
        // once the bytes are handed to the socket rather than waiting on any acknowledgement.
        this.socket.write(Buffer.concat([header, extension, framed]));
        this.stats.payloadsSent++;
        this.stats.blocksSent += blocks.length;
    }

    /** Sends cmd 11. */
    async stopTalk(channel = 0): Promise<void> {
        if (!this.socket)
            return;
        await this.request(11, { channel, encType: EncType.Aes });
    }

    close(): void {
        if (!this.closed) {
            this.closed = true;
            this.rejectAllPending(new Error('client closed'));
        }
        this.socket?.destroy();
        this.socket = undefined;
    }

    /**
     * Sends `cmdId` and awaits its matched reply (matched by cmdId, per spec). Handles both
     * BC- and AES-encrypted exchanges, and both the channel-less (login/nonce) and channel-scoped
     * (everything else) message shapes -- the only cmd that bypasses this is 202, whose payload
     * is partly unencrypted and never replied to.
     */
    private async request(cmdId: number, params: {
        channel?: number;
        body?: string;
        encType: EncType;
        messageClass?: number;
        timeoutMs?: number;
    }): Promise<{ statusCode: number; body: Buffer }> {
        if (!this.socket)
            throw new Error('not connected');
        const messageClass = params.messageClass ?? MESSAGE_CLASS_1464;
        const chId = params.channel === undefined ? 250 : params.channel + 1;

        let extension: Buffer = Buffer.alloc(0);
        if (params.channel !== undefined) {
            const xml = Buffer.from(channelExtensionXml(params.channel), 'utf8');
            extension = params.encType === EncType.Bc ? bcXor(xml, chId) : this.aesEncrypt(xml);
        }
        const bodyXml = params.body ?? '';
        let encBody: Buffer = Buffer.alloc(0);
        if (bodyXml.length) {
            const raw = Buffer.from(bodyXml, 'utf8');
            encBody = params.encType === EncType.Bc ? bcXor(raw, chId) : this.aesEncrypt(raw);
        }

        const wirePayload = Buffer.concat([extension, encBody]);
        const header = buildHeader({
            cmdId,
            chId,
            messId: this.nextMessId(),
            messLen: wirePayload.length,
            messageClass,
            payloadOffset: extension.length,
        });

        const replyPromise = this.awaitReply(cmdId, params.timeoutMs ?? 5000);
        this.socket.write(Buffer.concat([header, wirePayload]));
        const reply = await replyPromise;
        let body: Buffer = Buffer.alloc(0);
        if (reply.mainBody.length)
            body = params.encType === EncType.Bc ? bcXor(reply.mainBody, reply.chId) : this.aesDecrypt(reply.mainBody);
        return { statusCode: reply.statusCode, body };
    }

    private aesEncrypt(data: Buffer): Buffer {
        if (!this.aesKey)
            throw new Error('AES key not established (call login() first)');
        const cipher = crypto.createCipheriv('aes-128-cfb', this.aesKey, AES_IV);
        return Buffer.concat([cipher.update(data), cipher.final()]);
    }

    private aesDecrypt(data: Buffer): Buffer {
        if (!this.aesKey)
            throw new Error('AES key not established (call login() first)');
        const decipher = crypto.createDecipheriv('aes-128-cfb', this.aesKey, AES_IV);
        return Buffer.concat([decipher.update(data), decipher.final()]);
    }

    private nextMessId(): number {
        const id = this.messIdCounter;
        this.messIdCounter = (this.messIdCounter + 1) % 16777216;
        return id;
    }

    private awaitReply(cmdId: number, timeoutMs: number): Promise<BaichuanReply> {
        const { promise, resolve, reject } = Promise.withResolvers<BaichuanReply>();
        const entry: PendingEntry = {
            resolve,
            reject,
            timer: setTimeout(() => {
                const queue = this.pending.get(cmdId);
                if (queue) {
                    const idx = queue.indexOf(entry);
                    if (idx >= 0)
                        queue.splice(idx, 1);
                    if (queue.length === 0)
                        this.pending.delete(cmdId);
                }
                reject(new Error(`timed out waiting for cmd ${cmdId} reply from ${this.options.host}`));
            }, timeoutMs),
        };
        const queue = this.pending.get(cmdId);
        if (queue)
            queue.push(entry);
        else
            this.pending.set(cmdId, [entry]);
        return promise;
    }

    private dispatch(msg: BaichuanReply): void {
        const queue = this.pending.get(msg.cmdId);
        if (!queue || queue.length === 0) {
            this.log.warn(`baichuan: unsolicited reply for cmd ${msg.cmdId} (status ${msg.statusCode})`);
            return;
        }
        const entry = queue.shift()!;
        if (queue.length === 0)
            this.pending.delete(msg.cmdId);
        clearTimeout(entry.timer);
        entry.resolve(msg);
    }

    /** Parses complete messages out of `rx` as they accumulate. Reads the 4-byte magic, then
     *  cmdId/messLen/chId/messId/status+class; reads the extra payloadOffset field only when
     *  `hasPayloadOffsetField` says the class carries one -- true for every class this camera
     *  actually sends except the nonce reply (0x1466); see that function's comment for why this
     *  is not simply "only 0x1464" -- then reads `messLen` body bytes and splits it into the
     *  (still encrypted) extension and main body at `payloadOffset`. */
    private onData(chunk: Buffer): void {
        this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
        for (;;) {
            if (this.rx.length < 4)
                return;
            const magicIdx = this.rx.indexOf(HEADER_MAGIC);
            if (magicIdx !== 0) {
                if (magicIdx < 0) {
                    // Keep the last few bytes: a split magic could still complete on the next chunk.
                    this.rx = this.rx.subarray(Math.max(0, this.rx.length - (HEADER_MAGIC.length - 1)));
                    return;
                }
                this.log.warn(`baichuan: resynced past ${magicIdx} stray byte(s) before the header magic`);
                this.rx = this.rx.subarray(magicIdx);
            }

            // Fixed prefix through the class field: magic(4) + cmdId(4) + messLen(4) + chId(1) + messId(3) + status(2) + class(2).
            if (this.rx.length < 20)
                return;
            const messageClass = this.rx.readUInt16BE(18);
            const headerLength = hasPayloadOffsetField(messageClass) ? 24 : 20;
            if (this.rx.length < headerLength)
                return;
            const messLen = this.rx.readUInt32LE(8);
            const total = headerLength + messLen;
            if (this.rx.length < total)
                return;

            const cmdId = this.rx.readUInt32LE(4);
            const chId = this.rx.readUInt8(12);
            const statusCode = this.rx.readUInt16LE(16);
            const payloadOffset = hasPayloadOffsetField(messageClass) ? this.rx.readUInt32LE(20) : 0;
            const body = this.rx.subarray(headerLength, total);
            this.rx = this.rx.subarray(total);

            this.dispatch({ cmdId, chId, statusCode, mainBody: body.subarray(payloadOffset) });
        }
    }

    private fail(e: Error): void {
        if (this.closed)
            return;
        this.closed = true;
        this.rejectAllPending(e);
    }

    private rejectAllPending(e: Error): void {
        for (const queue of this.pending.values())
            for (const entry of queue) {
                clearTimeout(entry.timer);
                entry.reject(e);
            }
        this.pending.clear();
    }
}

// Reolink: the proprietary Baichuan protocol on TCP 9000.
//
// Reolink CAMERAS have no ONVIF backchannel — only their doorbells do (Scrypted's own plugin
// readme and Camera Support Report Card both say so), and no firmware will add it to an
// RLC-833A: v3.1.0.3016 is the last build for hardware IPC_523D88MP. See
// protocols/baichuan.ts for the framing and the two header rules that had to be traced.

import { ImaDviEncoder } from '../protocols/adpcm';
import { BaichuanClient, talkFullBlockSize } from '../protocols/baichuan';
import { DriverConfig, IntercomDriver, TalkFormat } from './driver';

/** Blocks per cmd 202 message. neolink groups four, which at this camera's block size is a
 * 256 ms message; one block (64 ms) is smoother to start and a quarter of the latency, and is
 * only viable because the ADPCM quantiser state now runs continuously across frames. */
const BLOCKS_PER_PAYLOAD = 1;

export class ReolinkDriver implements IntercomDriver {
    readonly name = 'reolink' as const;
    /** Measured: audio a person in the room hears clearly never appears in this camera's own
     * microphone stream, so it cancels its own speaker. */
    readonly echoCancels = true;
    readonly notes: string[] = [];

    private client?: BaichuanClient;
    /** One encoder per talk session: its quantiser state must run continuously across
     * frames, or every frame restarts at the smallest step and the tone pulses. */
    private encoder?: ImaDviEncoder;
    private fullBlockSize = 0;
    private talkFormat: TalkFormat = { sampleRate: 16000, pcmFrameBytes: 0 };

    constructor(private config: DriverConfig) { }

    get format(): TalkFormat {
        if (!this.talkFormat.pcmFrameBytes)
            throw new Error('reolink: format is only known after open()');
        return this.talkFormat;
    }

    async open(): Promise<void> {
        const client = new BaichuanClient({
            host: this.config.host,
            username: this.config.username,
            password: this.config.password,
            console: this.config.console,
        });
        await client.connect();
        await client.login();
        const ability = await client.getTalkAbility();
        await client.startTalk(ability);
        this.client = client;
        this.encoder = new ImaDviEncoder();

        // The single most important constant: half of lengthPerEncoder plus the 4-byte predictor
        // header. With the full lengthPerEncoder the camera accepts every packet and plays
        // SILENCE; with this it plays cleanly. neolink's own pipeline uses the same value.
        this.fullBlockSize = talkFullBlockSize(ability);
        const samplesPerBlock = (this.fullBlockSize - 4) * 2;
        this.talkFormat = {
            sampleRate: ability.sampleRate,
            pcmFrameBytes: samplesPerBlock * BLOCKS_PER_PAYLOAD * 2,
        };
        this.notes.push(
            `${ability.audioType} ${ability.sampleRate} Hz ${ability.soundTrack}, duplex `
            + `${ability.duplex}, lengthPerEncoder ${ability.lengthPerEncoder} -> ${this.fullBlockSize}-byte blocks`,
        );
    }

    async write(pcm: Buffer): Promise<void> {
        const client = this.client;
        if (!client)
            return;
        const encoded = this.encoder!.encode(pcm, this.fullBlockSize);
        const blocks: Buffer[] = [];
        for (let off = 0; off + this.fullBlockSize <= encoded.length; off += this.fullBlockSize)
            blocks.push(encoded.subarray(off, off + this.fullBlockSize));
        if (!blocks.length)
            return;
        // Awaited: this protocol acknowledges each message, and overlapping sends interleave.
        await client.sendTalkBlocks(blocks)
            .catch(e => this.config.console.warn('reolink: talk write failed:', e.message));
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = undefined;
        this.encoder = undefined;
        if (!client)
            return;
        await client.stopTalk().catch(e => this.config.console.warn('reolink: stopTalk failed:', e.message));
        client.close();
    }
}

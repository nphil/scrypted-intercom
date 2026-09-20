// Tapo: digest auth on port 8800, then G.711 A-law inside MPEG-TS under Tapo's private stream
// type 0x90. See protocols/tapoClient.ts for the auth-derivation trap that makes the first-party
// plugin 401 forever on some cameras.

import { TapoClient } from '../protocols/tapoClient';
import { linearToAlaw } from '../protocols/g711';
import { DriverConfig, IntercomDriver, TalkFormat } from './driver';

const PCMA_RATE = 8000;
/** 320 A-law bytes = 40 ms; PCM in is 2 bytes per sample. */
const ALAW_FRAME_BYTES = 320;

export class TapoDriver implements IntercomDriver {
    readonly name = 'tapo' as const;
    /** The C120s report `aec: 1` in getAudioSpec and demonstrably cannot hear their own speaker.
     * The C225 does not, but treating the whole vendor as echo-cancelling only costs a softer
     * self-test verdict, whereas getting it wrong the other way misdiagnoses a working camera. */
    readonly echoCancels = true;
    readonly notes: string[] = [];
    readonly format: TalkFormat = { sampleRate: PCMA_RATE, pcmFrameBytes: ALAW_FRAME_BYTES * 2 };

    private client?: TapoClient;

    constructor(private config: DriverConfig) { }

    async open(): Promise<void> {
        const cloudPassword = this.config.cloudPassword;
        if (!cloudPassword)
            throw new Error('tapo: the Tapo cloud password is not configured (the local camera '
                + 'account is not accepted by the talk endpoint)');
        const client = new TapoClient({
            host: this.config.host,
            cloudPassword,
            previousCloudPassword: this.config.previousCloudPassword || undefined,
            console: this.config.console,
        });
        await client.connect();
        const sessionId = await client.startTalk();
        client.writeAudio(client.muxHeader());
        this.client = client;
        this.notes.push(
            `talk session ${sessionId}; auth used ${client.auth.used} with the `
            + `${client.auth.password} cloud password, camera advertised ${client.auth.advertised}`,
        );
        if (client.auth.used !== client.auth.advertised) {
            this.notes.push('this camera advertises one password derivation and accepts the other; '
                + 'the fallback is what makes it work');
        }
    }

    async write(pcm: Buffer): Promise<void> {
        const client = this.client;
        if (!client)
            return;
        client.writeAudio(client.muxAudio(linearToAlaw(pcm)));
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = undefined;
        client?.close();
    }
}

/** ITU-T G.711 A-law encoder. Inline because it is a dozen lines and keeps this plugin free of
 * audio dependencies. */

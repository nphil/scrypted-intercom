// The mixin device: attaches to a Tapo camera Scrypted already streams and provides an
// `Intercom` that works on models the first-party @scrypted/tapo plugin fails on.
//
// Two failure modes were measured on real hardware here, which is why this exists:
//
//   1. A Tapo C120 on firmware 1.4.3 answers its auth challenge with `encrypt_type="3"` -- the
//      flag that means "derive the digest password with SHA256" -- and then rejects the SHA256
//      secret, accepting only the MD5 one. Upstream reads that flag and trusts it
//      (`const useSHA256 = wwwAuthenticate.includes('encrypt_type="3"')`), so it always gets
//      401 on that camera. `tapoClient.ts` tries the advertised derivation and falls back.
//   2. A C120 on firmware 1.9.2 authenticates fine and then plays nothing, which is only
//      visible if you listen to the camera while talking to it -- the protocol reports success
//      either way. Hence the self-test.
//
// Audio path: ffmpeg transcodes whatever the caller speaks (HomeKit Opus/AAC-ELD, WebRTC Opus)
// to G.711 A-law at 8 kHz mono, which is then muxed into Tapo's private MPEG-TS stream type
// (0x90) and written to the open multipart stream, paced in real time.

import type {
    FFmpegInput, Intercom, MediaObject, MixinDeviceOptions, Setting, Settings, VideoCamera,
} from '@scrypted/sdk';
import { MixinDeviceBase, ScryptedMimeTypes } from '@scrypted/sdk';
import * as child_process from 'child_process';
import { sdk } from './sdkFix';
import { TapoClient } from './tapoClient';
import { TapoConfig } from './types';

const PCMA_RATE = 8000;
/** 320 A-law bytes = 40 ms at 8 kHz, matching what upstream emits per RTP packet. */
const FRAME_BYTES = 320;
/** Bound the queue so a bursty producer costs latency, not unbounded memory. */
const MAX_QUEUED_BYTES = PCMA_RATE;

export class TapoIntercomMixin extends MixinDeviceBase<VideoCamera & Partial<Settings>> implements Intercom {
    private client?: TapoClient;
    private ffmpeg?: child_process.ChildProcess;
    private pump?: Promise<void>;
    private stopping = false;
    private queue: Buffer[] = [];
    private queuedBytes = 0;

    constructor(options: MixinDeviceOptions<VideoCamera & Partial<Settings>>, private getConfig: () => TapoConfig) {
        super(options);
    }

    async startIntercom(media: MediaObject): Promise<void> {
        await this.stopIntercom();
        this.stopping = false;
        const config = this.getConfig();
        if (!config.cloudPassword)
            throw new Error('tapo: the Tapo cloud password is not configured on the Tapo Intercom plugin');
        const host = await this.resolveHost(config);
        const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);

        const client = new TapoClient({ ...config, host, console: this.console });
        await client.connect();
        const sessionId = await client.startTalk();
        this.client = client;
        this.console.log(
            `tapo: talk session ${sessionId} open (auth: used ${client.auth.used}, `
            + `camera advertised ${client.auth.advertised})`,
        );
        if (client.auth.used !== client.auth.advertised) {
            this.console.warn(
                'tapo: this camera advertises one password derivation and accepts the other; '
                + 'the fallback is what makes it work, and is why the first-party plugin 401s here',
            );
        }
        client.writeAudio(client.muxHeader());

        const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
        const inputArgs = ffmpegInput.inputArguments?.length ? ffmpegInput.inputArguments : ['-i', ffmpegInput.url!];
        const args = [
            '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
            ...inputArgs,
            '-vn', '-sn', '-dn', '-acodec', 'pcm_alaw', '-ar', String(PCMA_RATE), '-ac', '1',
            '-f', 'alaw', '-flush_packets', '1', 'pipe:1',
        ];
        this.console.log(`tapo: intercom ffmpeg: ${ffmpegPath} ${args.join(' ')}`);
        const proc = child_process.spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.ffmpeg = proc;
        proc.stderr?.resume(); // ffmpeg logs to stderr even on a clean run; nothing here is actionable.
        proc.on('exit', code => this.console.log(`tapo: intercom ffmpeg exited (code ${code})`));
        proc.stdout?.on('data', (chunk: Buffer) => {
            this.queue.push(chunk);
            this.queuedBytes += chunk.length;
            while (this.queuedBytes > MAX_QUEUED_BYTES && this.queue.length > 1)
                this.queuedBytes -= this.queue.shift()!.length;
        });

        this.pump = this.pumpAudio(client);
    }

    async stopIntercom(): Promise<void> {
        this.stopping = true;
        this.ffmpeg?.kill('SIGTERM');
        this.ffmpeg = undefined;
        const pump = this.pump;
        this.pump = undefined;
        await pump?.catch(e => this.console.warn('tapo: intercom pump failed:', e.message));
        this.queue = [];
        this.queuedBytes = 0;
        const client = this.client;
        this.client = undefined;
        if (!client)
            return;
        this.console.log(`tapo: talk session closing (${client.stats.partsSent} parts, ${client.stats.audioBytesSent} audio bytes)`);
        client.close();
    }

    override release(): void {
        this.stopIntercom().catch(e => this.console.warn('tapo: stopIntercom during release failed:', e.message));
        super.release();
    }

    /** Each camera's address comes from the camera device itself, so one plugin instance serves
     * every Tapo camera in the system: the credentials are per Tapo ACCOUNT (shared), but the
     * address is per device. The plugin-wide `cameraHost` setting is only a fallback for a
     * provider that does not expose an `ip` setting. Upstream resolves the address the same way. */
    private async resolveHost(config: TapoConfig): Promise<string> {
        try {
            const settings: Setting[] | undefined = await this.mixinDevice.getSettings?.();
            const ip = settings?.find(setting => setting.key === 'ip')?.value;
            if (typeof ip === 'string' && ip)
                return ip;
        } catch (e) {
            this.console.warn('tapo: could not read the camera\'s own ip setting:', (e as Error).message);
        }
        if (!config.host)
            throw new Error('tapo: no camera address — the camera exposes no `ip` setting and the '
                + 'plugin-wide Camera Address fallback is empty');
        return config.host;
    }

    /** A-law is 1 byte per sample, so the playback duration of a frame is exactly
     * FRAME_BYTES / 8000 seconds; the camera drops whatever arrives faster than that. */
    private async pumpAudio(client: TapoClient): Promise<void> {
        let nextDue = Date.now();
        while (!this.stopping) {
            if (this.queuedBytes < FRAME_BYTES) {
                const wait = Promise.withResolvers<void>();
                setTimeout(wait.resolve, 10);
                await wait.promise;
                continue;
            }
            client.writeAudio(client.muxAudio(this.take(FRAME_BYTES)));
            nextDue += (FRAME_BYTES / PCMA_RATE) * 1000;
            const slack = nextDue - Date.now();
            if (slack > 0) {
                const paced = Promise.withResolvers<void>();
                setTimeout(paced.resolve, slack);
                await paced.promise;
            } else if (slack < -1000) {
                nextDue = Date.now(); // fell far behind: restart the clock rather than burst
            }
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
}

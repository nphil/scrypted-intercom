// The mixin device: attaches to a Reolink camera Scrypted already streams (via the
// @scrypted/reolink plugin) and replaces its non-functional Intercom with one that actually
// works on this hardware.
//
// Why this exists: @scrypted/reolink implements `startIntercom` exclusively as an ONVIF audio
// backchannel, and gates the Intercom interface on its `useOnvifTwoWayAudio` setting. Reolink
// CAMERAS have no ONVIF backchannel -- only Reolink DOORBELLS do (Scrypted's own plugin readme
// and Camera Support Report Card both say so). On an RLC-833A the camera answers ONVIF
// `GetAudioOutputs` with an empty response and faults on `GetAudioDecoderConfigurations`, so
// with that setting on, Scrypted advertises Intercom, HomeKit shows a talk button, and
// `startIntercom` throws `ONVIF audio backchannel not found`. That is the whole bug.
//
// Reolink's actual talkback path is the proprietary Baichuan protocol on TCP 9000 (see
// baichuan.ts), which this mixin drives instead.

import type {
    FFmpegInput, Intercom, MediaObject, MixinDeviceOptions, VideoCamera,
} from '@scrypted/sdk';
import { MixinDeviceBase, ScryptedMimeTypes } from '@scrypted/sdk';
import * as child_process from 'child_process';
import { encodeImaDviBlocks } from './adpcm';
import { BaichuanClient, TalkAbility } from './baichuan';
import { sdk } from './sdkFix';
import { ReolinkConfig } from './types';

/** Blocks per cmd 202 message, matching neolink. */
const BLOCKS_PER_PAYLOAD = 4;
/** Stop queueing beyond this much audio so a bursty producer adds bounded latency. */
const MAX_QUEUED_SECONDS = 1;

export class ReolinkIntercomMixin extends MixinDeviceBase<VideoCamera> implements Intercom {
    private client?: BaichuanClient;
    private ffmpeg?: child_process.ChildProcess;
    private pump?: Promise<void>;
    private stopping = false;
    private pcm: Buffer[] = [];
    private pcmBytes = 0;

    constructor(options: MixinDeviceOptions<VideoCamera>, private getConfig: () => ReolinkConfig) {
        super(options);
    }

    async startIntercom(media: MediaObject): Promise<void> {
        await this.stopIntercom();
        this.stopping = false;
        const config = this.getConfig();
        const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);

        const client = new BaichuanClient({ ...config, console: this.console });
        await client.connect();
        await client.login();
        const ability = await client.getTalkAbility(config.channel);
        await client.startTalk(ability, config.channel);
        this.client = client;
        this.console.log(
            `reolink: talk session open (${ability.audioType} ${ability.sampleRate} Hz ${ability.soundTrack}, `
            + `duplex ${ability.duplex}, lengthPerEncoder ${ability.lengthPerEncoder})`,
        );

        const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
        const inputArgs = ffmpegInput.inputArguments?.length ? ffmpegInput.inputArguments : ['-i', ffmpegInput.url!];
        // The camera's ADPCM is fixed at its advertised sample rate, mono; whatever the caller
        // speaks (HomeKit Opus/AAC-ELD, WebRTC Opus) is transcoded to that here, and this
        // plugin does the ADPCM encoding itself so the block layout is under our control.
        const args = [
            '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
            ...inputArgs,
            '-vn', '-acodec', 'pcm_s16le', '-ar', String(ability.sampleRate), '-ac', '1',
            '-f', 's16le', '-flush_packets', '1', 'pipe:1',
        ];
        this.console.log(`reolink: intercom ffmpeg: ${ffmpegPath} ${args.join(' ')}`);
        const proc = child_process.spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.ffmpeg = proc;
        proc.stderr?.resume(); // ffmpeg logs to stderr even on a clean run; nothing here is actionable.
        proc.on('exit', code => this.console.log(`reolink: intercom ffmpeg exited (code ${code})`));

        const maxQueued = ability.sampleRate * 2 * MAX_QUEUED_SECONDS;
        proc.stdout?.on('data', (chunk: Buffer) => {
            this.pcm.push(chunk);
            this.pcmBytes += chunk.length;
            while (this.pcmBytes > maxQueued && this.pcm.length > 1) {
                this.pcmBytes -= this.pcm.shift()!.length;
            }
        });

        this.pump = this.pumpAudio(client, ability, config.channel);
    }

    async stopIntercom(): Promise<void> {
        this.stopping = true;
        this.ffmpeg?.kill('SIGTERM');
        this.ffmpeg = undefined;
        const pump = this.pump;
        this.pump = undefined;
        await pump?.catch(e => this.console.warn('reolink: intercom pump failed:', e.message));
        this.pcm = [];
        this.pcmBytes = 0;
        const client = this.client;
        this.client = undefined;
        if (!client)
            return;
        this.console.log(`reolink: talk session closing (${client.stats.payloadsSent} payloads, ${client.stats.blocksSent} blocks)`);
        await client.stopTalk(this.getConfig().channel).catch(e => this.console.warn('reolink: stopTalk failed:', e.message));
        client.close();
    }

    override release(): void {
        this.stopIntercom().catch(e => this.console.warn('reolink: stopIntercom during release failed:', e.message));
        super.release();
    }

    /** Encodes and sends in real time. The camera has no jitter buffer worth the name: it
     * acknowledges everything and silently discards whatever arrives faster than playback, so
     * each message is followed by exactly the playback duration of the audio it carried. */
    private async pumpAudio(client: BaichuanClient, ability: TalkAbility, channel: number): Promise<void> {
        // The single most important constant here: half of lengthPerEncoder, plus the 4-byte
        // predictor header. With the full lengthPerEncoder (1024) the camera accepts every
        // packet and plays SILENCE; with this value it plays cleanly. Measured on an RLC-833A,
        // and it is what neolink's own gstreamer pipeline uses (`adpcmenc blockalign=516`).
        const fullBlockSize = ability.lengthPerEncoder / 2 + 4;
        const samplesPerBlock = (fullBlockSize - 4) * 2;
        const pcmPerGroup = samplesPerBlock * BLOCKS_PER_PAYLOAD * 2;
        const groupSeconds = (samplesPerBlock * BLOCKS_PER_PAYLOAD) / ability.sampleRate;

        let nextDue = Date.now();
        while (!this.stopping) {
            if (this.pcmBytes < pcmPerGroup) {
                const wait = Promise.withResolvers<void>();
                setTimeout(wait.resolve, 20);
                await wait.promise;
                continue;
            }
            const pcm = this.take(pcmPerGroup);
            const encoded = encodeImaDviBlocks(pcm, fullBlockSize);
            const blocks: Buffer[] = [];
            for (let off = 0; off + fullBlockSize <= encoded.length; off += fullBlockSize)
                blocks.push(encoded.subarray(off, off + fullBlockSize));
            if (!blocks.length)
                continue;
            await client.sendTalkBlocks(blocks, channel);

            nextDue += groupSeconds * 1000;
            const slack = nextDue - Date.now();
            if (slack > 0) {
                const paced = Promise.withResolvers<void>();
                setTimeout(paced.resolve, slack);
                await paced.promise;
            } else if (slack < -groupSeconds * 4000) {
                nextDue = Date.now(); // fell far behind: restart the clock rather than burst
            }
        }
    }

    private take(bytes: number): Buffer {
        const parts: Buffer[] = [];
        let need = bytes;
        while (need > 0) {
            const head = this.pcm[0];
            if (head.length <= need) {
                parts.push(head);
                this.pcm.shift();
                need -= head.length;
            } else {
                parts.push(head.subarray(0, need));
                this.pcm[0] = head.subarray(need);
                need = 0;
            }
        }
        this.pcmBytes -= bytes;
        return parts.length === 1 ? parts[0] : Buffer.concat(parts);
    }
}

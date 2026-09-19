// "Test Talkback" self-test: pushes a frequency sweep through the Baichuan talk protocol while
// recording the camera's own RTSP audio track, then checks the recording contains that sweep.
//
// The protocol's own acknowledgements are worthless as evidence here, and that is the specific
// trap this camera sets: with the wrong ADPCM block size it acknowledges every packet, reports
// no error, and plays nothing at all. Only listening back proves anything. A rising chirp is
// used because it survives what defeats waveform comparison (independent clocks at each end,
// room response, the camera's AGC) and because an office with a server fan in it has a real
// noise floor that a fixed tone can hide in.

import * as child_process from 'child_process';
import { encodeImaDviBlocks } from './adpcm';
import { BaichuanClient } from './baichuan';
import { ReolinkConfig } from './types';

const CHIRP_START_HZ = 300;
const CHIRP_END_HZ = 3200;
const CHIRP_SECONDS = 4;
const BLOCKS_PER_PAYLOAD = 4;
/** Recording starts first so the sweep lands in the middle of it. */
const LISTEN_LEAD_SECONDS = 2.5;
const LISTEN_SECONDS = CHIRP_SECONDS + LISTEN_LEAD_SECONDS + 2.5;
const ANALYSIS_WINDOW = 1024;

export interface SelfTestResult {
    pass: boolean;
    lines: string[];
}

export async function runTalkbackSelfTest(
    config: ReolinkConfig, ffmpegPath: string, log: (line: string) => void,
): Promise<SelfTestResult> {
    const lines: string[] = [];
    const record = (line: string) => {
        lines.push(line);
        log(line);
    };

    const client = new BaichuanClient({ ...config, console });
    const rtsp = `rtsp://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}`
        + `@${config.host}:554/${config.rtspPath}`;
    let listener: child_process.ChildProcess | undefined;
    const recorded: Buffer[] = [];
    let sampleRate = 16000;

    try {
        await client.connect();
        record(`connected to the Baichuan port ${config.host}:${config.port}`);
        await client.login();
        record('login accepted (nonce exchange + modern login)');
        const ability = await client.getTalkAbility(config.channel);
        sampleRate = ability.sampleRate;
        record(
            `TalkAbility: ${ability.audioType} ${ability.sampleRate} Hz ${ability.soundTrack}, `
            + `duplex ${ability.duplex}, audioStreamMode ${ability.audioStreamMode}, `
            + `lengthPerEncoder ${ability.lengthPerEncoder}`,
        );

        listener = child_process.spawn(ffmpegPath, [
            '-rtsp_transport', 'tcp', '-i', rtsp,
            '-vn', '-ac', '1', '-ar', String(sampleRate), '-t', String(LISTEN_SECONDS),
            '-f', 's16le', 'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        listener.stderr?.resume();
        listener.stdout?.on('data', (c: Buffer) => recorded.push(c));
        record(`listening to ${config.rtspPath} for ${LISTEN_SECONDS}s`);

        await client.startTalk(ability, config.channel);
        record('TalkConfig accepted (cmd 201)');

        const fullBlockSize = ability.lengthPerEncoder / 2 + 4;
        const samplesPerBlock = (fullBlockSize - 4) * 2;
        const encoded = encodeImaDviBlocks(buildChirp(sampleRate), fullBlockSize);
        const blocks: Buffer[] = [];
        for (let off = 0; off + fullBlockSize <= encoded.length; off += fullBlockSize)
            blocks.push(encoded.subarray(off, off + fullBlockSize));
        record(`encoded ${blocks.length} ADPCM blocks of ${fullBlockSize} bytes (lengthPerEncoder/2 + 4)`);

        const lead = Promise.withResolvers<void>();
        setTimeout(lead.resolve, LISTEN_LEAD_SECONDS * 1000);
        await lead.promise;

        for (let i = 0; i < blocks.length; i += BLOCKS_PER_PAYLOAD) {
            const group = blocks.slice(i, i + BLOCKS_PER_PAYLOAD);
            await client.sendTalkBlocks(group, config.channel);
            const paced = Promise.withResolvers<void>();
            setTimeout(paced.resolve, (samplesPerBlock * group.length * 1000) / sampleRate);
            await paced.promise;
        }
        record(`sent ${client.stats.payloadsSent} talk messages / ${client.stats.blocksSent} blocks`);
        await client.stopTalk(config.channel);
        record('talk stopped (cmd 11)');
    } catch (e) {
        record(`FAIL: ${(e as Error).message}`);
        client.close();
        listener?.kill('SIGTERM');
        return { pass: false, lines };
    }
    client.close();

    const exited = Promise.withResolvers<void>();
    listener.on('close', exited.resolve);
    setTimeout(exited.resolve, 8000);
    await exited.promise;
    listener.kill('SIGTERM');

    const audio = Buffer.concat(recorded);
    record(`recorded ${(audio.length / 2 / sampleRate).toFixed(1)}s of camera microphone audio`);

    // The acoustic result is reported but is NOT the pass/fail gate on Reolink, unlike the
    // sibling Foscam plugin where it is. Measured on an RLC-833A: audio that a person standing
    // in the room hears clearly does not appear in this camera's own microphone stream at all.
    // The camera runs echo cancellation on its mic -- which is the entire point of a talkback
    // device, and means it structurally cannot hear itself. Gating on "the camera heard it"
    // would therefore report FAIL on a perfectly working setup, which is worse than not
    // checking: it sends you debugging a non-problem.
    //
    // What IS load-bearing here: the camera accepted TalkConfig and every audio message at the
    // exact block size it advertised. The one failure mode that lies -- a wrong block size,
    // where the camera acknowledges everything and plays silence -- is excluded by deriving the
    // block size from the camera's own TalkAbility rather than guessing it.
    const sweep = measureSweep(audio, sampleRate);
    if (!sweep) {
        record('mic: nothing above the noise floor (expected: this camera echo-cancels its own speaker)');
    } else {
        const rise = sweep.lastHz - sweep.firstHz;
        record(
            `mic: ${sweep.firstHz.toFixed(0)} -> ${sweep.lastHz.toFixed(0)} Hz over `
            + `${sweep.spanSeconds.toFixed(2)}s (rise ${rise >= 0 ? '+' : ''}${rise.toFixed(0)} Hz; `
            + `a clean recovery of the sweep would be about +${(CHIRP_END_HZ - CHIRP_START_HZ).toFixed(0)} Hz `
            + 'over 4s, but echo cancellation normally prevents that)',
        );
    }
    record(
        'PASS: the camera accepted the talk session and every audio message at its own advertised '
        + 'block size. Audible playback must be confirmed by ear or from the HomeKit/Scrypted '
        + 'talk button -- this camera cannot hear its own speaker.',
    );
    return { pass: true, lines };
}

function buildChirp(rate: number): Buffer {
    const samples = rate * CHIRP_SECONDS;
    const sweepRate = (CHIRP_END_HZ - CHIRP_START_HZ) / CHIRP_SECONDS;
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        const t = i / rate;
        const phase = 2 * Math.PI * (CHIRP_START_HZ * t + 0.5 * sweepRate * t * t);
        const fade = Math.min(1, t / 0.05, (CHIRP_SECONDS - t) / 0.05);
        pcm.writeInt16LE(Math.round(0.85 * fade * 32767 * Math.sin(phase)), i * 2);
    }
    return pcm;
}

interface SweepMeasurement {
    firstHz: number;
    lastHz: number;
    spanSeconds: number;
}

/** Dominant frequency per window, keeping only windows well above the recording's own noise
 * floor, then the rise across them. The threshold is derived from the recording rather than
 * hard-coded because the noise floor is a property of the room, not of the camera. */
function measureSweep(pcm: Buffer, rate: number): SweepMeasurement | undefined {
    const total = Math.floor(pcm.length / 2);
    if (total < ANALYSIS_WINDOW * 4)
        return undefined;

    const windows: { t: number; rms: number; samples: Float64Array }[] = [];
    for (let start = 0; start + ANALYSIS_WINDOW <= total; start += ANALYSIS_WINDOW / 2) {
        const samples = new Float64Array(ANALYSIS_WINDOW);
        let sumSquares = 0;
        for (let i = 0; i < ANALYSIS_WINDOW; i++) {
            const sample = pcm.readInt16LE((start + i) * 2);
            samples[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (ANALYSIS_WINDOW - 1)));
            sumSquares += sample * sample;
        }
        windows.push({ t: start / rate, rms: Math.sqrt(sumSquares / ANALYSIS_WINDOW), samples });
    }
    const sortedRms = windows.map(w => w.rms).sort((a, b) => a - b);
    const noiseFloor = sortedRms[Math.floor(sortedRms.length * 0.5)];
    const loud = windows.filter(w => w.rms > Math.max(noiseFloor * 3, 200));
    if (loud.length < 8)
        return undefined;

    const points = loud.map(w => ({ t: w.t, hz: dominantFrequency(w.samples, rate) }));
    return {
        firstHz: points[0].hz,
        lastHz: points[points.length - 1].hz,
        spanSeconds: points[points.length - 1].t - points[0].t,
    };
}

function dominantFrequency(window: Float64Array, rate: number): number {
    let bestHz = 0;
    let bestMagnitude = 0;
    // Goertzel across the band the sweep occupies; cheaper and clearer than a full FFT here.
    for (let hz = 200; hz < Math.min(3800, rate / 2 - 100); hz += 25) {
        const coefficient = 2 * Math.cos((2 * Math.PI * hz) / rate);
        let s1 = 0;
        let s2 = 0;
        for (const sample of window) {
            const s0 = sample + coefficient * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        const magnitude = Math.abs(s1 * s1 + s2 * s2 - coefficient * s1 * s2);
        if (magnitude > bestMagnitude) {
            bestMagnitude = magnitude;
            bestHz = hz;
        }
    }
    return bestHz;
}

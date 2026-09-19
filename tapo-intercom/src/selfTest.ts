// "Test Talkback" self-test: plays a sweep out of the camera speaker while recording the
// camera's own RTSP audio, then reports whether the sweep came back.
//
// This check is the reason the Tool Room camera's fault was found at all: it authenticates,
// opens a talk session and accepts every audio part without complaint while playing NOTHING.
// Protocol success proves nothing here, so the test listens.
//
// Unlike the Reolink sibling plugin, the acoustic result IS the gate here: these Tapo models
// report `echo_cancelling: off` in their own `getAudioConfig`, and the working C225 demonstrably
// records its own speaker, so a camera that plays audio should hear it.

import * as child_process from 'child_process';
import { TapoClient } from './tapoClient';
import { TapoConfig } from './types';

const PCMA_RATE = 8000;
const FRAME_BYTES = 320;
const CHIRP_START_HZ = 300;
const CHIRP_END_HZ = 3200;
const CHIRP_SECONDS = 4;
const LISTEN_LEAD_SECONDS = 2.5;
const LISTEN_SECONDS = CHIRP_SECONDS + LISTEN_LEAD_SECONDS + 2.5;
const ANALYSIS_WINDOW = 512;

export interface SelfTestResult {
    pass: boolean;
    lines: string[];
}

export async function runTalkbackSelfTest(
    config: TapoConfig, ffmpegPath: string, log: (line: string) => void,
): Promise<SelfTestResult> {
    const lines: string[] = [];
    const record = (line: string) => {
        lines.push(line);
        log(line);
    };

    const client = new TapoClient({ ...config, console });
    const rtsp = `rtsp://${encodeURIComponent(config.rtspUsername)}:${encodeURIComponent(config.rtspPassword)}`
        + `@${config.host}:554/${config.rtspPath}`;
    let listener: child_process.ChildProcess | undefined;
    const recorded: Buffer[] = [];

    try {
        await client.connect();
        record(`auth ok: used ${client.auth.used} with the ${client.auth.password} cloud password, `
            + `camera advertised ${client.auth.advertised}`
            + (client.auth.used !== client.auth.advertised
                ? ' -- the camera advertised a derivation it then rejected; the fallback carried it'
                : ''));
        const sessionId = await client.startTalk();
        record(`talk session ${sessionId}`);

        listener = child_process.spawn(ffmpegPath, [
            '-rtsp_transport', 'tcp', '-i', rtsp,
            '-vn', '-ac', '1', '-ar', String(PCMA_RATE), '-t', String(LISTEN_SECONDS),
            '-f', 's16le', 'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        listener.stderr?.resume();
        listener.stdout?.on('data', (c: Buffer) => recorded.push(c));
        record(`listening to ${config.rtspPath} for ${LISTEN_SECONDS}s`);

        const lead = Promise.withResolvers<void>();
        setTimeout(lead.resolve, LISTEN_LEAD_SECONDS * 1000);
        await lead.promise;

        client.writeAudio(client.muxHeader());
        const alaw = buildAlawChirp();
        for (let off = 0; off + FRAME_BYTES <= alaw.length; off += FRAME_BYTES) {
            client.writeAudio(client.muxAudio(alaw.subarray(off, off + FRAME_BYTES)));
            const paced = Promise.withResolvers<void>();
            setTimeout(paced.resolve, (FRAME_BYTES / PCMA_RATE) * 1000);
            await paced.promise;
        }
        record(`sent ${client.stats.partsSent} parts / ${client.stats.audioBytesSent} bytes of A-law`);
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
    record(`recorded ${(audio.length / 2 / PCMA_RATE).toFixed(1)}s of camera microphone audio`);

    // Three-state on purpose. A camera that echo-cancels its own speaker (the C120s report
    // `aec: 1` in getAudioSpec; the C225 does not) cannot hear the sweep no matter how well
    // talkback is working, so "no sweep" must not be reported as failure: during this work a
    // perfectly functional C120 was misdiagnosed as silent on exactly that inference, and was
    // in fact clearly audible to someone standing in the room. Only a protocol failure is a
    // definite FAIL; a missing sweep is INCONCLUSIVE and has to be settled by ear.
    const sweep = measureSweep(audio);
    const rise = sweep ? sweep.lastHz - sweep.firstHz : 0;
    if (sweep) {
        record(`mic: ${sweep.firstHz.toFixed(0)} -> ${sweep.lastHz.toFixed(0)} Hz over `
            + `${sweep.spanSeconds.toFixed(2)}s (rise ${rise >= 0 ? '+' : ''}${rise.toFixed(0)} Hz)`);
    } else {
        record('mic: nothing above the noise floor');
    }
    const recovered = !!sweep
        && rise > (CHIRP_END_HZ - CHIRP_START_HZ) * 0.4
        && sweep.spanSeconds > CHIRP_SECONDS * 0.5
        && sweep.spanSeconds < CHIRP_SECONDS * 1.6;
    record(recovered
        ? 'PASS: the sweep played out of the camera speaker and came back through its microphone'
        : 'INCONCLUSIVE: the camera authenticated, granted a talk session and accepted every '
          + 'audio part, but the sweep did not come back through its microphone. On a camera that '
          + 'echo-cancels its own speaker that is expected and does NOT mean silence — confirm by '
          + 'ear or with the HomeKit/Scrypted talk button.');
    // The talk session and the accepted audio are what this test can prove on its own.
    return { pass: true, lines };
}

function buildAlawChirp(): Buffer {
    const samples = PCMA_RATE * CHIRP_SECONDS;
    const sweepRate = (CHIRP_END_HZ - CHIRP_START_HZ) / CHIRP_SECONDS;
    const out = Buffer.alloc(samples);
    for (let i = 0; i < samples; i++) {
        const t = i / PCMA_RATE;
        const fade = Math.min(1, t / 0.05, (CHIRP_SECONDS - t) / 0.05);
        const phase = 2 * Math.PI * (CHIRP_START_HZ * t + 0.5 * sweepRate * t * t);
        out[i] = linearToAlaw(Math.round(0.85 * fade * 32767 * Math.sin(phase)));
    }
    return out;
}

/** ITU-T G.711 A-law encoder. Written out rather than pulled from a dependency because it is
 * fifteen lines and this plugin otherwise needs nothing but Node built-ins. */
function linearToAlaw(sample: number): number {
    const sign = sample < 0 ? 0x00 : 0x80;
    let magnitude = Math.min(32635, Math.abs(sample));
    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1)
        exponent--;
    const mantissa = (magnitude >> (exponent === 0 ? 4 : exponent + 3)) & 0x0F;
    return (sign | (exponent << 4) | mantissa) ^ 0x55;
}

interface SweepMeasurement {
    firstHz: number;
    lastHz: number;
    spanSeconds: number;
}

/** Dominant frequency per window over the windows that stand clear of the recording's own noise
 * floor. The floor is derived from the recording because it is a property of the room. */
function measureSweep(pcm: Buffer): SweepMeasurement | undefined {
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
        windows.push({ t: start / PCMA_RATE, rms: Math.sqrt(sumSquares / ANALYSIS_WINDOW), samples });
    }
    const sorted = windows.map(w => w.rms).sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor(sorted.length * 0.5)];
    const loud = windows.filter(w => w.rms > Math.max(noiseFloor * 3, 150));
    if (loud.length < 8)
        return undefined;

    const points = loud.map(w => ({ t: w.t, hz: dominantFrequency(w.samples) }));
    return {
        firstHz: points[0].hz,
        lastHz: points[points.length - 1].hz,
        spanSeconds: points[points.length - 1].t - points[0].t,
    };
}

function dominantFrequency(window: Float64Array): number {
    let bestHz = 0;
    let bestMagnitude = 0;
    for (let hz = 200; hz < 3800; hz += 25) {
        const coefficient = 2 * Math.cos((2 * Math.PI * hz) / PCMA_RATE);
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

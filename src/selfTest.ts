// One talkback self-test for every driver: play a sweep, record the camera's own audio, report
// whether the sweep came back.
//
// It exists because every device here will accept a talk session and every audio frame while
// playing absolute silence — a wrong ADPCM block size on one camera did exactly that, with no
// error anywhere. Protocol success proves nothing about sound.
//
// The verdict is three-state on purpose. A device that echo-cancels its own speaker (the Reolink,
// the Tapo C120s) cannot hear itself no matter how well talkback works, so "no sweep" from those
// is INCONCLUSIVE, never FAIL. During development a perfectly functional camera was misdiagnosed
// as silent on exactly that inference; only a protocol failure is a definite FAIL.

import * as child_process from 'child_process';
import { IntercomDriver } from './drivers/driver';

const CHIRP_START_HZ = 300;
const CHIRP_END_HZ = 3200;
const CHIRP_SECONDS = 4;
const LISTEN_LEAD_SECONDS = 2.5;
const LISTEN_SECONDS = CHIRP_SECONDS + LISTEN_LEAD_SECONDS + 2.5;
const ANALYSIS_WINDOW = 512;

export interface SelfTestOptions {
    driver: IntercomDriver;
    host: string;
    rtspUsername: string;
    rtspPassword: string;
    /** RTSP path to listen on; the vendors differ, so a few are tried in order. */
    rtspPaths?: string[];
    ffmpegPath: string;
    log: (line: string) => void;
}

export interface SelfTestResult {
    pass: boolean;
    lines: string[];
}

/** Listen paths worth trying, in order: Tapo, Foscam, Reolink, generic. */
const DEFAULT_RTSP_PATHS = ['stream1', 'videoMain', 'h264Preview_01_main', 'sub'];

export async function runTalkbackSelfTest(options: SelfTestOptions): Promise<SelfTestResult> {
    const { driver, host, ffmpegPath, log } = options;
    const lines: string[] = [];
    const record = (line: string) => {
        lines.push(line);
        log(line);
    };

    let listener: child_process.ChildProcess | undefined;
    const recorded: Buffer[] = [];
    let listenRate = 8000;

    try {
        await driver.open();
        record(`${driver.name} talk session open to ${host}`);
        for (const note of driver.notes)
            record(note);

        const format = driver.format;
        listenRate = format.sampleRate;
        const credentials = options.rtspUsername
            ? `${encodeURIComponent(options.rtspUsername)}:${encodeURIComponent(options.rtspPassword)}@`
            : '';
        const path = (options.rtspPaths ?? DEFAULT_RTSP_PATHS)[0];
        listener = child_process.spawn(ffmpegPath, [
            '-rtsp_transport', 'tcp', '-i', `rtsp://${credentials}${host}:554/${path}`,
            '-vn', '-ac', '1', '-ar', String(listenRate), '-t', String(LISTEN_SECONDS),
            '-f', 's16le', 'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        listener.stderr?.resume();
        listener.stdout?.on('data', (chunk: Buffer) => recorded.push(chunk));
        record(`listening on rtsp://${host}:554/${path} for ${LISTEN_SECONDS}s`);

        const lead = Promise.withResolvers<void>();
        setTimeout(lead.resolve, LISTEN_LEAD_SECONDS * 1000);
        await lead.promise;

        const pcm = buildChirp(format.sampleRate);
        const frameMs = (format.pcmFrameBytes / 2 / format.sampleRate) * 1000;
        let frames = 0;
        for (let off = 0; off + format.pcmFrameBytes <= pcm.length; off += format.pcmFrameBytes) {
            await driver.write(pcm.subarray(off, off + format.pcmFrameBytes));
            frames++;
            const paced = Promise.withResolvers<void>();
            setTimeout(paced.resolve, frameMs);
            await paced.promise;
        }
        record(`sent ${frames} frames of ${format.pcmFrameBytes} PCM bytes at ${format.sampleRate} Hz`);
    } catch (e) {
        record(`FAIL: ${(e as Error).message}`);
        await driver.close().catch(() => undefined);
        listener?.kill('SIGTERM');
        return { pass: false, lines };
    }
    await driver.close().catch(e => record(`close warning: ${(e as Error).message}`));

    const exited = Promise.withResolvers<void>();
    listener.on('close', exited.resolve);
    setTimeout(exited.resolve, 8000);
    await exited.promise;
    listener.kill('SIGTERM');

    const audio = Buffer.concat(recorded);
    record(`recorded ${(audio.length / 2 / listenRate).toFixed(1)}s of the camera's own audio`);
    const sweep = measureSweep(audio, listenRate);
    if (sweep) {
        const rise = sweep.lastHz - sweep.firstHz;
        record(`mic: ${sweep.firstHz.toFixed(0)} -> ${sweep.lastHz.toFixed(0)} Hz over `
            + `${sweep.spanSeconds.toFixed(2)}s (rise ${rise >= 0 ? '+' : ''}${rise.toFixed(0)} Hz)`);
        const recovered = rise > (CHIRP_END_HZ - CHIRP_START_HZ) * 0.4
            && sweep.spanSeconds > CHIRP_SECONDS * 0.5
            && sweep.spanSeconds < CHIRP_SECONDS * 1.6;
        if (recovered) {
            record('PASS: the sweep played out of the speaker and came back through the microphone');
            return { pass: true, lines };
        }
    } else {
        record('mic: nothing above the noise floor');
    }

    if (driver.echoCancels) {
        record('INCONCLUSIVE: the device accepted the talk session and every audio frame, but it '
            + 'echo-cancels its own speaker, so its microphone cannot confirm playback. Check by '
            + 'ear or with the HomeKit/Scrypted talk button.');
        return { pass: true, lines };
    }
    record('FAIL: this device does not echo-cancel, so it should have heard the sweep and did not');
    return { pass: false, lines };
}

function buildChirp(rate: number): Buffer {
    const samples = rate * CHIRP_SECONDS;
    const sweepRate = (CHIRP_END_HZ - CHIRP_START_HZ) / CHIRP_SECONDS;
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        const t = i / rate;
        const fade = Math.min(1, t / 0.05, (CHIRP_SECONDS - t) / 0.05);
        const phase = 2 * Math.PI * (CHIRP_START_HZ * t + 0.5 * sweepRate * t * t);
        pcm.writeInt16LE(Math.round(0.85 * fade * 32767 * Math.sin(phase)), i * 2);
    }
    return pcm;
}

interface SweepMeasurement {
    firstHz: number;
    lastHz: number;
    spanSeconds: number;
}

/** Dominant frequency per window over the windows that stand clear of the recording's own noise
 * floor, which is derived from the recording because it is a property of the room. */
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
    const sorted = windows.map(w => w.rms).sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor(sorted.length * 0.5)];
    const loud = windows.filter(w => w.rms > Math.max(noiseFloor * 3, 150));
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
    // Goertzel across the sweep's band: cheaper and clearer here than a full FFT.
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

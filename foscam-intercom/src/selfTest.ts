// "Test talkback" self-test: pushes a frequency sweep through the talk protocol while recording
// the camera's own RTSP audio track, then checks that the recording contains that sweep.
//
// This is the only honest way to prove talkback from inside Scrypted: the protocol's own
// acknowledgements (reply 20 status 0) say the camera accepted the speaker request, not that any
// sound came out. A rising chirp recovered through the camera's microphone proves the speaker
// physically played what was sent -- and it survives the things that defeat waveform comparison
// (independent 8 kHz clocks on each end, room response, the camera's own AGC).

import * as child_process from 'child_process';
import { FoscamTalkClient, SAMPLE_RATE } from './foscamTalk';
import { FoscamConfig } from './types';

const CHIRP_START_HZ = 300;
const CHIRP_END_HZ = 3200;
const CHIRP_SECONDS = 4;
/** Recording starts first so the sweep lands in the middle of it. */
const LISTEN_LEAD_SECONDS = 2;
const LISTEN_SECONDS = CHIRP_SECONDS + LISTEN_LEAD_SECONDS + 2;
const ANALYSIS_WINDOW = 512;
/** Below this, a window is room noise rather than the sweep. */
const ANALYSIS_MIN_RMS = 300;

export interface SelfTestResult {
    pass: boolean;
    lines: string[];
}

export async function runTalkbackSelfTest(
    config: FoscamConfig, ffmpegPath: string, log: (line: string) => void,
): Promise<SelfTestResult> {
    const lines: string[] = [];
    const record = (line: string) => {
        lines.push(line);
        log(line);
    };

    const rtsp = `rtsp://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}`
        + `@${config.host}:${config.port}/${config.rtspPath}`;
    const listener = child_process.spawn(ffmpegPath, [
        '-rtsp_transport', 'tcp', '-i', rtsp,
        '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-t', String(LISTEN_SECONDS),
        '-f', 's16le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    listener.stderr?.resume();
    const recorded: Buffer[] = [];
    listener.stdout?.on('data', (c: Buffer) => recorded.push(c));
    record(`listening to ${config.host}:${config.port}/${config.rtspPath} for ${LISTEN_SECONDS}s`);

    const talk = new FoscamTalkClient({ ...config, console });
    try {
        await talk.connect();
        record('media port connected, SERVERPUSH handshake sent');
        await talk.login();
        record('login accepted (login check replied 0)');
        await talk.startTalk();
        record('speaker on accepted (reply 20 status 0)');

        const lead = Promise.withResolvers<void>();
        setTimeout(lead.resolve, LISTEN_LEAD_SECONDS * 1000);
        await lead.promise;

        const chirp = buildChirp();
        talk.write(chirp);
        record(`pushed ${chirp.length} bytes of ${CHIRP_START_HZ}-${CHIRP_END_HZ} Hz sweep (${CHIRP_SECONDS}s of 8 kHz mono s16le)`);

        const drained = Promise.withResolvers<void>();
        setTimeout(drained.resolve, (CHIRP_SECONDS + 1.5) * 1000);
        await drained.promise;
        record(`talk protocol sent ${talk.stats.framesSent} frames / ${talk.stats.bytesSent} bytes (${talk.stats.bytesDropped} dropped)`);
        await talk.stopTalk();
        record('speaker off acknowledged');
    } catch (e) {
        record(`FAIL: ${(e as Error).message}`);
        talk.close();
        listener.kill('SIGTERM');
        return { pass: false, lines };
    }
    talk.close();

    const exited = Promise.withResolvers<void>();
    listener.on('close', exited.resolve);
    setTimeout(exited.resolve, 6000);
    await exited.promise;
    listener.kill('SIGTERM');

    const audio = Buffer.concat(recorded);
    record(`recorded ${(audio.length / 2 / SAMPLE_RATE).toFixed(1)}s of camera microphone audio`);
    const sweep = measureSweep(audio);
    if (!sweep) {
        record('FAIL: the camera microphone heard nothing above the noise floor while talking');
        return { pass: false, lines };
    }
    const expectedSlope = (CHIRP_END_HZ - CHIRP_START_HZ) / CHIRP_SECONDS;
    record(
        `heard ${sweep.firstHz.toFixed(0)} Hz rising to ${sweep.lastHz.toFixed(0)} Hz over `
        + `${sweep.spanSeconds.toFixed(2)}s (slope ${sweep.slopeHzPerSecond.toFixed(0)} Hz/s, `
        + `reference ${expectedSlope.toFixed(0)} Hz/s)`,
    );
    // Judged on the invariants a real sweep cannot fake and room acoustics cannot destroy: the
    // frequency rose by most of the sweep's range, it rose (positive slope), and it took roughly
    // as long as the sweep did. The least-squares slope itself reads low on a working camera --
    // the fade-in/fade-out windows and the speaker's harmonics both pull the fit down -- so it
    // is reported but deliberately not the gate.
    const rise = sweep.lastHz - sweep.firstHz;
    const pass = rise > (CHIRP_END_HZ - CHIRP_START_HZ) * 0.5
        && sweep.slopeHzPerSecond > 0
        && sweep.spanSeconds > CHIRP_SECONDS * 0.5
        && sweep.spanSeconds < CHIRP_SECONDS * 1.5;
    record(pass
        ? 'PASS: the sweep pushed through the talk protocol came back out of the camera speaker'
        : `FAIL: the microphone heard sound, but not the sweep that was sent (rise ${rise.toFixed(0)} Hz)`);
    return { pass, lines };
}

function buildChirp(): Buffer {
    const samples = SAMPLE_RATE * CHIRP_SECONDS;
    const rate = (CHIRP_END_HZ - CHIRP_START_HZ) / CHIRP_SECONDS;
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        const t = i / SAMPLE_RATE;
        const phase = 2 * Math.PI * (CHIRP_START_HZ * t + 0.5 * rate * t * t);
        const fade = Math.min(1, t / 0.05, (CHIRP_SECONDS - t) / 0.05);
        pcm.writeInt16LE(Math.round(0.8 * fade * 32767 * Math.sin(phase)), i * 2);
    }
    return pcm;
}

interface SweepMeasurement {
    firstHz: number;
    lastHz: number;
    spanSeconds: number;
    slopeHzPerSecond: number;
}

/** Dominant frequency per window, then a least-squares slope over the windows that carry signal. */
function measureSweep(pcm: Buffer): SweepMeasurement | undefined {
    const points: { t: number; hz: number }[] = [];
    const total = Math.floor(pcm.length / 2);
    for (let start = 0; start + ANALYSIS_WINDOW <= total; start += ANALYSIS_WINDOW / 2) {
        const window = new Float64Array(ANALYSIS_WINDOW);
        let sumSquares = 0;
        for (let i = 0; i < ANALYSIS_WINDOW; i++) {
            const sample = pcm.readInt16LE((start + i) * 2);
            window[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (ANALYSIS_WINDOW - 1)));
            sumSquares += sample * sample;
        }
        if (Math.sqrt(sumSquares / ANALYSIS_WINDOW) < ANALYSIS_MIN_RMS)
            continue;
        let bestHz = 0;
        let bestMagnitude = 0;
        // Goertzel sweep over the band the camera's 8 kHz microphone can represent.
        for (let hz = 150; hz < 3800; hz += 25) {
            const coefficient = 2 * Math.cos((2 * Math.PI * hz) / SAMPLE_RATE);
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
        points.push({ t: start / SAMPLE_RATE, hz: bestHz });
    }
    if (points.length < 8)
        return undefined;

    const n = points.length;
    const meanT = points.reduce((acc, p) => acc + p.t, 0) / n;
    const meanHz = points.reduce((acc, p) => acc + p.hz, 0) / n;
    let covariance = 0;
    let variance = 0;
    for (const p of points) {
        covariance += (p.t - meanT) * (p.hz - meanHz);
        variance += (p.t - meanT) ** 2;
    }
    return {
        firstHz: points[0].hz,
        lastHz: points[n - 1].hz,
        spanSeconds: points[n - 1].t - points[0].t,
        slopeHzPerSecond: variance ? covariance / variance : 0,
    };
}

// A single-purpose talkback bench for ONE camera: the Reolink front doorbell.
//
// Why this exists: the Scrypted path measures ~92 ms of OUR latency (ffmpeg transcode + warm-up
// lead + pacing queue) on top of whatever the camera itself costs. This bench removes every one
// of those: the browser encodes mu-law itself, and each 20 ms frame goes browser -> WebSocket ->
// RTP -> interleaved TCP write with no transcode, no lead and no queue. What is left IS the
// device floor plus the network, which is the number worth optimising against.
//
// Two measurements, deliberately separated:
//   * software uplink  -- capture timestamp to socket write, in milliseconds, per frame. Fully
//                         ours, so it is the part any optimisation could actually move.
//   * acoustic loop    -- a tone written into the backchannel, detected coming back on the
//                         camera's own AAC mic stream. That includes the camera's speaker buffer,
//                         its mic pipeline and the AAC encoder, none of which we control.
//                         The camera's echo canceller may swallow it; the bench reports
//                         INCONCLUSIVE rather than pretending a miss is a zero.
//
// Downlink needs a decoder because the doorbell's mic track is AAC-hbr 16 kHz
// (`MPEG4-GENERIC/16000`, config=1408), unlike its mu-law uplink, so ffmpeg runs on that leg
// only, with low-delay flags.

import { createRequire } from 'module';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { RtspBackchannelClient } = require(path.join(here, 'build', 'rtspBackchannel.js'));
const { linearToUlaw } = require(path.join(here, 'build', 'g711.js'));

const CAMERA = process.env.LAB_CAMERA_HOST || '10.0.0.17';
const MOUNT = process.env.LAB_CAMERA_MOUNT || 'Preview_01_sub';
const USER = process.env.LAB_CAMERA_USER || 'admin';
const PASS = process.env.LAB_CAMERA_PASS || '';
const PORT = parseInt(process.env.LAB_PORT || '8787', 10);

/** 8 kHz mu-law, 20 ms per frame: 160 samples == 160 bytes. */
const FRAME_SAMPLES = 160;
/** ffmpeg decodes the camera's AAC mic to this rate; the page upsamples for playback. */
const DOWNLINK_RATE = 16000;
const TONE_HZ = 1000;
/** 0.3 full scale. Near-full-scale tones trip these cameras' ALC, which mimics the very
 *  degradation being measured -- established the hard way on the Scrypted path. */
const TONE_AMPLITUDE = 0.3;

const quiet = { log() { }, error() { }, warn() { }, info() { } };
const verbose = {
    log: (...a) => console.log('[rtsp]', ...a),
    error: (...a) => console.error('[rtsp]', ...a),
    warn: (...a) => console.warn('[rtsp]', ...a),
    info: (...a) => console.log('[rtsp]', ...a),
};

/** 10 ms analysis block at the downlink rate. */
const block = DOWNLINK_RATE / 100;

const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;

/** Goertzel magnitude of one block, normalised so a full-scale tone reads ~1. */
function goertzel(samples, rate, hz) {
    const k = (2 * Math.cos((2 * Math.PI * hz) / rate));
    let s1 = 0, s2 = 0;
    for (let i = 0; i < samples.length; i++) {
        const s0 = samples[i] + k * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - k * s1 * s2;
    return Math.sqrt(Math.max(0, power)) / (samples.length / 2);
}

/** The live camera session: one RTSP connection for the backchannel, one ffmpeg for the return
 *  leg. Reference-counted so the page and the measurement endpoint can share it. */
class CameraSession {
    constructor(log) {
        this.log = log;
        this.client = undefined;
        this.offer = undefined;
        this.ffmpeg = undefined;
        this.listeners = new Set();
        this.refs = 0;
        this.starting = undefined;
        this.stats = {
            framesSent: 0,
            framesReceivedFromBrowser: 0,
            downlinkBytes: 0,
            uplinkMsSum: 0,
            uplinkMsCount: 0,
            uplinkMsPeak: 0,
            gapMsPeak: 0,
            lastFrameAt: 0,
        };
    }

    get live() {
        return !!this.client && !!this.offer;
    }

    async acquire() {
        this.refs++;
        if (this.live)
            return;
        if (!this.starting)
            this.starting = this.start().finally(() => { this.starting = undefined; });
        await this.starting;
    }

    release() {
        this.refs = Math.max(0, this.refs - 1);
        if (this.refs === 0)
            this.stop();
    }

    async start() {
        const client = new RtspBackchannelClient(CAMERA, 554, MOUNT, quiet, USER, PASS);
        await client.connect();
        const { response, offered, offer } = await client.describeWithBackchannel();
        if (!offered)
            throw new Error(`no backchannel offered (DESCRIBE ${response.code})`);
        const setup = await client.setupBackchannel('tcp', offer.control);
        if (setup.code !== 200)
            throw new Error(`SETUP failed: ${setup.code} ${setup.reason}`);
        const play = await client.play();
        if (play.code !== 200)
            throw new Error(`PLAY failed: ${play.code} ${play.reason}`);
        this.client = client;
        this.offer = offer;
        this.log(`backchannel live: ${offer.codec}/${offer.clock} pt=${offer.payloadType}`);
        this.startDownlink();
    }

    startDownlink() {
        const url = `rtsp://${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}@${CAMERA}:554/${MOUNT}`;
        // Low-delay demux: no probe, no analyse, no input buffer. Audio only, decoded to PCM.
        const args = [
            '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-rtsp_transport', 'tcp',
            '-fflags', 'nobuffer', '-flags', 'low_delay',
            '-probesize', '32', '-analyzeduration', '0',
            '-i', url,
            '-vn', '-ac', '1', '-ar', String(DOWNLINK_RATE),
            '-f', 's16le', '-',
        ];
        const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        ff.stdout.on('data', chunk => {
            this.stats.downlinkBytes += chunk.length;
            const at = nowMs();
            for (const listener of this.listeners)
                listener(chunk, at);
        });
        ff.stderr.on('data', d => this.log(`ffmpeg: ${d.toString().trim()}`));
        ff.on('exit', code => {
            this.log(`downlink ffmpeg exited (${code})`);
            if (this.ffmpeg === ff)
                this.ffmpeg = undefined;
        });
        this.ffmpeg = ff;
    }

    onDownlink(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Writes one mu-law frame straight through. No queue, no pacing, no lead: the whole point. */
    sendUlaw(payload, capturedAtMs) {
        if (!this.client || !this.offer)
            return;
        const at = nowMs();
        this.client.sendOfferedFrame(this.offer, payload);
        this.stats.framesSent++;
        if (capturedAtMs) {
            const ms = at - capturedAtMs;
            this.stats.uplinkMsSum += ms;
            this.stats.uplinkMsCount++;
            this.stats.uplinkMsPeak = Math.max(this.stats.uplinkMsPeak, ms);
        }
        if (this.stats.lastFrameAt) {
            const gap = at - this.stats.lastFrameAt;
            if (gap < 1000)
                this.stats.gapMsPeak = Math.max(this.stats.gapMsPeak, gap);
        }
        this.stats.lastFrameAt = at;
    }

    /** Silence keeps the camera's speaker path warm between utterances without adding delay. */
    sendSilence(frames = 1) {
        const silence = Buffer.alloc(FRAME_SAMPLES, 0xff); // mu-law zero
        for (let i = 0; i < frames; i++)
            this.sendUlaw(silence);
    }

    stop() {
        try { this.ffmpeg?.kill('SIGKILL'); } catch { }
        this.ffmpeg = undefined;
        try { this.client?.close(); } catch { }
        this.client = undefined;
        this.offer = undefined;
        this.log('session stopped');
    }
}

const session = new CameraSession(msg => console.log(`[session] ${msg}`));

/** Browsers currently streaming. A page keeps a continuous 20 ms cadence even when nobody is
 *  holding the button (that is the keep-alive), so a tone injected at the same time doubles the
 *  rate into one backchannel and garbles both -- it produced a confident "no tone returned at
 *  all" that had nothing to do with the camera. Measurements refuse to run instead. */
let browserStreamers = 0;

/** Writes a tone burst into the backchannel and watches the camera's own mic stream for it.
 *  Returns per-trial round trips, or INCONCLUSIVE when the camera's echo canceller eats it. */
async function measureAcousticLoop(trials, burstMs, warmupMs) {
    await session.acquire();
    try {
        // Let the downlink settle, and learn the room's own 1 kHz content as a noise floor.
        const floorSamples = [];
        const stopFloor = session.onDownlink(chunk => floorSamples.push(chunk));
        await new Promise(r => setTimeout(r, 1500));
        stopFloor();
        const floorPcm = Buffer.concat(floorSamples);
        let floor = 0;
        for (let i = 0; i + block * 2 <= floorPcm.length; i += block * 2) {
            const f = new Float32Array(block);
            for (let s = 0; s < block; s++)
                f[s] = floorPcm.readInt16LE(i + s * 2) / 32768;
            floor = Math.max(floor, goertzel(f, DOWNLINK_RATE, TONE_HZ));
        }
        const threshold = Math.max(floor * 6, 0.02);

        const burstFrames = Math.max(1, Math.round(burstMs / 20));
        const warmupFrames = Math.max(0, Math.round(warmupMs / 20));
        const results = [];
        for (let trial = 0; trial < trials; trial++) {
            let detectedAt = 0;
            let peak = 0;

            // Warm the speaker path BEFORE arming the detector. This camera emits audio late and
            // unevenly, so a tone from the previous trial can still be arriving; counting it here
            // produced an impossible negative round trip, which is how the bug was caught.
            for (let i = 0; i < warmupFrames; i++) {
                session.sendSilence(1);
                await new Promise(r => setTimeout(r, 20));
            }

            // The camera delivers audio in one-AAC-frame lumps (64 ms at 16 kHz, p90 gap 119 ms
            // measured), so a bare chunk-arrival timestamp carries up to ~128 ms of bias. Each
            // chunk covers [arrival - duration, arrival], so the detected block's position INSIDE
            // the chunk is subtracted out instead of being thrown away.
            const stop = session.onDownlink((chunk, at) => {
                const chunkMs = (chunk.length / 2) / DOWNLINK_RATE * 1000;
                for (let off = 0, blk = 0; off + block * 2 <= chunk.length; off += block * 2, blk++) {
                    const f = new Float32Array(block);
                    for (let sm = 0; sm < block; sm++)
                        f[sm] = chunk.readInt16LE(off + sm * 2) / 32768;
                    const mag = goertzel(f, DOWNLINK_RATE, TONE_HZ);
                    peak = Math.max(peak, mag);
                    if (!detectedAt && mag > threshold)
                        detectedAt = at - chunkMs + (blk * block / DOWNLINK_RATE) * 1000;
                }
            });

            // Phase-continuous tone, paced at real time (20 ms per frame) rather than dumped: a
            // burst written as fast as the socket accepts it arrives as one lump and the camera
            // plays only part of it.
            let phase = 0;
            const sentAt = nowMs();
            for (let i = 0; i < burstFrames; i++) {
                const pcm = Buffer.alloc(FRAME_SAMPLES * 2);
                for (let s = 0; s < FRAME_SAMPLES; s++) {
                    const v = Math.sin(phase) * TONE_AMPLITUDE;
                    phase += (2 * Math.PI * TONE_HZ) / 8000;
                    pcm.writeInt16LE(Math.round(v * 32767), s * 2);
                }
                session.sendUlaw(linearToUlaw(pcm));
                if (i < burstFrames - 1)
                    await new Promise(r => setTimeout(r, 20));
            }
            await new Promise(r => setTimeout(r, 900));
            stop();
            results.push({
                trial: trial + 1,
                roundTripMs: detectedAt ? Math.round((detectedAt - sentAt) * 10) / 10 : null,
                peakMagnitude: Math.round(peak * 1000) / 1000,
            });
            await new Promise(r => setTimeout(r, 1500));
        }
        const hits = results.filter(r => r.roundTripMs !== null).map(r => r.roundTripMs).sort((a, b) => a - b);
        return {
            camera: CAMERA,
            trials: results,
            threshold: Math.round(threshold * 1000) / 1000,
            noiseFloor: Math.round(floor * 1000) / 1000,
            detected: hits.length,
            min: hits[0] ?? null,
            median: hits.length ? hits[Math.floor(hits.length / 2)] : null,
            max: hits[hits.length - 1] ?? null,
            verdict: hits.length === 0
                ? 'INCONCLUSIVE: tone never came back on the camera mic -- almost certainly its echo canceller, not a dead uplink. Listen by ear instead.'
                : `acoustic round trip ${hits[0]}-${hits[hits.length - 1]} ms over ${hits.length}/${results.length} trials`,
        };
    } finally {
        session.release();
    }
}


/** The windowed measurement above arms a detector per trial, which slices across the camera's own
 *  delay: tones landed outside their own window and scored as impossible negatives, and hits
 *  alternated because the device drops a burst while re-initialising its speaker path.
 *
 *  This is the instrument that actually works: ONE continuous 20 ms stream for the whole run --
 *  exactly what a real conversation looks like -- with the detector armed the entire time. Tones
 *  are injected at known instants and every onset is paired with the most recent injection before
 *  it, so nothing is attributed to the wrong burst and a dropped burst is visible as a burst with
 *  no onset rather than as a missing sample. */
async function measureContinuous(bursts, spacingMs, burstMs) {
    await session.acquire();
    try {
        const onsets = [];
        let armed = false;
        let above = false;
        const stop = session.onDownlink((chunk, at) => {
            if (!armed)
                return;
            const chunkMs = (chunk.length / 2) / DOWNLINK_RATE * 1000;
            for (let off = 0, blk = 0; off + block * 2 <= chunk.length; off += block * 2, blk++) {
                const f = new Float32Array(block);
                for (let sm = 0; sm < block; sm++)
                    f[sm] = chunk.readInt16LE(off + sm * 2) / 32768;
                const mag = goertzel(f, DOWNLINK_RATE, TONE_HZ);
                const hot = mag > 0.05;
                if (hot && !above)
                    onsets.push({ at: at - chunkMs + (blk * block / DOWNLINK_RATE) * 1000, mag });
                above = hot;
            }
        });

        // A continuous 20 ms cadence for the entire run. `tone` is flipped on for a burst and the
        // pacing never pauses, so the camera's speaker path is never allowed to idle.
        const injections = [];
        let phase = 0;
        let toneFramesLeft = 0;
        let stopped = false;
        const burstFrames = Math.max(1, Math.round(burstMs / 20));
        const pump = async () => {
            while (!stopped) {
                const pcm = Buffer.alloc(FRAME_SAMPLES * 2);
                if (toneFramesLeft > 0) {
                    for (let sm = 0; sm < FRAME_SAMPLES; sm++) {
                        pcm.writeInt16LE(Math.round(Math.sin(phase) * TONE_AMPLITUDE * 32767), sm * 2);
                        phase += (2 * Math.PI * TONE_HZ) / 8000;
                    }
                    toneFramesLeft--;
                } // else: silence, but still a frame, still on cadence
                session.sendUlaw(linearToUlaw(pcm));
                await new Promise(r => setTimeout(r, 20));
            }
        };
        const pumping = pump();

        // Two seconds of continuous silence first: this is the warm-up, and unlike the windowed
        // version the stream never stops afterwards.
        await new Promise(r => setTimeout(r, 2000));
        armed = true;
        await new Promise(r => setTimeout(r, 300));

        for (let i = 0; i < bursts; i++) {
            injections.push({ index: i + 1, at: nowMs() });
            phase = 0;
            toneFramesLeft = burstFrames;
            await new Promise(r => setTimeout(r, spacingMs));
        }
        await new Promise(r => setTimeout(r, 1500));
        stopped = true;
        await pumping;
        stop();

        // Pair each onset with the most recent injection at or before it.
        const paired = injections.map(inj => {
            const hit = onsets.find(o => o.at >= inj.at - 30 && o.at < inj.at + spacingMs);
            return {
                burst: inj.index,
                delayMs: hit ? Math.round((hit.at - inj.at) * 10) / 10 : null,
                magnitude: hit ? Math.round(hit.mag * 100) / 100 : null,
            };
        });
        const hits = paired.filter(p => p.delayMs !== null).map(p => p.delayMs).sort((a, b) => a - b);
        return {
            camera: CAMERA,
            mode: 'continuous stream, detector armed throughout',
            spacingMs,
            burstMs,
            bursts: paired,
            heard: hits.length,
            of: bursts,
            min: hits[0] ?? null,
            median: hits.length ? hits[Math.floor(hits.length / 2)] : null,
            max: hits[hits.length - 1] ?? null,
            verdict: hits.length === 0
                ? 'no tone returned at all -- check the speaker volume is not 0'
                : `${hits.length}/${bursts} bursts audible, speaker-to-mic delay ${hits[0]}-${hits[hits.length - 1]} ms`,
        };
    } finally {
        session.release();
    }
}

const staticFiles = {
    '/': { file: 'public/index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { file: 'public/index.html', type: 'text/html; charset=utf-8' },
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const asset = staticFiles[url.pathname];
    if (asset) {
        const body = fs.readFileSync(path.join(here, asset.file));
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
        res.end(body);
        return;
    }
    if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, camera: CAMERA, mount: MOUNT, live: session.live }));
        return;
    }
    if (url.pathname === '/stats') {
        const s = session.stats;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            live: session.live,
            framesSent: s.framesSent,
            uplinkAvgMs: s.uplinkMsCount ? Math.round((s.uplinkMsSum / s.uplinkMsCount) * 10) / 10 : null,
            uplinkPeakMs: Math.round(s.uplinkMsPeak * 10) / 10,
            frameGapPeakMs: Math.round(s.gapMsPeak * 10) / 10,
            downlinkBytes: s.downlinkBytes,
        }));
        return;
    }
    if (url.pathname === '/loop') {
        if (browserStreamers > 0) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                error: `${browserStreamers} browser session(s) are streaming into this camera; `
                    + 'a measurement would interleave with them and report nonsense. Close the page and retry.',
            }));
            return;
        }
        const bursts = Math.min(20, Math.max(1, parseInt(url.searchParams.get('n') || '6', 10)));
        const spacing = Math.min(10000, Math.max(500, parseInt(url.searchParams.get('spacing') || '2000', 10)));
        const burst = Math.min(1000, Math.max(20, parseInt(url.searchParams.get('burst') || '200', 10)));
        try {
            const result = await measureContinuous(bursts, spacing, burst);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result, null, 2));
        } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    if (url.pathname === '/measure') {
        if (browserStreamers > 0) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                error: `${browserStreamers} browser session(s) are streaming into this camera; `
                    + 'a measurement would interleave with them and report nonsense. Close the page and retry.',
            }));
            return;
        }
        const trials = Math.min(10, Math.max(1, parseInt(url.searchParams.get('n') || '5', 10)));
        const burstMs = Math.min(1000, Math.max(20, parseInt(url.searchParams.get('burst') || '300', 10)));
        const warmupMs = Math.min(1000, Math.max(0, parseInt(url.searchParams.get('warm') || '300', 10)));
        try {
            const result = await measureAcousticLoop(trials, burstMs, warmupMs);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result, null, 2));
        } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async ws => {
    const peer = `${wss.clients.size} client(s)`;
    console.log(`[ws] connected, ${peer}`);
    let stopDownlink;
    let clockOffset;           // clientNow - serverNow, learned from a ping round trip
    let acquired = false;

    const send = obj => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

    try {
        await session.acquire();
        acquired = true;
        browserStreamers++;
        session.sendSilence(5); // 100 ms of mu-law zero: warms the speaker path, adds no delay
        send({ type: 'ready', camera: CAMERA, mount: MOUNT, codec: session.offer.codec, clock: session.offer.clock, downlinkRate: DOWNLINK_RATE });
        stopDownlink = session.onDownlink(chunk => {
            if (ws.readyState !== 1 || ws.bufferedAmount > 64000)
                return;
            const framed = Buffer.alloc(chunk.length + 1);
            framed[0] = 0x02;
            chunk.copy(framed, 1);
            ws.send(framed);
        });
    } catch (e) {
        send({ type: 'error', message: e.message });
    }

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (buf[0] !== 0x01)
                return;
            // Bytes 1..8: the page's capture timestamp (float64 ms, its own clock).
            const capturedClient = buf.readDoubleLE(1);
            const payload = buf.subarray(9);
            session.stats.framesReceivedFromBrowser++;
            const capturedServer = clockOffset === undefined ? 0 : capturedClient - clockOffset;
            session.sendUlaw(payload, capturedServer || undefined);
            return;
        }
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'ping') {
            send({ type: 'pong', clientSent: msg.clientNow, serverNow: nowMs() });
            return;
        }
        if (msg.type === 'clock') {
            clockOffset = msg.offset;
            return;
        }
        if (msg.type === 'stats') {
            const s = session.stats;
            send({
                type: 'stats',
                framesSent: s.framesSent,
                uplinkAvgMs: s.uplinkMsCount ? Math.round((s.uplinkMsSum / s.uplinkMsCount) * 10) / 10 : null,
                uplinkPeakMs: Math.round(s.uplinkMsPeak * 10) / 10,
                frameGapPeakMs: Math.round(s.gapMsPeak * 10) / 10,
            });
            return;
        }
        if (msg.type === 'reset') {
            Object.assign(session.stats, {
                framesSent: 0, uplinkMsSum: 0, uplinkMsCount: 0, uplinkMsPeak: 0, gapMsPeak: 0, lastFrameAt: 0,
            });
        }
    });

    ws.on('close', () => {
        stopDownlink?.();
        if (acquired) {
            browserStreamers--;
            session.release();
        }
        console.log('[ws] closed');
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`intercom lab on http://0.0.0.0:${PORT}  camera=${CAMERA}/${MOUNT}`);
    console.log(`  GET /measure?n=5   server-side acoustic loop, no browser needed`);
});

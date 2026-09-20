// Measures STEADY-STATE talkback delay, which is what a caller actually experiences after the
// first word -- the earlier version measured session start (driver handshake + ffmpeg spawn +
// warm-up), which in HomeKit is paid while the user is still pressing the button.
//
// Both paths open a session, carry SILENCE for a few seconds, then emit a tone burst at a known
// offset within their own stream. The onset of that burst, relative to the same offset on the
// direct path, is the extra delay our pipeline holds in steady state. One shared recording, so
// the RTSP capture delay cancels.
import { BaichuanClient, talkFullBlockSize } from '/tmp/bcdirect/baichuan.js';
import { ImaDviEncoder } from '/tmp/bcdirect/adpcm.js';
import { connectScryptedClient } from '@scrypted/client';
import * as child_process from 'child_process';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const HOST = process.env.DOORBELL_HOST || '10.0.0.17';
const USER = process.env.DOORBELL_USER || 'admin';
const PASS = process.env.DOORBELL_PASS;
const MOUNT = process.env.DOORBELL_MOUNT || 'Preview_01_sub';
const CAMERA = process.env.DOORBELL_CAMERA || 'Front Door Camera';
const SILENCE_S = 3;   // carried inside each already-open session before the tone
const TONE_S = 1.2;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const wav = '/tmp/ab_steady.wav';
const rec = child_process.spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp',
    '-i', `rtsp://${USER}:${PASS}@${HOST}:554/${MOUNT}`,
    '-vn', '-ac', '1', '-ar', '16000', '-t', '20', '-f', 'wav', wav, '-y',
], { stdio: ['ignore', 'ignore', 'inherit'] });

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
let cam;
for (const id of Object.keys(sm.getSystemState())) {
    const d = sm.getDeviceById(id);
    if (d?.name === CAMERA) cam = d;
}

// ---- Path A: direct. Session opens, silence flows, then the tone at a known stream offset.
await sleep(1500);
const client = new BaichuanClient({ host: HOST, username: USER, password: PASS, console });
await client.connect();
await client.login();
const ability = await client.getTalkAbility();
const full = talkFullBlockSize(ability);
const samplesPerBlock = (full - 4) * 2;
const frameMs = samplesPerBlock / ability.sampleRate * 1000;
await client.startTalk(ability);
const encoder = new ImaDviEncoder();
const pcm = Buffer.alloc(samplesPerBlock * 2);
const directSessionStart = Date.now();
const directFrames = Math.round((SILENCE_S + TONE_S) * 1000 / frameMs);
let directToneAt;
for (let f = 0; f < directFrames; f++) {
    const streamTime = f * samplesPerBlock / ability.sampleRate;
    const toneNow = streamTime >= SILENCE_S;
    if (toneNow && directToneAt === undefined)
        directToneAt = Date.now();
    for (let i = 0; i < samplesPerBlock; i++) {
        const t = streamTime + i / ability.sampleRate;
        pcm.writeInt16LE(toneNow ? Math.round(0.8 * 32767 * Math.sin(2 * Math.PI * 1000 * t)) : 0, i * 2);
    }
    await client.sendTalkBlocks([encoder.encode(pcm, full)]);
    const slack = directSessionStart + (f + 1) * frameMs - Date.now();
    if (slack > 0) await sleep(slack);
}
client.close();
await sleep(2000);

// ---- Path B: the full Scrypted path, same stream shape via one lavfi expression.
const media = await sdk.mediaManager.createFFmpegMediaObject({
    inputArguments: ['-re', '-f', 'lavfi', '-i',
        `aevalsrc=0.8*sin(2*PI*1000*t)*gt(t\\,${SILENCE_S}):d=${SILENCE_S + TONE_S}:s=16000`],
});
const scryptedSessionStart = Date.now();
await cam.startIntercom(media);
// The tone sits at SILENCE_S inside the stream; note when that instant was produced, not when
// the session opened, so startup cost is excluded from the comparison.
const scryptedToneAt = scryptedSessionStart + SILENCE_S * 1000;
await sleep((SILENCE_S + TONE_S) * 1000 + 1500);
await cam.stopIntercom();

await new Promise(r => rec.on('exit', r));
console.log(JSON.stringify({
    wav,
    expectedGapMs: scryptedToneAt - directToneAt,
}));
process.exit(0);

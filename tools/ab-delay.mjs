// Fires two tones into ONE recording: a direct Baichuan send at t=2s, then the full Scrypted
// path at t=6s. Both share the same recording, so the RTSP capture delay and the recorder's
// connect time cancel: the difference between the two onsets, minus the 4s between triggers, is
// exactly what the Scrypted pipeline adds over talking to the device directly.
import { BaichuanClient, talkFullBlockSize } from '/tmp/bcdirect/baichuan.js';
import { ImaDviEncoder } from '/tmp/bcdirect/adpcm.js';
import { connectScryptedClient } from '@scrypted/client';
import * as child_process from 'child_process';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const HOST = '10.0.0.17', USER = 'admin', PASS = 'REDACTED';
const RTSP = `rtsp://${USER}:${PASS}@${HOST}:554/Preview_01_sub`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const wav = '/tmp/ab_delay.wav';
const rec = child_process.spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp',
    '-i', RTSP, '-vn', '-ac', '1', '-ar', '16000', '-t', '11', '-f', 'wav', wav, '-y',
], { stdio: ['ignore', 'ignore', 'inherit'] });

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
let cam;
for (const id of Object.keys(sm.getSystemState())) {
    const d = sm.getDeviceById(id);
    if (d?.name === 'Front Door Camera') cam = d;
}

// --- t=2s: direct, perfectly paced, nothing between us and the device
await sleep(2000);
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
const directStart = Date.now();
for (let f = 0; f < Math.round(1200 / frameMs); f++) {
    for (let i = 0; i < samplesPerBlock; i++) {
        const t = (f * samplesPerBlock + i) / ability.sampleRate;
        pcm.writeInt16LE(Math.round(0.8 * 32767 * Math.sin(2 * Math.PI * 1000 * t)), i * 2);
    }
    await client.sendTalkBlocks([encoder.encode(pcm, full)]);
    const slack = directStart + (f + 1) * frameMs - Date.now();
    if (slack > 0) await sleep(slack);
}
client.close();

// --- t=6s: the full Scrypted path (ffmpeg, warm-up, lead, pacing)
await sleep(6000 - (Date.now() - directStart) - 2000 + 2000);
const media = await sdk.mediaManager.createFFmpegMediaObject({
    inputArguments: ['-re', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1.2', '-af', 'volume=2.4'],
});
const scryptedTrigger = Date.now();
await cam.startIntercom(media);
await sleep(2000);
await cam.stopIntercom();

await new Promise(r => rec.on('exit', r));
console.log(JSON.stringify({
    wav,
    gapBetweenTriggersMs: scryptedTrigger - directStart,
}));
process.exit(0);

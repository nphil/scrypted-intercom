// End-to-end latency of the SCRYPTED (WebRTC) talkback path, measured against a direct send.
//
// Both events land in ONE recording of the camera's own RTSP audio, so the unknown capture delay
// (the camera's AAC encode plus the network hop) cancels:
//
//   event A: a tone sent straight to the camera over Baichuan, at a known wall-clock time.
//   event B: the same tone arriving through Chrome -> WebRTC -> Scrypted -> this plugin -> camera,
//            where Chrome's microphone is a FILE whose burst sits at a known offset from the
//            moment talkback is enabled.
//
// The difference between (onset - trigger) for B and A is what the whole Scrypted/WebRTC client
// path adds over talking to the device directly.
import { BaichuanClient, talkFullBlockSize } from '/tmp/bcdirect/baichuan.js';
import { ImaDviEncoder } from '/tmp/bcdirect/adpcm.js';
import * as child_process from 'child_process';

const HOST = process.env.CAM_HOST || '10.0.0.12';
const USER = process.env.CAM_USER || 'admin';
const PASS = process.env.CAM_PASS;
const MOUNT = process.env.CAM_MOUNT || 'h264Preview_01_sub';
const FILE_MIC_SILENCE_S = 2.0;   // matches /tmp/fakemic.wav
const sleep = ms => new Promise(r => setTimeout(r, ms));

const wav = '/tmp/lat_compare.wav';
const rec = child_process.spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp',
    '-i', `rtsp://${USER}:${PASS}@${HOST}:554/${MOUNT}`,
    '-vn', '-ac', '1', '-ar', '16000', '-t', '24', '-f', 'wav', wav, '-y',
], { stdio: ['ignore', 'ignore', 'inherit'] });
const recStarted = Date.now();

// ---- Event A: direct Baichuan tone.
await sleep(2500);
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
const directTrigger = Date.now();
for (let f = 0; f < Math.round(1500 / frameMs); f++) {
    for (let i = 0; i < samplesPerBlock; i++) {
        const t = (f * samplesPerBlock + i) / ability.sampleRate;
        pcm.writeInt16LE(Math.round(0.8 * 32767 * Math.sin(2 * Math.PI * 1000 * t)), i * 2);
    }
    await client.sendTalkBlocks([encoder.encode(pcm, full)]);
    const slack = directTrigger + (f + 1) * frameMs - Date.now();
    if (slack > 0) await sleep(slack);
}
client.close();

// Print the anchors immediately so the caller can trigger the WebRTC side while this still runs,
// then stay alive until the recorder finishes -- exiting early kills it and truncates the file.
console.log(JSON.stringify({
    wav,
    recStarted,
    directTrigger,
    fileMicSilenceMs: FILE_MIC_SILENCE_S * 1000,
}));
await new Promise(resolve => rec.on('exit', resolve));
console.log('recording complete');
process.exit(0);

// Measures talkback delay DIFFERENTIALLY, without needing anyone standing at the camera.
//
// Absolute mouth-to-speaker latency cannot be read this way: capturing the device's own audio
// over RTSP adds its own encode/network delay, which is unknown. But that delay is IDENTICAL
// whichever talk path is used, so comparing onsets between two drivers (or two settings) gives a
// real difference, and the change is what a decision needs.
//
// Method: start recording the device's RTSP audio, note a monotonic T0, trigger a tone burst
// through Scrypted, then find the tone's onset in the recording. Devices that echo-cancel
// attenuate their own speaker heavily, so a loud burst is used and the detector looks for energy
// specifically at the tone's frequency rather than for loudness.
//
//   SCRYPTED_URL=… SCRYPTED_USER=… SCRYPTED_PASS=… \
//     node tools/measure-delay.mjs "Front Door Camera" rtsp://user:pass@host:554/mount
import { connectScryptedClient } from '@scrypted/client';
import * as child_process from 'child_process';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const [cameraName, rtspUrl] = process.argv.slice(2);
const TONE_HZ = 1000;
const TONE_SECONDS = 1.5;
const RECORD_SECONDS = 8;
const LEAD_SILENCE_SECONDS = 2; // recording settles before the tone fires

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
let cam;
for (const id of Object.keys(sm.getSystemState())) {
    const d = sm.getDeviceById(id);
    if (d?.name === cameraName) cam = d;
}
if (!cam) {
    console.log(`${cameraName}: NOT FOUND`);
    process.exit(1);
}

const wav = `/tmp/delay_${Date.now()}.wav`;
const rec = child_process.spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp',
    '-i', rtspUrl, '-vn', '-ac', '1', '-ar', '16000', '-t', String(RECORD_SECONDS),
    '-f', 'wav', wav, '-y',
], { stdio: ['ignore', 'ignore', 'inherit'] });

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(LEAD_SILENCE_SECONDS * 1000);

// T0 is taken as late as possible before the audio actually starts flowing: right before
// startIntercom, whose own setup cost is part of what is being measured.
const t0 = Date.now();
const media = await sdk.mediaManager.createFFmpegMediaObject({
    inputArguments: ['-re', '-f', 'lavfi', '-i', `sine=frequency=${TONE_HZ}:duration=${TONE_SECONDS}`, '-af', 'volume=2.4'],
});
await cam.startIntercom(media);
await sleep(TONE_SECONDS * 1000 + 800);
await cam.stopIntercom();

await new Promise(resolve => rec.on('exit', resolve));
console.log(JSON.stringify({ wav, t0Offset: (t0 - (Date.now() - RECORD_SECONDS * 1000)) / 1000 }));
process.exit(0);

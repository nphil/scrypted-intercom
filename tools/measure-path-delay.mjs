// Measures how long after a trigger a tone is actually heard, for whichever driver the plugin is
// currently configured to use on a camera.
//
// The point is COMPARISON between talk protocols on the same device: a doorbell accepts both
// Baichuan ADPCM and the ONVIF backchannel, and those are separate audio pipelines inside the
// camera with their own buffering. Everything outside the device is identical between runs -- the
// same recorder, the same capture path, the same warm-up and lead -- so the difference between
// two runs is the device-side difference, which is the part no amount of work on this side can fix.
//
//   SCRYPTED_URL=… SCRYPTED_USER=… SCRYPTED_PASS=… CAM_PASS=… \
//     node tools/measure-path-delay.mjs "Front Door Camera" 10.0.0.17 Preview_01_sub
import { connectScryptedClient } from '@scrypted/client';
import * as child_process from 'child_process';

const [cameraName, host, mount] = process.argv.slice(2);
const USER = process.env.CAM_USER || 'admin';
const PASS = process.env.CAM_PASS;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    console.log(JSON.stringify({ error: `${cameraName} not found` }));
    process.exit(1);
}

const wav = '/tmp/path_delay.wav';
const rec = child_process.spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp',
    '-i', `rtsp://${USER}:${PASS}@${host}:554/${mount}`,
    '-vn', '-ac', '1', '-ar', '16000', '-t', '12', '-f', 'wav', wav, '-y',
], { stdio: ['ignore', 'ignore', 'inherit'] });
const recSpawned = Date.now();

await sleep(3500); // let the recorder connect and settle before the tone
// 0.3 FS: loud enough to detect, below the level where the camera's own ALC clamps.
const media = await sdk.mediaManager.createFFmpegMediaObject({
    inputArguments: ['-re', '-i', '/tmp/tone6s_soft.wav'],
});
const trigger = Date.now();
await cam.startIntercom(media);
await sleep(5000);
await cam.stopIntercom();

await new Promise(r => rec.on('exit', r));
console.log(JSON.stringify({ wav, recSpawned, trigger, triggerAfterSpawnMs: trigger - recSpawned }));
process.exit(0);

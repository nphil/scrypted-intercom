// End-to-end verification through Scrypted itself (not the protocol library in isolation):
//   * PanTiltZoom: snapshot, relative pan, snapshot, pan back -- the two snapshots must differ.
//   * Intercom: hand the camera device a real MediaObject (an ffmpeg lavfi frequency sweep) via
//     `startIntercom`, so the plugin's own ffmpeg transcode and talk pacing are what plays it.
//     Whoever runs this records the camera's RTSP audio alongside and checks for the sweep.
//
//   SCRYPTED_USER=… SCRYPTED_PASS=… node tools/verify.mjs [ptz|intercom|both]

import { connectScryptedClient } from '@scrypted/client';
import { writeFileSync } from 'fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const CAMERA_NAME = process.env.FOSCAM_CAMERA_NAME || 'Gym Camera';
const MODE = process.argv[2] || 'both';
const INTERCOM_SECONDS = Number(process.env.INTERCOM_SECONDS || 6);
// 300 Hz -> 3200 Hz over 4 s: phase = 2*pi*(300t + 362.5t^2).
const CHIRP_EXPR = "aevalsrc='0.8*sin(2*PI*(300*t+362.5*t*t))':s=8000:d=4";

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL || 'https://127.0.0.1:10443',
    pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER,
    password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;

let camera;
for (const id of Object.keys(sm.getSystemState())) {
    const device = sm.getDeviceById(id);
    if (device?.name === CAMERA_NAME)
        camera = device;
}
if (!camera)
    throw new Error(`no device named "${CAMERA_NAME}"`);
console.log(`camera ${camera.id} interfaces: ${(camera.interfaces || []).join(' ')}`);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

if (MODE === 'ptz' || MODE === 'both') {
    const snap = async (label) => {
        const media = await camera.takePicture({ reason: 'event' });
        const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
        writeFileSync(`/tmp/ptz-${label}.jpg`, jpeg);
        console.log(`snapshot ${label}: ${jpeg.length} bytes -> /tmp/ptz-${label}.jpg`);
        return jpeg;
    };
    await snap('before');
    console.log('ptzCommand { movement: Relative, pan: -0.5 }');
    await camera.ptzCommand({ movement: 'Relative', pan: -0.5 });
    await sleep(2500);
    await snap('after');
    console.log('ptzCommand { movement: Relative, pan: 0.5 } (returning)');
    await camera.ptzCommand({ movement: 'Relative', pan: 0.5 });
    await sleep(2500);
    await snap('returned');
}

if (MODE === 'intercom' || MODE === 'both') {
    const media = await sdk.mediaManager.createFFmpegMediaObject({
        inputArguments: ['-re', '-f', 'lavfi', '-i', CHIRP_EXPR],
    });
    console.log('startIntercom with a 300-3200 Hz lavfi sweep');
    await camera.startIntercom(media);
    await sleep(INTERCOM_SECONDS * 1000);
    await camera.stopIntercom();
    console.log('stopIntercom returned');
}
process.exit(0);

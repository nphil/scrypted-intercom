// Exercises every migrated camera through the merged plugin: startIntercom with a short tone,
// then a pan/tilt round trip where the camera advertises it. Reports per camera.
//   SCRYPTED_USER=… SCRYPTED_PASS=… node tools/verify.mjs "Camera A" "Camera B" …
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

for (const name of process.argv.slice(2)) {
    let cam;
    for (const id of Object.keys(sm.getSystemState())) {
        const d = sm.getDeviceById(id);
        if (d?.name === name) cam = d;
    }
    if (!cam) { console.log(`${name.padEnd(20)} NOT FOUND`); continue; }
    let talk = 'n/a', ptz = 'n/a';
    const media = await sdk.mediaManager.createFFmpegMediaObject({
        inputArguments: ['-re', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3'],
    });
    try {
        await cam.startIntercom(media);
        await sleep(3200);
        await cam.stopIntercom();
        talk = 'OK';
    } catch (e) {
        talk = `FAIL: ${e.message}`;
    }
    if ((cam.interfaces || []).includes('PanTiltZoom')) {
        try {
            await cam.ptzCommand({ movement: 'Relative', pan: 0.15 });
            await sleep(1200);
            await cam.ptzCommand({ movement: 'Relative', pan: -0.15 });
            ptz = 'OK';
        } catch (e) {
            ptz = `FAIL: ${e.message.slice(0, 60)}`;
        }
    }
    console.log(`${name.padEnd(20)} talk=${talk.padEnd(10)} ptz=${ptz}`);
    await sleep(1500);
}
process.exit(0);

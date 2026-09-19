// Plays a level-matched tone on each device in turn, for a listening judgement of quality.
//
// The tone is lifted 6.3x because lavfi's sine generates at about -18 dBFS: judging loudness or
// timbre with the raw generator measures the generator, not the pipeline. Devices are exercised
// strictly one at a time -- several of these cameras suppress their speaker while another talk
// session is open, which reads as a quality fault that is really an overlap.
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SECONDS = Number(process.env.SECONDS || 6);

for (const name of process.argv.slice(2)) {
    let cam;
    for (const id of Object.keys(sm.getSystemState())) {
        const d = sm.getDeviceById(id);
        if (d?.name === name) cam = d;
    }
    if (!cam) { console.log(`>>> ${name}: NOT FOUND`); continue; }

    const media = await sdk.mediaManager.createFFmpegMediaObject({
        inputArguments: ['-re', '-f', 'lavfi', '-i', `sine=frequency=1000:duration=${SECONDS}`, '-af', 'volume=6.3'],
    });
    console.log(`>>> ${name}: ${SECONDS}s tone`);
    try {
        await cam.startIntercom(media);
        await sleep(SECONDS * 1000 + 800);
        await cam.stopIntercom();
        console.log(`    ${name}: session completed`);
    } catch (e) {
        console.log(`    ${name}: FAILED ${e.message.slice(0, 100)}`);
    }
    await sleep(2500); // let each device's speaker path settle before the next session opens
}
process.exit(0);

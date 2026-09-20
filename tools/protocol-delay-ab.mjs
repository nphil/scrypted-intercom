// Which uplink protocol does a Reolink doorbell actually play SOONER?
//
// This exists because the doorbells were moved from Baichuan ADPCM to the ONVIF PCMU backchannel
// on the strength of OUR latency alone -- 20 ms frames instead of 64 ms, ~92 ms of pipeline delay
// instead of ~205 ms. That measured the right thing about the wrong half of the system: the
// device's own speaker path was never compared, and `tools/intercom-lab` later measured ~2.3 s of
// it on the backchannel, which is what an ear notices.
//
// Method: the plugin sends a real 1 kHz tone through whichever driver it is configured to use,
// while the bench LISTENS ONLY (`/listen`, no backchannel of its own, so there is exactly one
// writer). Delay is the onset in the camera's own microphone stream measured from the moment
// startIntercom resolves, minus the plugin's own reported startup. The downlink is common to both
// arms and runs ~100 ms ahead of real time, so it cancels out of the COMPARISON even though it
// inflates each absolute number.
//
// Usage: SCRYPTED_URL=... SCRYPTED_USER=... SCRYPTED_PASS=... node tools/protocol-delay-ab.mjs
//        [camera name] [lab base url]
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const CAMERA_NAME = process.argv[2] || 'Front Door Camera';
const LAB = process.argv[3] || 'http://127.0.0.1:8787';
const HOST = process.env.CAMERA_HOST || '10.0.0.17';
const TONE_SECONDS = 1;
const TRIALS = Number(process.env.TRIALS || 3);

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
const byName = n => {
    for (const id of Object.keys(sm.getSystemState())) {
        const d = sm.getDeviceById(id);
        if (d?.name === n) return d;
    }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cam = byName(CAMERA_NAME);
const ci = byName('Camera Intercom');
if (!cam || !ci)
    throw new Error(`could not find ${CAMERA_NAME} and/or the Camera Intercom plugin device`);

const originalOverrides = String((await ci.getSettings()).find(s => s.key === 'driverOverrides')?.value ?? '');
const otherLines = originalOverrides.split('\n').filter(l => l.trim() && !l.startsWith(HOST + '='));

/** Fires the tone and returns the wall-clock instant the plugin was asked to start talking. */
async function playTone() {
    const media = await sdk.mediaManager.createFFmpegMediaObject({
        inputArguments: ['-re', '-f', 'lavfi', '-i',
            `sine=frequency=1000:duration=${TONE_SECONDS}:samples_per_frame=160`, '-af', 'volume=2.4'],
    });
    const at = performance.now();
    await cam.startIntercom(media);
    return at;
}

async function measure(driver) {
    // `''` means: no override, let detection choose (which prefers the vendor protocol).
    await ci.putSetting('driverOverrides', [...otherLines, ...(driver ? [`${HOST}=${driver}`] : [])].join('\n'));
    await sleep(3000);

    const delays = [];
    for (let trial = 0; trial < TRIALS; trial++) {
        const listening = fetch(`${LAB}/listen?seconds=8`).then(r => r.json());
        await sleep(700); // let the listener's ffmpeg attach before any audio exists
        const sentAt = await playTone();
        await sleep(TONE_SECONDS * 1000 + 500);
        await cam.stopIntercom();
        const { onsets } = await listening;
        // The listener's clock starts when ITS request began; convert to "after startIntercom".
        const offset = sentAt - (performance.now() - 8000);
        const hit = onsets.find(o => o.atMs > offset - 200);
        delays.push(hit ? Math.round(hit.atMs - offset) : null);
        await sleep(2500);
    }
    return delays;
}

const results = {};
try {
    for (const driver of ['onvif-backchannel', 'reolink']) {
        results[driver] = await measure(driver);
        console.log(`${driver.padEnd(18)} delays(ms): ${results[driver].map(d => d ?? 'miss').join(', ')}`);
    }
} finally {
    await ci.putSetting('driverOverrides', originalOverrides);
    console.log('restored driverOverrides:', JSON.stringify(originalOverrides));
}
process.exit(0);

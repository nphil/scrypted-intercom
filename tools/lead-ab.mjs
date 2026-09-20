// A/B the lead buffer on one device: same tone, two lead settings, back to back.
//
// The lead is the only front-loaded latency the caller actually feels (the warm-up silence
// overlaps ffmpeg's startup), so this is the knob to tune by ear. A wired device on a quiet LAN
// should tolerate a much smaller lead than the conservative default.
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

const name = process.argv[2];
const leads = process.argv.slice(3).map(Number);
const cam = byName(name);
const ci = byName('Camera Intercom');
const seconds = Number(process.env.SECONDS || 5);
const originalLead = (await ci.getSettings()).find(s => s.key === 'leadMs')?.value;

for (const lead of leads) {
    await ci.putSetting('leadMs', String(lead));
    await sleep(2500); // let the plugin pick the setting up
    const media = await sdk.mediaManager.createFFmpegMediaObject({
        inputArguments: ['-re', '-f', 'lavfi', '-i', `sine=frequency=1000:duration=${seconds}:samples_per_frame=160`, '-af', 'volume=2.4'],
    });
    console.log(`>>> ${name}: lead ${lead} ms  (${seconds}s tone)`);
    await cam.startIntercom(media);
    await sleep(seconds * 1000 + 700);
    await cam.stopIntercom();
    console.log(`    lead ${lead} ms done`);
    await sleep(3000);
}
await ci.putSetting('leadMs', originalLead === undefined ? null : String(originalLead));
console.log('restored leadMs to', originalLead ?? '(default)');
process.exit(0);

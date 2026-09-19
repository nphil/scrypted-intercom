// A/B test: temporarily swap a camera from this plugin onto the first-party
// "Tapo Two Way Audio" mixin, try startIntercom, then restore whichever plugin the operator
// asked to end on. Fully reversible; used to confirm whether upstream can drive a given camera.
//   SCRYPTED_USER=… SCRYPTED_PASS=… TAPO_CAMERA_NAME="Bird Camera" node tools/ab_upstream.mjs
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const CAMERA = process.env.TAPO_CAMERA_NAME || 'Bird Camera';
const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
const byName = (n) => { for (const id of Object.keys(sm.getSystemState())) { const d = sm.getDeviceById(id); if (d?.name === n) return d; } };

const cam = byName(CAMERA);
const ours = byName('Tapo Intercom');
const upstream = byName('Tapo Two Way Audio');
if (!cam || !ours || !upstream) throw new Error('missing device or plugin');
const original = [...(cam.mixins || [])];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const tryTalk = async (label) => {
    const media = await sdk.mediaManager.createFFmpegMediaObject({
        inputArguments: ['-re', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=4'],
    });
    const fresh = sm.getDeviceById(cam.id);
    try {
        await fresh.startIntercom(media);
        await sleep(4000);
        await fresh.stopIntercom();
        console.log(`${label}: startIntercom RESOLVED`);
        return true;
    } catch (e) {
        console.log(`${label}: startIntercom THREW: ${e.message}`);
        return false;
    }
};

// swap to upstream only
const withUpstream = new Set(original);
withUpstream.delete(ours.id);
withUpstream.add(upstream.id);
await cam.setMixins([...withUpstream]);
await sleep(6000);
console.log('mixins now:', (sm.getDeviceById(cam.id).mixins || []).map(i => sm.getDeviceById(i)?.name).filter(n => /tapo/i.test(n || '')).join(', ') || '(none)');
const upstreamWorked = await tryTalk('UPSTREAM @scrypted/tapo');

// restore ours
await cam.setMixins(original);
await sleep(6000);
console.log('restored mixins:', (sm.getDeviceById(cam.id).mixins || []).map(i => sm.getDeviceById(i)?.name).filter(n => /tapo/i.test(n || '')).join(', '));
const oursWorked = await tryTalk('OURS tapo-intercom');
console.log(`\nRESULT  upstream=${upstreamWorked ? 'works' : 'FAILS'}  ours=${oursWorked ? 'works' : 'FAILS'}`);
process.exit(0);

// Moves this plugin's providers to the FRONT of each camera's mixin chain.
//
// Why this matters, and it is not cosmetic: a Scrypted mixin sees the device as it exists BELOW
// itself in the chain (`mixinDeviceInterfaces`). Consumers decide what to offer from that view:
// the WebRTC plugin negotiates its audio track as `sendrecv` only when it can see `Intercom`, and
// as `recvonly` otherwise. With our mixin applied last, WebRTC could not see it, so the Scrypted
// iOS app never offered the microphone at all -- silently, with no error anywhere. HomeKit was
// unaffected because it resolves the device by id, which yields the whole chain.
//
// So a capability PROVIDER belongs nearest the device, ahead of every consumer. Ordering is the
// only fix: re-enabling the vendors' own broken two-way flags would make the capability visible
// again, but it is exactly the dead capability this work removed.
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
const state = sm.getSystemState();
const val = (id, prop) => state[id]?.[prop]?.value;

const ours = Object.keys(state).filter(id => val(id, 'pluginId') === '@nphil/camera-intercom'
    && ['Camera Intercom', 'Vendor PTZ'].includes(val(id, 'name')));
if (!ours.length) {
    console.log('plugin devices not found');
    process.exit(1);
}

for (const name of process.argv.slice(2)) {
    const id = Object.keys(state).find(i => val(i, 'name') === name);
    if (!id) {
        console.log(`${name}: NOT FOUND`);
        continue;
    }
    const mixins = val(id, 'mixins') || [];
    const mine = ours.filter(o => mixins.includes(o));
    if (!mine.length) {
        console.log(`${name}: none of this plugin's mixins attached, skipping`);
        continue;
    }
    const reordered = [...mine, ...mixins.filter(m => !mine.includes(m))];
    if (reordered.join() === mixins.join()) {
        console.log(`${name}: already ordered correctly`);
        continue;
    }
    await sm.getDeviceById(id).setMixins(reordered);
    console.log(`${name}: moved ${mine.map(m => val(m, 'name')).join(' + ')} to the front`);
}
process.exit(0);

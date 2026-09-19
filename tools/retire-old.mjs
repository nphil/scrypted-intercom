// Removes the three superseded per-vendor intercom plugins, refusing to remove any that a device
// still uses as a mixin -- that check is the whole point: an orphaned mixin leaves a camera
// advertising Intercom that nothing implements, which is the failure mode this work started from.
//
// Reads the raw system state rather than device proxies: a proxy throws on *property access* once
// its id leaves the state map, and removing a plugin removes its devices, so the id set churns
// underneath this loop.
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL,
    pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER,
    password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
const RETIRE = ['Foscam Intercom + PTZ', 'Reolink Intercom', 'Tapo Intercom'];

const val = (state, id, prop) => state[id]?.[prop]?.value;

for (const name of RETIRE) {
    const state = sm.getSystemState();
    const pluginId = Object.keys(state).find(id => val(state, id, 'name') === name);
    if (!pluginId) {
        console.log(`${name}: already gone`);
        continue;
    }
    const pkg = val(state, pluginId, 'pluginId');

    const users = [];
    for (const id of Object.keys(state)) {
        if (id === pluginId)
            continue;
        if ((val(state, id, 'mixins') || []).includes(pluginId))
            users.push(`${val(state, id, 'name')} (mixin)`);
        else if (val(state, id, 'pluginId') === pkg)
            users.push(`${val(state, id, 'name')} (device)`);
    }
    if (users.length) {
        console.log(`${name}: REFUSING to remove, still used by: ${users.join(', ')}`);
        continue;
    }

    await sm.removeDevice(pluginId);
    console.log(`${name}: removed (${pkg})`);
}
process.exit(0);

// Presses the plugin's own "Test Pan/Tilt" and "Test Talkback" buttons over the Scrypted API and
// prints their results, then reloads the HomeKit plugin so an already-published accessory
// re-advertises now that the camera has gained the Intercom interface.
//
//   SCRYPTED_URL=https://<host>:10443 SCRYPTED_USER=… SCRYPTED_PASS=… node tools/selftest.mjs

import { connectScryptedClient } from '@scrypted/client';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PLUGIN_NAME = 'Foscam Intercom + PTZ';

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL || 'https://127.0.0.1:10443',
    pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER,
    password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;

let plugin;
for (const id of Object.keys(sm.getSystemState())) {
    const device = sm.getDeviceById(id);
    if (device?.name === PLUGIN_NAME)
        plugin = device;
}
if (!plugin)
    throw new Error(`${PLUGIN_NAME} is not installed`);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const readResult = async (key) => {
    const settings = await plugin.getSettings();
    return settings.find(s => s.key === key)?.value || '(empty)';
};

await plugin.putSetting('testPtz', '1');
await sleep(6000);
console.log(`--- lastPtzTest ---\n${await readResult('lastPtzTest')}`);

await plugin.putSetting('testTalkback', '1');
await sleep(22000); // the test records 8s of audio after a 2s lead-in
console.log(`--- lastTalkbackTest ---\n${await readResult('lastTalkbackTest')}`);

try {
    const plugins = await sm.getComponent('plugins');
    await plugins.reload('@scrypted/homekit');
    console.log('--- homekit plugin reloaded');
} catch (e) {
    console.log('homekit reload failed:', e.message);
}
process.exit(0);

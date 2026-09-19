// Configures the Foscam plugin and attaches its mixin to the Foscam camera device, then prints
// what Scrypted actually ended up with (interfaces, ptzCapabilities, plugin settings).
//
// Credentials come from the environment, never from this file:
//   SCRYPTED_USER=… SCRYPTED_PASS=… FOSCAM_USER=… FOSCAM_PASS=… \
//     node tools/configure.mjs
//
// Idempotent: re-running only re-applies settings and leaves existing mixins in place.

import { connectScryptedClient } from '@scrypted/client';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PLUGIN_NAME = 'Foscam Intercom + PTZ';
const CAMERA_NAME = process.env.FOSCAM_CAMERA_NAME || 'Gym Camera';
const SETTINGS = {
    cameraHost: process.env.FOSCAM_HOST || '192.168.4.143',
    cameraPort: process.env.FOSCAM_PORT || '88',
    cameraUsername: process.env.FOSCAM_USER,
    cameraPassword: process.env.FOSCAM_PASS,
    rtspPath: process.env.FOSCAM_RTSP_PATH || 'videoMain',
};

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL || 'https://127.0.0.1:10443',
    pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER,
    password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;

const byName = (name) => {
    for (const id of Object.keys(sm.getSystemState())) {
        const device = sm.getDeviceById(id);
        if (device?.name === name)
            return device;
    }
};

const plugin = byName(PLUGIN_NAME);
if (!plugin)
    throw new Error(`${PLUGIN_NAME} is not installed (deploy it first)`);
const camera = byName(CAMERA_NAME);
if (!camera)
    throw new Error(`no device named "${CAMERA_NAME}"`);
console.log(`plugin ${plugin.id} -> camera ${camera.id} (${CAMERA_NAME})`);

for (const [key, value] of Object.entries(SETTINGS)) {
    if (value === undefined)
        throw new Error(`missing value for ${key}`);
    await plugin.putSetting(key, value);
}

const mixins = new Set(camera.mixins || []);
mixins.add(plugin.id);
await camera.setMixins([...mixins]);
await new Promise(resolve => setTimeout(resolve, 4000)); // let the mixin attach

const fresh = sm.getDeviceById(camera.id);
console.log('interfaces     =', (fresh.interfaces || []).join(' '));
console.log('ptzCapabilities=', JSON.stringify(fresh.ptzCapabilities));
console.log('mixins         =', (fresh.mixins || []).map(id => sm.getDeviceById(id)?.name).join(' | '));
const settings = await plugin.getSettings();
for (const key of ['cameraHost', 'cameraPort', 'cameraUsername', 'rtspPath'])
    console.log(`${key.padEnd(15)}=`, settings.find(s => s.key === key)?.value);
process.exit(0);

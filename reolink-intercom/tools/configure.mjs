// Configures the Reolink Intercom plugin, attaches its mixin to the camera, and -- critically --
// turns OFF the @scrypted/reolink plugin's own `useOnvifTwoWayAudio` setting on that device.
//
// That last step is the actual bug fix. Reolink cameras have no ONVIF audio backchannel (only
// Reolink doorbells do), so with that setting on, the base device advertises an Intercom whose
// startIntercom always throws `ONVIF audio backchannel not found` -- which is exactly what
// HomeKit's dead talk button was wired to. Turning it off leaves this plugin's mixin as the only
// Intercom on the device.
//
//   SCRYPTED_USER=… SCRYPTED_PASS=… REOLINK_USER=… REOLINK_PASS=… node tools/configure.mjs

import { connectScryptedClient } from '@scrypted/client';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PLUGIN_NAME = 'Reolink Intercom';
const CAMERA_NAME = process.env.REOLINK_CAMERA_NAME || 'Office Camera';
const SETTINGS = {
    cameraHost: process.env.REOLINK_HOST || '192.168.1.103',
    cameraPort: process.env.REOLINK_PORT || '9000',
    cameraUsername: process.env.REOLINK_USER,
    cameraPassword: process.env.REOLINK_PASS,
    cameraChannel: process.env.REOLINK_CHANNEL || '0',
    rtspPath: process.env.REOLINK_RTSP_PATH || 'h264Preview_01_main',
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

// Disable the base plugin's broken ONVIF intercom before attaching ours.
const before = (await camera.getSettings()).find(s => s.key === 'useOnvifTwoWayAudio')?.value;
if (before === true || before === 'true') {
    await camera.putSetting('useOnvifTwoWayAudio', false);
    console.log('useOnvifTwoWayAudio: true -> false (its ONVIF backchannel does not exist)');
} else {
    console.log(`useOnvifTwoWayAudio already ${JSON.stringify(before)}`);
}

const mixins = new Set(camera.mixins || []);
mixins.add(plugin.id);
await camera.setMixins([...mixins]);
await new Promise(resolve => setTimeout(resolve, 5000)); // let the mixin attach

const fresh = sm.getDeviceById(camera.id);
console.log('interfaces =', (fresh.interfaces || []).join(' '));
console.log('mixins     =', (fresh.mixins || []).map(id => sm.getDeviceById(id)?.name).join(' | '));
console.log('intercom   =', (fresh.interfaces || []).includes('Intercom') ? 'advertised' : 'MISSING');
process.exit(0);

// Configures the Tapo Intercom plugin, attaches its mixin to a camera, and REMOVES the
// first-party "Tapo Two Way Audio" mixin from that camera.
//
// The removal matters: leaving both attached puts two Intercom implementations on one device,
// and the broken one can win. On the C120 at .201 the first-party mixin can never work, because
// it trusts the camera's `encrypt_type="3"` advertisement and that camera only accepts the
// MD5-derived secret.
//
//   SCRYPTED_USER=… SCRYPTED_PASS=… TAPO_CAMERA_NAME="Tool Room Camera" TAPO_HOST=192.168.4.174 \
//   TAPO_CLOUD_PASS=… TAPO_RTSP_USER=… TAPO_RTSP_PASS=… node tools/configure.mjs

import { connectScryptedClient } from '@scrypted/client';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PLUGIN_NAME = 'Tapo Intercom';
const UPSTREAM_MIXIN_NAME = 'Tapo Two Way Audio';
const CAMERA_NAME = process.env.TAPO_CAMERA_NAME;
if (!CAMERA_NAME)
    throw new Error('set TAPO_CAMERA_NAME');

const SETTINGS = {
    cameraHost: process.env.TAPO_HOST,
    cameraPort: process.env.TAPO_PORT || '8800',
    cloudPassword: process.env.TAPO_CLOUD_PASS,
    rtspUsername: process.env.TAPO_RTSP_USER,
    rtspPassword: process.env.TAPO_RTSP_PASS,
    rtspPath: process.env.TAPO_RTSP_PATH || 'stream1',
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

const upstream = byName(UPSTREAM_MIXIN_NAME);
const mixins = new Set(camera.mixins || []);
if (upstream && mixins.delete(upstream.id))
    console.log(`removed the "${UPSTREAM_MIXIN_NAME}" mixin (it cannot work on this camera)`);
mixins.add(plugin.id);
await camera.setMixins([...mixins]);
await new Promise(resolve => setTimeout(resolve, 5000)); // let the mixin attach

const fresh = sm.getDeviceById(camera.id);
console.log('interfaces =', (fresh.interfaces || []).join(' '));
console.log('mixins     =', (fresh.mixins || []).map(id => sm.getDeviceById(id)?.name).join(' | '));
console.log('intercom   =', (fresh.interfaces || []).includes('Intercom') ? 'advertised' : 'MISSING');
process.exit(0);

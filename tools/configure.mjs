// Applies vendor credentials to the Camera Intercom plugin and attaches its mixin to cameras,
// removing the per-vendor plugins' mixins from those cameras as it goes.
//
//   SCRYPTED_USER=… SCRYPTED_PASS=… node tools/configure.mjs "Camera A" "Camera B" …
// Credentials come from the environment: FOSCAM_USER/FOSCAM_PASS, REOLINK_USER/REOLINK_PASS,
// TAPO_CLOUD_PASS/TAPO_PREV_PASS, BACKCHANNEL_USER/BACKCHANNEL_PASS/BACKCHANNEL_PORT/BACKCHANNEL_PATH,
// SELFTEST_RTSP_USER/SELFTEST_RTSP_PASS.
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PLUGIN = 'Camera Intercom';
// Mixins wholly superseded by this plugin, safe to detach. NOT the Kibble Feeder mixin: it also
// provides ObjectDetector (the feeder's own detection feed), so detaching it would silently take
// object detection away with the intercom. Its Intercom is disabled in that plugin instead.
const SUPERSEDED = ['Foscam Intercom + PTZ', 'Reolink Intercom', 'Tapo Intercom'];

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
const byName = (name) => {
    for (const id of Object.keys(sm.getSystemState())) {
        const d = sm.getDeviceById(id);
        if (d?.name === name) return d;
    }
};

const plugin = byName(PLUGIN);
if (!plugin) throw new Error(`${PLUGIN} is not installed`);

const settings = {
    foscamUsername: process.env.FOSCAM_USER,
    foscamPassword: process.env.FOSCAM_PASS,
    reolinkUsername: process.env.REOLINK_USER,
    reolinkPassword: process.env.REOLINK_PASS,
    tapoCloudPassword: process.env.TAPO_CLOUD_PASS,
    tapoPreviousCloudPassword: process.env.TAPO_PREV_PASS,
    backchannelUsername: process.env.BACKCHANNEL_USER,
    backchannelPassword: process.env.BACKCHANNEL_PASS,
    backchannelRtspPort: process.env.BACKCHANNEL_PORT,
    backchannelRtspPath: process.env.BACKCHANNEL_PATH,
    selfTestRtspUsername: process.env.SELFTEST_RTSP_USER,
    selfTestRtspPassword: process.env.SELFTEST_RTSP_PASS,
    driverOverrides: process.env.DRIVER_OVERRIDES,
};
for (const [key, value] of Object.entries(settings))
    if (value !== undefined) await plugin.putSetting(key, value);
console.log('credentials applied');

for (const name of process.argv.slice(2)) {
    const cam = byName(name);
    if (!cam) { console.log(`${name}: NOT FOUND`); continue; }
    const mixins = new Set(cam.mixins || []);
    for (const old of SUPERSEDED) {
        const device = byName(old);
        if (device && mixins.delete(device.id))
            console.log(`${name}: removed "${old}" mixin`);
    }
    mixins.add(plugin.id);
    await cam.setMixins([...mixins]);
    await new Promise(r => setTimeout(r, 4000));
    const fresh = sm.getDeviceById(cam.id);
    console.log(`${name}: Intercom=${(fresh.interfaces || []).includes('Intercom')} `
        + `PanTiltZoom=${(fresh.interfaces || []).includes('PanTiltZoom')}`);
}
process.exit(0);

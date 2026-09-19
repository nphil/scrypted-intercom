// Turns OFF the ONVIF plugin's `onvifTwoWay` setting on Tapo cameras.
//
// Measured on all three cameras here (C225 and two C120s): ONVIF exposes NO audio output --
// GetAudioOutputs, GetAudioOutputConfigurations and GetAudioDecoderConfigurations all return
// empty, and RTSP DESCRIBE with `Require: www.onvif.org/ver20/backchannel` returns SDP identical
// to a plain DESCRIBE (no sendonly section). So the flag claims a capability that does not
// exist. Two-way audio on these cameras comes from the Tapo Intercom mixin instead.
//
// Leaving it on is how you get a talk button wired to a path that throws -- exactly the bug
// found on the Reolink in this same system.
//   SCRYPTED_USER=… SCRYPTED_PASS=… node tools/clear-onvif-twoway.mjs
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const CAMERAS = (process.env.TAPO_CAMERAS || 'Plant Room Camera,Bird Camera,Tool Room Camera').split(',');
const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;

for (const name of CAMERAS.map(n => n.trim())) {
    let cam;
    for (const id of Object.keys(sm.getSystemState())) {
        const d = sm.getDeviceById(id);
        if (d?.name === name)
            cam = d;
    }
    if (!cam) {
        console.log(`${name}: not found`);
        continue;
    }
    const before = (await cam.getSettings()).find(s => s.key === 'onvifTwoWay')?.value;
    if (before === undefined) {
        console.log(`${name}: no onvifTwoWay setting`);
        continue;
    }
    if (before === false || before === 'false') {
        console.log(`${name}: already false`);
        continue;
    }
    await cam.putSetting('onvifTwoWay', false);
    const after = (await cam.getSettings()).find(s => s.key === 'onvifTwoWay')?.value;
    console.log(`${name}: onvifTwoWay ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
}
process.exit(0);

// Plugin entry point: a MixinProvider supplying a working `Intercom` for Tapo cameras, plus its
// settings and an acoustic self-test.
//
// This replaces the first-party @scrypted/tapo two-way audio mixin, which must be REMOVED from
// any camera this is attached to (`tools/configure.mjs` does that): two Intercom implementations
// on one device is ambiguous, and the broken one may win.
//
// Why it is a replacement rather than a patch: upstream decides the digest password derivation
// by trusting the camera's own `encrypt_type="3"` flag. A C120 on firmware 1.4.3 advertises that
// flag and then only accepts the MD5-derived secret, so upstream 401s on it forever. This plugin
// tries the advertised derivation and falls back, and reports which one actually worked.
//
// No cloud contact is involved: the Tapo cloud password is hashed and verified locally by the
// camera on port 8800. The local "camera account" credentials are NOT accepted by that endpoint,
// which is why the cloud password is still required as a local secret.

import type {
    MixinProvider, ScryptedDeviceType, Setting, Settings, SettingValue, VideoCamera, WritableDeviceState,
} from '@scrypted/sdk';
import { ScryptedDeviceBase, ScryptedInterface } from '@scrypted/sdk';
import { TapoIntercomMixin } from './mixin';
import { sdk } from './sdkFix';
import { runTalkbackSelfTest } from './selfTest';
import { TapoClient } from './tapoClient';
import { TapoConfig } from './types';

const DEFAULTS: Record<string, string> = {
    cameraHost: '',
    cameraPort: '8800',
    cloudPassword: '',
    previousCloudPassword: '',
    rtspUsername: '',
    rtspPassword: '',
    rtspPath: 'stream1',
};

const SETTING_DEFS: Setting[] = [
    {
        key: 'cameraHost',
        title: 'Camera Address',
        description: 'IP or hostname of the Tapo camera.',
        type: 'string',
    },
    {
        key: 'cameraPort',
        title: 'Talk Port',
        description: "Tapo's talk endpoint. 8800 on every model seen.",
        type: 'number',
    },
    {
        key: 'cloudPassword',
        title: 'Tapo Cloud Password',
        description: 'Hashed and checked locally by the camera — nothing is sent to TP-Link. '
            + 'The local camera-account password does NOT work for talkback; this endpoint only '
            + 'accepts a hash of the cloud account password.',
        type: 'password',
    },
    {
        key: 'previousCloudPassword',
        title: 'Previous Tapo Cloud Password',
        description: 'Optional. Tried if the current password is rejected. Cameras adopt a '
            + 'password change at their own pace — after one rotation here, two cameras had the '
            + 'new password within minutes while a third still required the old one — so keeping '
            + 'the previous value here stops a rotation from breaking talkback on the stragglers. '
            + 'Clear it once every camera reports the current password.',
        type: 'password',
    },
    {
        key: 'rtspUsername',
        title: 'Camera Account Username',
        description: 'The local camera account (Tapo app → Advanced Settings → Camera Account). '
            + 'Used only by the self-test, to listen to the camera while talking to it.',
        type: 'string',
    },
    {
        key: 'rtspPassword',
        title: 'Camera Account Password',
        type: 'password',
    },
    {
        key: 'rtspPath',
        title: 'RTSP Path',
        description: 'Self-test listen-back path. stream1 is the main stream, stream2 the sub.',
        type: 'string',
        choices: ['stream1', 'stream2'],
    },
    {
        key: 'testTalkback',
        title: 'Test Talkback',
        description: 'Plays a 300-3200 Hz sweep out of the camera speaker while recording the '
            + "camera's own microphone, and checks the sweep comes back. Necessary because these "
            + 'cameras will accept a talk session and every audio packet while playing nothing. '
            + 'Takes about 15 seconds.',
        type: 'button',
        console: true,
    },
    {
        key: 'lastTalkbackTest',
        title: 'Last Talkback Test',
        readonly: true,
        type: 'textarea',
    },
];

class TapoIntercomPlugin extends ScryptedDeviceBase implements MixinProvider, Settings {
    async getSettings(): Promise<Setting[]> {
        return SETTING_DEFS.map(def => ({ ...def, value: this.storage.getItem(def.key!) ?? DEFAULTS[def.key!] }));
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'testTalkback') {
            this.runTalkbackTest()
                .catch((e: Error) => this.storage.setItem('lastTalkbackTest', `FAILED: ${e.message}`));
            return;
        }
        if (value === null || value === undefined)
            this.storage.removeItem(key);
        else
            this.storage.setItem(key, String(value));
    }

    async canMixin(type: ScryptedDeviceType | string, interfaces: string[]): Promise<string[] | undefined> {
        if (!interfaces.includes(ScryptedInterface.VideoCamera))
            return undefined;
        return [ScryptedInterface.Intercom];
    }

    async getMixin(
        mixinDevice: VideoCamera, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState,
    ): Promise<TapoIntercomMixin> {
        return new TapoIntercomMixin(
            { mixinDevice, mixinDeviceInterfaces, mixinDeviceState, mixinProviderNativeId: this.nativeId },
            () => this.getConfig(),
        );
    }

    async releaseMixin(id: string, mixinDevice: TapoIntercomMixin): Promise<void> {
        mixinDevice.release();
    }

    private getConfig(): TapoConfig {
        const get = (key: string) => this.storage.getItem(key) ?? DEFAULTS[key];
        return {
            host: get('cameraHost'),
            port: Number(get('cameraPort')),
            cloudPassword: get('cloudPassword'),
            previousCloudPassword: get('previousCloudPassword'),
            rtspUsername: get('rtspUsername'),
            rtspPassword: get('rtspPassword'),
            rtspPath: get('rtspPath'),
        };
    }

    private async runTalkbackTest(): Promise<void> {
        const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
        const result = await runTalkbackSelfTest(
            this.getConfig(), ffmpegPath, line => this.console.log(`tapo self-test: ${line}`),
        );
        this.storage.setItem('lastTalkbackTest', result.lines.join('\n'));
    }
}

export default TapoIntercomPlugin;

/** Re-exported so the protocol client is reachable from a debug console. */
export { TapoClient };

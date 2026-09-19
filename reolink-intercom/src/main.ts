// Plugin entry point: a MixinProvider that attaches a working Intercom to a Reolink camera
// Scrypted already has, plus the plugin-wide Settings and a live talkback self-test.
//
// IMPORTANT operational note, and the reason this plugin is not just "another Intercom": the
// @scrypted/reolink plugin's own `useOnvifTwoWayAudio` setting must be turned OFF on the camera.
// Reolink cameras (as opposed to doorbells) have no ONVIF audio backchannel, so that setting
// makes the base device advertise an Intercom whose `startIntercom` always throws
// `ONVIF audio backchannel not found`. Two Intercom implementations on one device is ambiguous
// and the broken one wins for whichever consumer resolves it first. `tools/configure.mjs`
// turns it off.
//
// `./sdkFix` is imported for its side effect; see that file for why every module here takes
// `sdk` from it rather than from `@scrypted/sdk` directly. Settings are hand-rolled against
// `this.storage` because the SDK's `storage-settings` helper destructures `systemManager` at its
// own module top level, before any fix can run.

import type {
    MixinProvider, ScryptedDeviceType, Setting, Settings, SettingValue, VideoCamera, WritableDeviceState,
} from '@scrypted/sdk';
import { ScryptedDeviceBase, ScryptedInterface } from '@scrypted/sdk';
import { BaichuanClient } from './baichuan';
import { ReolinkIntercomMixin } from './mixin';
import { sdk } from './sdkFix';
import { runTalkbackSelfTest } from './selfTest';
import { ReolinkConfig } from './types';

const DEFAULTS: Record<string, string> = {
    cameraHost: '192.168.1.103',
    cameraPort: '9000',
    cameraUsername: '',
    cameraPassword: '',
    cameraChannel: '0',
    rtspPath: 'h264Preview_01_main',
};

const SETTING_DEFS: Setting[] = [
    {
        key: 'cameraHost',
        title: 'Camera Address',
        description: 'IP or hostname of the Reolink camera.',
        type: 'string',
    },
    {
        key: 'cameraPort',
        title: 'Baichuan Port',
        description: "Reolink's proprietary protocol port. 9000 on every model seen.",
        type: 'number',
    },
    {
        key: 'cameraUsername',
        title: 'Username',
        type: 'string',
    },
    {
        key: 'cameraPassword',
        title: 'Password',
        type: 'password',
    },
    {
        key: 'cameraChannel',
        title: 'Channel',
        description: '0 for a standalone camera; the channel number behind an NVR.',
        type: 'number',
    },
    {
        key: 'rtspPath',
        title: 'RTSP Path',
        description: 'Used only by the talkback self-test, which listens to the camera while '
            + 'talking to it. The main stream carries audio; the sub stream may not.',
        type: 'string',
        choices: ['h264Preview_01_main', 'h264Preview_01_sub'],
    },
    {
        key: 'testTalkback',
        title: 'Test Talkback',
        description: 'Plays a 300-3200 Hz sweep out of the camera speaker while recording the '
            + "camera's own microphone, and checks the sweep comes back. This is the only check "
            + 'that proves audible playback: with the wrong ADPCM block size the camera '
            + 'acknowledges every packet and plays silence. Takes about 15 seconds.',
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

class ReolinkIntercomPlugin extends ScryptedDeviceBase implements MixinProvider, Settings {
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
    ): Promise<ReolinkIntercomMixin> {
        return new ReolinkIntercomMixin(
            { mixinDevice, mixinDeviceInterfaces, mixinDeviceState, mixinProviderNativeId: this.nativeId },
            () => this.getConfig(),
        );
    }

    async releaseMixin(id: string, mixinDevice: ReolinkIntercomMixin): Promise<void> {
        mixinDevice.release();
    }

    private getConfig(): ReolinkConfig {
        const get = (key: string) => this.storage.getItem(key) ?? DEFAULTS[key];
        return {
            host: get('cameraHost'),
            port: Number(get('cameraPort')),
            username: get('cameraUsername'),
            password: get('cameraPassword'),
            channel: Number(get('cameraChannel')),
            rtspPath: get('rtspPath'),
        };
    }

    private async runTalkbackTest(): Promise<void> {
        const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
        const result = await runTalkbackSelfTest(
            this.getConfig(), ffmpegPath, line => this.console.log(`reolink self-test: ${line}`),
        );
        this.storage.setItem('lastTalkbackTest', result.lines.join('\n'));
    }
}

export default ReolinkIntercomPlugin;

/** Re-exported so the protocol client is reachable from a debug console without importing the
 * bundle's internals. */
export { BaichuanClient };

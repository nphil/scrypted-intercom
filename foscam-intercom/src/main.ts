// Plugin entry point: a MixinProvider that attaches Intercom (two-way audio) and PanTiltZoom
// (pan/tilt) to a Foscam camera device Scrypted already has, plus the plugin-wide Settings that
// hold the camera's address and credentials and the two live self-tests.
//
// `./sdkFix` is imported for its side effect; see that file for why every module in this plugin
// must take `sdk` from it rather than from `@scrypted/sdk` directly. Settings are hand-rolled
// against `this.storage` for the same reason the Kibble plugin does it: the SDK's
// `storage-settings` helper destructures `systemManager` at its own module top level, before any
// fix can run.

import type {
    MixinProvider, ScryptedDeviceType, Setting, Settings, SettingValue, VideoCamera, WritableDeviceState,
} from '@scrypted/sdk';
import { ScryptedDeviceBase, ScryptedInterface } from '@scrypted/sdk';
import { FoscamCgiClient } from './foscamCgi';
import { FoscamMixin } from './mixin';
import { sdk } from './sdkFix';
import { runTalkbackSelfTest } from './selfTest';
import { FoscamConfig } from './types';

const DEFAULTS: Record<string, string> = {
    cameraHost: '192.168.4.143',
    cameraPort: '88',
    cameraUsername: '',
    cameraPassword: '',
    rtspPath: 'videoMain',
    speakerVolume: '100',
};

const SETTING_DEFS: Setting[] = [
    {
        key: 'cameraHost',
        title: 'Camera Address',
        description: 'IP or hostname of the Foscam camera.',
        type: 'string',
    },
    {
        key: 'cameraPort',
        title: 'Camera Port',
        description: 'Foscam web/media port (cmd=getPortInfo -> webPort/mediaPort). Both the CGI '
            + 'API and the low-level talk protocol are served here. Default 88.',
        type: 'number',
    },
    {
        key: 'cameraUsername',
        title: 'Username',
        description: 'A camera user with admin privilege; PTZ and talkback both require it.',
        type: 'string',
    },
    {
        key: 'cameraPassword',
        title: 'Password',
        type: 'password',
    },
    {
        key: 'rtspPath',
        title: 'RTSP Path',
        description: 'Only used by the talkback self-test, which listens to the camera while '
            + 'talking to it. videoMain or videoSub.',
        type: 'string',
        choices: ['videoMain', 'videoSub'],
    },
    {
        key: 'speakerVolume',
        title: 'Speaker Volume',
        description: 'Camera speaker volume (0-100), applied to the camera on save. Talkback '
            + 'playback level is set here, not by the caller.',
        type: 'number',
    },
    {
        key: 'testTalkback',
        title: 'Test Talkback',
        description: 'Pushes a 300-3200 Hz sweep to the camera speaker while recording the '
            + "camera's own microphone, and checks the sweep comes back. Proves audible playback, "
            + 'not just protocol acknowledgements. Takes about 10 seconds; result appears below.',
        type: 'button',
        console: true,
    },
    {
        key: 'lastTalkbackTest',
        title: 'Last Talkback Test',
        readonly: true,
        type: 'textarea',
    },
    {
        key: 'testPtz',
        title: 'Test Pan/Tilt',
        description: 'Pans left, then back right, then reads the preset list. Result appears below.',
        type: 'button',
        console: true,
    },
    {
        key: 'lastPtzTest',
        title: 'Last Pan/Tilt Test',
        readonly: true,
        type: 'textarea',
    },
];

class FoscamPlugin extends ScryptedDeviceBase implements MixinProvider, Settings {
    async getSettings(): Promise<Setting[]> {
        return SETTING_DEFS.map(def => ({ ...def, value: this.storage.getItem(def.key!) ?? DEFAULTS[def.key!] }));
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'testTalkback') {
            this.runTalkbackTest()
                .catch((e: Error) => this.storage.setItem('lastTalkbackTest', `FAILED: ${e.message}`));
            return;
        }
        if (key === 'testPtz') {
            this.runPtzTest()
                .catch((e: Error) => this.storage.setItem('lastPtzTest', `FAILED: ${e.message}`));
            return;
        }
        if (value === null || value === undefined)
            this.storage.removeItem(key);
        else
            this.storage.setItem(key, String(value));
        if (key === 'speakerVolume') {
            new FoscamCgiClient(this.getConfig()).setVolume(Number(value))
                .then(() => this.console.log(`foscam: speaker volume set to ${value}`))
                .catch((e: Error) => this.console.warn('foscam: could not set speaker volume:', e.message));
        }
    }

    async canMixin(type: ScryptedDeviceType | string, interfaces: string[]): Promise<string[] | undefined> {
        if (!interfaces.includes(ScryptedInterface.VideoCamera))
            return undefined;
        return [ScryptedInterface.Intercom, ScryptedInterface.PanTiltZoom];
    }

    async getMixin(
        mixinDevice: VideoCamera, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState,
    ): Promise<FoscamMixin> {
        return new FoscamMixin(
            { mixinDevice, mixinDeviceInterfaces, mixinDeviceState, mixinProviderNativeId: this.nativeId },
            () => this.getConfig(),
        );
    }

    async releaseMixin(id: string, mixinDevice: FoscamMixin): Promise<void> {
        mixinDevice.release();
    }

    private getConfig(): FoscamConfig {
        const get = (key: string) => this.storage.getItem(key) ?? DEFAULTS[key];
        return {
            host: get('cameraHost'),
            port: Number(get('cameraPort')),
            username: get('cameraUsername'),
            password: get('cameraPassword'),
            rtspPath: get('rtspPath'),
        };
    }

    private async runTalkbackTest(): Promise<void> {
        const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
        const result = await runTalkbackSelfTest(
            this.getConfig(), ffmpegPath, line => this.console.log(`foscam self-test: ${line}`),
        );
        this.storage.setItem('lastTalkbackTest', result.lines.join('\n'));
    }

    private async runPtzTest(): Promise<void> {
        const cgi = new FoscamCgiClient(this.getConfig());
        const lines: string[] = [];
        const step = async (label: string, action: () => Promise<unknown>) => {
            const outcome = await action().then(value => (value === undefined ? 'ok' : JSON.stringify(value)));
            lines.push(`${label}: ${outcome}`);
            this.console.log(`foscam ptz test: ${label}: ${outcome}`);
        };
        try {
            await step('pan left', () => cgi.move('Left'));
            const halted = Promise.withResolvers<void>();
            setTimeout(halted.resolve, 600);
            await halted.promise;
            await step('stop', () => cgi.stop());
            await step('pan right', () => cgi.move('Right'));
            const halted2 = Promise.withResolvers<void>();
            setTimeout(halted2.resolve, 600);
            await halted2.promise;
            await step('stop', () => cgi.stop());
            await step('presets', () => cgi.listPresets());
            lines.push('PASS: the camera accepted every pan/tilt command');
        } catch (e) {
            lines.push(`FAIL: ${(e as Error).message}`);
            await cgi.stop().catch(() => undefined);
        }
        this.storage.setItem('lastPtzTest', lines.join('\n'));
    }
}

export default FoscamPlugin;

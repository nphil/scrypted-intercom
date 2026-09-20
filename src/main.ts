// Camera Intercom: one plugin providing two-way audio for Foscam, Reolink, Tapo and any camera
// implementing a real ONVIF RTSP backchannel, plus pan/tilt where the vendor protocol carries it.
//
// It replaces three separate per-vendor plugins, which duplicated the whole Scrypted-facing half
// (ffmpeg, pacing, queue policy, self-test) three times and — worse — could each serve only ONE
// camera, because their host and credentials were plugin-wide settings.
//
// How configuration scales here instead:
//   * the camera's ADDRESS is read from the camera device itself (its `ip` setting, or the host
//     inside its RTSP url), so any number of cameras work;
//   * CREDENTIALS are per vendor account, which is how they actually exist in the world — one
//     Tapo account, one Foscam user, one Reolink user;
//   * the DRIVER is auto-detected by fingerprint, with a per-host override for the awkward cases.
//
// `./sdkFix` is imported for its side effect; every module takes `sdk` from it rather than from
// `@scrypted/sdk` directly. Settings are hand-rolled against `this.storage` because the SDK's
// `storage-settings` helper destructures `systemManager` at its own module top level, before any
// fix can run.

import type {
    DeviceProvider, MixinProvider, ScryptedDeviceType, Setting, Settings, SettingValue, VideoCamera,
    WritableDeviceState,
} from '@scrypted/sdk';
import { ScryptedDeviceBase, ScryptedDeviceType as DeviceType, ScryptedInterface } from '@scrypted/sdk';
import { detectDriver } from './detect';
import { DriverConfig, DriverName, IntercomDriver, isPtzCapable } from './drivers/driver';
import { FoscamDriver } from './drivers/foscam';
import { DEFAULT_KEEP_ALIVE_MS, OnvifBackchannelDriver } from './drivers/onvifBackchannel';
import { ReolinkDriver } from './drivers/reolink';
import { TapoDriver } from './drivers/tapo';
import { CameraIntercomMixin, DEFAULT_LEAD_MS, DEFAULT_WARMUP_MS } from './mixin';
import { VendorPtzMixin } from './ptzMixin';
import { sdk } from './sdkFix';
import { runTalkbackSelfTest } from './selfTest';

const DEFAULTS: Record<string, string> = {
    foscamUsername: '',
    foscamPassword: '',
    reolinkUsername: '',
    reolinkPassword: '',
    tapoCloudPassword: '',
    tapoPreviousCloudPassword: '',
    backchannelUsername: '',
    backchannelPassword: '',
    backchannelRtspPort: '8554',
    backchannelRtspPath: 'sub',
    backchannelKeepAliveMs: String(DEFAULT_KEEP_ALIVE_MS),
    driverOverrides: '',
    leadOverrides: '',
    backchannelOverrides: '',
    selfTestCamera: '',
    selfTestRtspUsername: '',
    selfTestRtspPassword: '',
};

const SETTING_DEFS: Setting[] = [
    {
        key: 'foscamUsername',
        title: 'Foscam Username',
        description: 'A camera user with admin privilege; talkback and pan/tilt both need it.',
        type: 'string',
        group: 'Foscam',
    },
    { key: 'foscamPassword', title: 'Foscam Password', type: 'password', group: 'Foscam' },
    {
        key: 'reolinkUsername',
        title: 'Reolink Username',
        type: 'string',
        group: 'Reolink',
    },
    { key: 'reolinkPassword', title: 'Reolink Password', type: 'password', group: 'Reolink' },
    {
        key: 'tapoCloudPassword',
        title: 'Tapo Cloud Password',
        description: 'Hashed and checked locally by the camera — nothing is sent to TP-Link. The '
            + 'local camera-account password is NOT accepted by the talk endpoint.',
        type: 'password',
        group: 'Tapo',
    },
    {
        key: 'tapoPreviousCloudPassword',
        title: 'Previous Tapo Cloud Password',
        description: 'Optional, tried if the current one is rejected. Cameras adopt a password '
            + 'change at their own pace — after one rotation here, two cameras had the new '
            + 'password within minutes while a third still needed the old one. Clear it once '
            + 'every camera reports the current password.',
        type: 'password',
        group: 'Tapo',
    },
    {
        key: 'backchannelUsername',
        title: 'Backchannel Username',
        description: 'For cameras with a real ONVIF RTSP backchannel. Leave blank if the device '
            + 'does not require RTSP credentials.',
        type: 'string',
        group: 'ONVIF Backchannel',
    },
    { key: 'backchannelPassword', title: 'Backchannel Password', type: 'password', group: 'ONVIF Backchannel' },
    {
        key: 'backchannelRtspPort',
        title: 'Backchannel RTSP Port',
        type: 'number',
        group: 'ONVIF Backchannel',
    },
    {
        key: 'backchannelRtspPath',
        title: 'Backchannel RTSP Path',
        description: 'Mount path offering the sendonly audio track.',
        type: 'string',
        group: 'ONVIF Backchannel',
    },
    {
        key: 'backchannelOverrides',
        title: 'Backchannel Mount Overrides',
        description: 'Optional, one per line as `host=port/path`, e.g. '
            + '`10.0.0.50=554/h264Preview_01_sub`. The RTSP mount offering the sendonly audio '
            + 'track differs per vendor, so a single global port/path can only serve one device. '
            + 'Needed to point a camera at the standards-based path when its vendor protocol is '
            + 'not the better choice: a Reolink doorbell offers PCMU/8000 here versus 16 kHz '
            + 'ADPCM over Baichuan, and G.711 is 8 bits per sample against ADPCM\'s 4, so the '
            + 'narrower path can be the cleaner one for speech.',
        type: 'textarea',
        group: 'ONVIF Backchannel',
    },
    {
        key: 'driverOverrides',
        title: 'Driver Overrides',
        description: 'Optional, one per line as `host=driver`, where driver is foscam, reolink, '
            + 'tapo or onvif-backchannel. Only needed when autodetection guesses wrong. Detection '
            + 'is by port fingerprint and prefers a vendor protocol where one exists, because on '
            + 'the hardware here the vendor path is the better one: a Reolink doorbell offers '
            + 'PCMU/8000 on its ONVIF backchannel but 16 kHz ADPCM over Baichuan. Set '
            + '`<host>=onvif-backchannel` to force the standards-based path.',
        type: 'textarea',
        group: 'Advanced',
    },
    {
        key: 'backchannelKeepAliveMs',
        title: 'Backchannel Keep-Alive (ms)',
        description: 'How long an ONVIF-backchannel session is held open after a talk session '
            + `ends, streaming silence on the same 20 ms cadence (default `
            + `${DEFAULT_KEEP_ALIVE_MS}; 0 tears down immediately, as before). Measured on the `
            + 'doorbells with `tools/intercom-lab`: letting the stream stop between utterances '
            + 'made only 4 of 8 bursts audible at all, while one unbroken cadence made 7 of 8 '
            + 'audible at a steady 163-280 ms. These cameras discard audio while their speaker '
            + 'path restarts, so the first word of every utterance after a pause is the cost of '
            + 'letting them idle. A held session also skips DESCRIBE/SETUP/PLAY next time.',
        type: 'number',
        group: 'Advanced',
    },
    {
        key: 'warmupMs',
        title: 'Warm-Up Silence (ms)',
        description: `Silence sent when a talk session opens, before any real audio (default `
            + `${DEFAULT_WARMUP_MS}). Devices drop audio while their speaker path comes up, and `
            + `this is what lands in that window instead of the caller's first words. Costs no `
            + `added latency: it overlaps the transcoder's own startup.`,
        type: 'number',
        group: 'Advanced',
    },
    {
        key: 'leadOverrides',
        title: 'Lead Buffer Overrides',
        description: 'Optional, one per line as `host=milliseconds`. The right lead depends on '
            + "the CALLER's network, not the camera's, but it is bounded by how much latency a "
            + 'given device is worth: a wired PoE doorbell answered from the Home app holds up at '
            + '120 ms where a wifi camera wants the default. Measured here: both Reolink '
            + 'doorbells are clean at 120 ms.',
        type: 'textarea',
        group: 'Advanced',
    },
    {
        key: 'leadMs',
        title: 'Lead Buffer (ms)',
        description: `Audio held before real frames start flowing, and re-earned after a source `
            + `stall (default ${DEFAULT_LEAD_MS}). This absorbs the lumpy first read from ffmpeg `
            + `and jitter from the caller's own network. It IS added latency, so it is the first `
            + `thing to trim for a wired device on a quiet LAN -- lower it until audio starts `
            + `breaking up, then go back one step.`,
        type: 'number',
        group: 'Advanced',
    },
    {
        key: 'selfTestCamera',
        title: 'Self-Test Camera',
        description: 'Name of the camera the Test Talkback button should use.',
        type: 'string',
        group: 'Self-Test',
    },
    {
        key: 'selfTestRtspUsername',
        title: 'Self-Test RTSP Username',
        description: "Credentials for listening to the camera's own audio while talking to it. "
            + 'For Tapo this is the local camera account, not the cloud password.',
        type: 'string',
        group: 'Self-Test',
    },
    { key: 'selfTestRtspPassword', title: 'Self-Test RTSP Password', type: 'password', group: 'Self-Test' },
    {
        key: 'testTalkback',
        title: 'Test Talkback',
        description: 'Plays a 300-3200 Hz sweep out of the named camera while recording its own '
            + 'microphone, and reports whether the sweep came back. Necessary because these '
            + 'devices will accept a talk session and every audio frame while playing nothing. '
            + 'On a camera that echo-cancels its own speaker the acoustic result is reported as '
            + 'INCONCLUSIVE rather than a failure.',
        type: 'button',
        console: true,
        group: 'Self-Test',
    },
    { key: 'lastTalkbackTest', title: 'Last Talkback Test', readonly: true, type: 'textarea', group: 'Self-Test' },
    {
        key: 'lastSessions',
        title: 'Recent Talk Sessions',
        description: 'Newest first. `queue peak` is how much audio was waiting to be sent -- it is '
            + 'latency the caller hears, and it should stay near the lead. A large peak means the '
            + "source (HomeKit, the phone's network) delivered faster than real time; `dropped` is "
            + 'what had to be discarded to stop that becoming a growing delay. `silence`/`stall(s)` '
            + 'mean the opposite: the source had nothing ready.',
        readonly: true,
        type: 'textarea',
        group: 'Self-Test',
    },
];

/** nativeId of the child mixin provider that supplies vendor pan/tilt. */
const PTZ_NATIVE_ID = 'vendor-ptz';

class CameraIntercomPlugin extends ScryptedDeviceBase implements DeviceProvider, MixinProvider, Settings {
    private ptzProvider?: VendorPtzProvider;

    constructor(nativeId?: string) {
        super(nativeId);
        // A second mixin provider, because pan/tilt must be attachable per camera: see
        // ptzMixin.ts for why one provider cannot decide that on its own.
        void sdk.deviceManager.onDeviceDiscovered({
            nativeId: PTZ_NATIVE_ID,
            name: 'Vendor PTZ',
            type: DeviceType.API,
            interfaces: [ScryptedInterface.MixinProvider],
        });
    }

    async getDevice(nativeId: string): Promise<VendorPtzProvider | undefined> {
        if (nativeId !== PTZ_NATIVE_ID)
            return undefined;
        this.ptzProvider ??= new VendorPtzProvider(PTZ_NATIVE_ID, (host, console) => this.driverFor(host, console));
        return this.ptzProvider;
    }

    async releaseDevice(): Promise<void> {
        // The child provider owns no resources of its own.
    }

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
        // Intercom only. Pan/tilt comes from the separate "Vendor PTZ" extension, so cameras
        // without it never advertise a capability nothing implements.
        return [ScryptedInterface.Intercom];
    }

    async getMixin(
        mixinDevice: VideoCamera, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState,
    ): Promise<CameraIntercomMixin> {
        return new CameraIntercomMixin(
            { mixinDevice, mixinDeviceInterfaces, mixinDeviceState, mixinProviderNativeId: this.nativeId },
            (host, console) => this.driverFor(host, console),
            host => ({
                warmupMs: Number(this.get('warmupMs')) || DEFAULT_WARMUP_MS,
                leadMs: this.leadFor(host) ?? (Number(this.get('leadMs')) || DEFAULT_LEAD_MS),
            }),
            // Last few sessions, kept as a setting: the plugin console is not readable over the
            // API, and attributing latency between this process, the caller's network and the
            // device needs the numbers rather than an impression.
            line => {
                const stamp = new Date().toISOString().slice(11, 19);
                const previous = (this.storage.getItem('lastSessions') ?? '').split('\n').filter(Boolean);
                this.storage.setItem('lastSessions', [`${stamp}  ${line}`, ...previous].slice(0, 8).join('\n'));
            },
        );
    }

    async releaseMixin(id: string, mixinDevice: CameraIntercomMixin): Promise<void> {
        mixinDevice.release();
    }

    /** Resolves and instantiates the right driver for a host, caching the detection result. */
    async driverFor(host: string, console: Console): Promise<IntercomDriver> {
        const name = this.overrideFor(host) ?? this.cachedDriver(host) ?? await this.detectAndCache(host, console);
        if (!name)
            throw new Error(`intercom: no supported talkback protocol found on ${host} (probed `
                + 'Reolink 9000, Tapo 8800 and Foscam 88; for an ONVIF backchannel device add a '
                + 'driver override)');
        const config: DriverConfig = { host, username: '', password: '', console };
        switch (name) {
            case 'foscam':
                return new FoscamDriver({
                    ...config,
                    username: this.get('foscamUsername'),
                    password: this.get('foscamPassword'),
                });
            case 'reolink':
                return new ReolinkDriver({
                    ...config,
                    username: this.get('reolinkUsername'),
                    password: this.get('reolinkPassword'),
                });
            case 'tapo':
                return new TapoDriver({
                    ...config,
                    cloudPassword: this.get('tapoCloudPassword'),
                    previousCloudPassword: this.get('tapoPreviousCloudPassword'),
                });
            case 'onvif-backchannel': {
                const mount = this.backchannelMountFor(host);
                return new OnvifBackchannelDriver({
                    ...config,
                    username: this.get('backchannelUsername'),
                    password: this.get('backchannelPassword'),
                    rtspPort: mount?.port ?? Number(this.get('backchannelRtspPort')),
                    rtspPath: mount?.path ?? this.get('backchannelRtspPath'),
                    keepAliveMs: this.keepAliveMs(),
                });
            }
        }
    }

    private get(key: string): string {
        return this.storage.getItem(key) ?? DEFAULTS[key] ?? '';
    }

    private overrideFor(host: string): DriverName | undefined {
        for (const line of this.get('driverOverrides').split('\n')) {
            const [left, right] = line.split('=').map(part => part?.trim());
            if (left === host && right)
                return right as DriverName;
        }
        return undefined;
    }

    /** Per-host RTSP mount for the backchannel, as `host=port/path`. */
    private backchannelMountFor(host: string): { port: number; path: string } | undefined {
        for (const line of this.get('backchannelOverrides').split('\n')) {
            const [left, right] = line.split('=').map(part => part?.trim());
            if (left !== host || !right)
                continue;
            const slash = right.indexOf('/');
            const port = Number(slash === -1 ? right : right.slice(0, slash));
            const path = slash === -1 ? this.get('backchannelRtspPath') : right.slice(slash + 1);
            if (Number.isFinite(port) && port > 0 && path)
                return { port, path };
            this.console.warn(`intercom: ignoring backchannel override "${line.trim()}": expected host=port/path`);
        }
        return undefined;
    }

    /** Per-host lead buffer, for devices worth a tighter one than the global default. */
    /** An explicit 0 disables the linger; anything unparseable falls back to the default rather
     * than silently turning it off. */
    private keepAliveMs(): number {
        const raw = this.get('backchannelKeepAliveMs').trim();
        if (raw === '0')
            return 0;
        const ms = Number(raw);
        return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_KEEP_ALIVE_MS;
    }

    private leadFor(host: string): number | undefined {
        for (const line of this.get('leadOverrides').split('\n')) {
            const [left, right] = line.split('=').map(part => part?.trim());
            if (left === host && right) {
                const ms = Number(right);
                if (Number.isFinite(ms) && ms >= 0)
                    return ms;
                this.console.warn(`intercom: ignoring lead override "${line.trim()}": not a number`);
            }
        }
        return undefined;
    }

    private cachedDriver(host: string): DriverName | undefined {
        const cached = this.storage.getItem(`driver:${host}`);
        return cached ? cached as DriverName : undefined;
    }

    private async detectAndCache(host: string, console: Console): Promise<DriverName | undefined> {
        const detected = await detectDriver(host, console);
        if (detected)
            this.storage.setItem(`driver:${host}`, detected);
        return detected;
    }

    private async runTalkbackTest(): Promise<void> {
        const cameraName = this.get('selfTestCamera');
        if (!cameraName)
            throw new Error('set Self-Test Camera to the name of the camera to test');
        const camera = Object.keys(sdk.systemManager.getSystemState())
            .map(id => sdk.systemManager.getDeviceById<VideoCamera & Partial<Settings>>(id))
            .find(device => device?.name === cameraName);
        if (!camera)
            throw new Error(`no device named "${cameraName}"`);
        const host = await hostOfDevice(camera);
        const driver = await this.driverFor(host, this.console);
        const result = await runTalkbackSelfTest({
            driver,
            host,
            rtspUsername: this.get('selfTestRtspUsername'),
            rtspPassword: this.get('selfTestRtspPassword'),
            ffmpegPath: await sdk.mediaManager.getFFmpegPath(),
            log: line => this.console.log(`intercom self-test: ${line}`),
        });
        this.storage.setItem('lastTalkbackTest', result.lines.join('\n'));
    }
}

/** The same address resolution the mixin uses, for the plugin-level self-test. */
async function hostOfDevice(device: VideoCamera & Partial<Settings>): Promise<string> {
    const settings = await device.getSettings?.().catch(() => undefined);
    const ip = settings?.find(setting => setting.key === 'ip')?.value;
    if (typeof ip === 'string' && ip)
        return ip;
    const urls = settings?.find(setting => setting.key === 'urls')?.value;
    const text = Array.isArray(urls) ? urls[0] : urls;
    if (typeof text === 'string') {
        const match = text.match(/rtsp:\/\/(?:[^@/]*@)?([^:/]+)/i);
        if (match)
            return match[1];
    }
    throw new Error('could not determine the camera address from its own settings');
}

/** The child provider: attach it only to cameras whose vendor protocol carries pan/tilt. */
class VendorPtzProvider extends ScryptedDeviceBase implements MixinProvider {
    constructor(nativeId: string, private driverFactory: (host: string, console: Console) => Promise<IntercomDriver>) {
        super(nativeId);
    }

    async canMixin(type: ScryptedDeviceType | string, interfaces: string[]): Promise<string[] | undefined> {
        if (!interfaces.includes(ScryptedInterface.VideoCamera))
            return undefined;
        return [ScryptedInterface.PanTiltZoom];
    }

    async getMixin(
        mixinDevice: VideoCamera, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState,
    ): Promise<VendorPtzMixin> {
        return new VendorPtzMixin(
            { mixinDevice, mixinDeviceInterfaces, mixinDeviceState, mixinProviderNativeId: this.nativeId },
            this.driverFactory,
        );
    }

    async releaseMixin(id: string, mixinDevice: VendorPtzMixin): Promise<void> {
        mixinDevice.release();
    }
}

export default CameraIntercomPlugin;
export { isPtzCapable };

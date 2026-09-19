// Pan/tilt lives in its own mixin provider, attached only to cameras whose vendor protocol
// actually carries it (today: Foscam, over the CGI API).
//
// Why separate from the Intercom mixin: `MixinProvider.canMixin` is handed only a device type and
// its interfaces — not the device itself — so one provider cannot decide per camera whether to
// claim `PanTiltZoom`. Claiming it for every camera would put a dead capability on the cameras
// that have no pan/tilt at all, which is the exact anti-pattern this whole plugin exists to
// clean up, and would shadow the working `ONVIF PTZ` mixin on the cameras that get PTZ elsewhere.
// A second provider keeps the choice explicit and per camera.

import type {
    MixinDeviceOptions, PanTiltZoom, PanTiltZoomCommand, Setting, Settings, VideoCamera,
} from '@scrypted/sdk';
import { MixinDeviceBase } from '@scrypted/sdk';
import { IntercomDriver, isPtzCapable } from './drivers/driver';

export type DriverFactory = (host: string, console: Console) => Promise<IntercomDriver>;

export class VendorPtzMixin extends MixinDeviceBase<VideoCamera & Partial<Settings>> implements PanTiltZoom {
    constructor(options: MixinDeviceOptions<VideoCamera & Partial<Settings>>, private createDriver: DriverFactory) {
        super(options);
        void this.publishCapabilities();
    }

    async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
        const driver = await this.driver();
        await driver.ptzCommand(command);
    }

    private async driver() {
        const host = await resolveHost(this.mixinDevice);
        const driver = await this.createDriver(host, this.console);
        if (!isPtzCapable(driver))
            throw new Error(`ptz: the ${driver.name} protocol carries no pan/tilt; detach this `
                + 'extension from this camera (its PTZ, if any, comes from elsewhere)');
        return driver;
    }

    private async publishCapabilities(): Promise<void> {
        try {
            this.ptzCapabilities = await (await this.driver()).ptzCapabilities();
        } catch (e) {
            this.console.warn('ptz: could not read capabilities:', (e as Error).message);
        }
    }
}

/** Address resolution shared with the intercom mixin: providers expose it either as an `ip`
 * setting or inside an RTSP url. */
export async function resolveHost(device: VideoCamera & Partial<Settings>): Promise<string> {
    const settings: Setting[] | undefined = await device.getSettings?.().catch(() => undefined);
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
    throw new Error('could not determine the camera address from its own settings (no `ip`, no RTSP url)');
}

// Foscam CGI client -- the documented HTTP API (`/cgi-bin/CGIProxy.fcgi?cmd=...`), used here for
// pan/tilt, presets and speaker volume. Verified live against an R2C on firmware 2.91.2.80:
// `getPTZPresetPointList` -> 4 built-in points (TopMost/BottomMost/LeftMost/RightMost),
// `ptzMoveLeft`/`ptzMoveRight`/`ptzStopRun` -> `<result>0</result>` with real gimbal movement.
//
// Result codes: 0 = ok, -1 = malformed request, -2 = bad credentials, -3 = command not supported
// by this model/firmware (a great many newer commands answer -3 on the R2C), -4 = execute failed.

import * as http from 'http';

/** Continuous-move directions the camera accepts as `ptzMove<Direction>`. */
export type PtzDirection =
    | 'Up' | 'Down' | 'Left' | 'Right'
    | 'TopLeft' | 'TopRight' | 'BottomLeft' | 'BottomRight';

export interface FoscamCgiOptions {
    host: string;
    /** Foscam web port -- `cmd=getPortInfo` -> `webPort`. Default 88. */
    port?: number;
    username: string;
    password: string;
}

export class FoscamCgiClient {
    constructor(private options: FoscamCgiOptions) { }

    /** Runs a CGI command and returns its parsed `<tag>value</tag>` pairs. Throws on a
     * non-zero `<result>`, so callers never silently ignore -2/-3/-4. */
    async command(cmd: string, params: Record<string, string | number> = {}): Promise<Record<string, string>> {
        const query = new URLSearchParams({
            cmd,
            usr: this.options.username,
            pwd: this.options.password,
            ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
        });
        const body = await new Promise<string>((resolve, reject) => {
            const req = http.get({
                host: this.options.host,
                port: this.options.port ?? 88,
                path: `/cgi-bin/CGIProxy.fcgi?${query}`,
                timeout: 8000,
            }, res => {
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            });
            req.on('timeout', () => req.destroy(new Error(`CGI ${cmd} timed out`)));
            req.on('error', reject);
        });

        const fields: Record<string, string> = {};
        for (const [, tag, value] of body.matchAll(/<(\w+)>([^<]*)<\/\1>/g))
            fields[tag] = decodeURIComponent(value.replace(/\+/g, ' ')).trim();
        const result = Number(fields.result ?? NaN);
        if (result !== 0)
            throw new Error(`Foscam CGI ${cmd} returned result ${fields.result ?? '(none)'}`);
        return fields;
    }

    /** Starts a continuous move. The camera keeps moving until `stop()`. */
    async move(direction: PtzDirection): Promise<void> {
        await this.command(`ptzMove${direction}`);
    }

    async stop(): Promise<void> {
        await this.command('ptzStopRun');
    }

    /** Foscam speed is an enum, 0 = fastest .. 4 = slowest (`getPTZSpeed` reads 1 by default). */
    async setSpeed(speed: number): Promise<void> {
        await this.command('setPTZSpeed', { speed: Math.max(0, Math.min(4, Math.round(speed))) });
    }

    async gotoPreset(name: string): Promise<void> {
        await this.command('ptzGotoPresetPoint', { name });
    }

    /** Recentres the gimbal by running the camera's own pan/tilt calibration sweep. The R2C has
     * no "home" preset, and this is what its own app's reset control does. */
    async recentre(): Promise<void> {
        await this.command('ptzReset');
    }

    async listPresets(): Promise<string[]> {
        const fields = await this.command('getPTZPresetPointList');
        const count = Number(fields.cnt ?? 0);
        const names: string[] = [];
        for (let i = 0; i < count; i++) {
            const name = fields[`point${i}`];
            if (name)
                names.push(name);
        }
        return names;
    }

    /** Speaker volume, 0..100. Applies to talkback playback as well as the camera's own sounds. */
    async setVolume(volume: number): Promise<void> {
        await this.command('setAudioVolume', { volume: Math.max(0, Math.min(100, Math.round(volume))) });
    }

    async getVolume(): Promise<number> {
        return Number((await this.command('getAudioVolume')).volume);
    }
}

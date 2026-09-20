// Reolink's HTTP CGI, used for the parts of a camera that the Baichuan talk protocol does not
// carry: currently zoom.
//
// Why this exists at all, when Scrypted already ships an `ONVIF PTZ` mixin: on the RLC-833A that
// mixin is a DEAD capability. It accepts `ptzCommand` and returns success, including for axes the
// camera reports it does not have, and the lens never moves. Measured against the camera's own
// `GetZoomFocus` readback: 21 before, 21 after. The same request through this CGI moved it 4 ->
// 21. That readback is also what makes zoom testable without anyone watching the picture.
//
// Auth is user/password as query parameters. Reolink also offers a token login, but the
// per-request form is stateless, which suits commands that are issued once and forgotten -- there
// is no session to keep alive or renew, and a wrong password fails the one request rather than
// poisoning a cached token.

/** Continuous-move ops run until `Stop`, so a relative command is a timed burst. This is the
 * full-travel duration at the speed below, measured on an RLC-833A: a 1.0 zoom delta. */
const FULL_TRAVEL_MS = 2500;
const MIN_BURST_MS = 120;
const ZOOM_SPEED = 32;

export interface ReolinkCgiConfig {
    host: string;
    username: string;
    password: string;
    console: Console;
}

export class ReolinkCgi {
    constructor(private config: ReolinkCgiConfig) { }

    /** Zoom position and its focus companion, as the camera reports them. Used to verify that a
     * zoom command actually did something -- the reason this module exists. */
    async zoomPosition(): Promise<number | undefined> {
        const response = await this.command('GetZoomFocus', { channel: 0 });
        const position = response?.[0]?.value?.ZoomFocus?.zoom?.pos;
        return typeof position === 'number' ? position : undefined;
    }

    /** Relative zoom, `delta` in -1..1. Positive zooms in. */
    async zoom(delta: number): Promise<void> {
        const clamped = Math.max(-1, Math.min(1, delta));
        if (!clamped)
            return;
        const op = clamped > 0 ? 'ZoomInc' : 'ZoomDec';
        const burstMs = Math.max(MIN_BURST_MS, Math.abs(clamped) * FULL_TRAVEL_MS);
        await this.command('PtzCtrl', { channel: 0, op, speed: ZOOM_SPEED });
        try {
            const wait = Promise.withResolvers<void>();
            setTimeout(wait.resolve, burstMs);
            await wait.promise;
        } finally {
            // Stop is not optional: a continuous move left unstopped runs the lens to its limit.
            await this.command('PtzCtrl', { channel: 0, op: 'Stop' });
        }
    }

    private async command(cmd: string, param: Record<string, unknown>): Promise<any> {
        const { host, username, password } = this.config;
        const url = `http://${host}/cgi-bin/api.cgi?cmd=${cmd}`
            + `&user=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{ cmd, param }]),
        });
        if (!response.ok)
            throw new Error(`reolink cgi: ${cmd} failed: HTTP ${response.status}`);
        const body = await response.json() as any;
        const code = body?.[0]?.code;
        if (code !== 0)
            throw new Error(`reolink cgi: ${cmd} returned code ${code} `
                + `(${body?.[0]?.error?.detail ?? 'no detail'})`);
        return body;
    }
}

// Which driver does a given camera need?
//
// Detection is by fingerprint, not by guessing from the device name, because the vendors are
// unambiguous about which port answers what.
//
// Vendor ports are probed FIRST, and `onvif-backchannel` is reached by an explicit override. That
// is deliberate, and it is the opposite of what this comment used to claim: where a device offers
// both, the vendor path has measured BETTER on this hardware. A Reolink doorbell's ONVIF
// backchannel offers `PCMU/8000` and nothing else, while the same doorbell accepts 16 kHz ADPCM
// over Baichuan on port 9000 -- twice the bandwidth for the caller's voice. "Standards first" is
// the right instinct for interoperability and the wrong one for audio quality here.
//
// The result is cached in the plugin's storage per host, since it cannot change without a
// firmware change and probing costs a round trip on every intercom start otherwise.

import * as net from 'net';
import { DriverName } from './drivers/driver';

const PROBE_TIMEOUT_MS = 1500;

interface Fingerprint {
    driver: DriverName;
    port: number;
    /** Extra confirmation beyond "the port accepts a connection", where cheap. */
    confirm?: (host: string, port: number) => Promise<boolean>;
}

/** Ordered: the first match wins. */
const FINGERPRINTS: Fingerprint[] = [
    // Reolink's Baichuan port is exclusive to Reolink and answers nothing else.
    { driver: 'reolink', port: 9000 },
    // Tapo's talk endpoint: confirm via the digest challenge, whose realm names the vendor.
    { driver: 'tapo', port: 8800, confirm: confirmTapo },
    // Foscam multiplexes CGI, RTSP and the low-level protocol on one port; confirm with CGI.
    { driver: 'foscam', port: 88, confirm: confirmFoscam },
];

export async function detectDriver(host: string, console: Console): Promise<DriverName | undefined> {
    for (const fingerprint of FINGERPRINTS) {
        if (!await portOpen(host, fingerprint.port))
            continue;
        if (fingerprint.confirm && !await fingerprint.confirm(host, fingerprint.port).catch(() => false)) {
            console.log(`intercom: ${host}:${fingerprint.port} is open but does not look like ${fingerprint.driver}`);
            continue;
        }
        console.log(`intercom: detected ${fingerprint.driver} on ${host}:${fingerprint.port}`);
        return fingerprint.driver;
    }
    return undefined;
}

function portOpen(host: string, port: number): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const socket = net.createConnection({ host, port });
    const finish = (open: boolean) => {
        socket.destroy();
        resolve(open);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    socket.once('connect', () => {
        clearTimeout(timer);
        finish(true);
    });
    socket.once('error', () => {
        clearTimeout(timer);
        finish(false);
    });
    return promise;
}

/** Tapo's :8800 answers an unauthenticated POST with a digest challenge naming the vendor. */
async function confirmTapo(host: string, port: number): Promise<boolean> {
    const head = await readHead(host, port,
        `POST /stream HTTP/1.1\r\nHost: ${host}:${port}\r\n`
        + 'Content-Type: multipart/mixed;boundary=--client-stream-boundary--\r\nAccept: */*\r\n\r\n');
    return head.includes('TP-Link IP-Camera');
}

/** Foscam's CGI answers even without credentials, with its own result envelope. */
async function confirmFoscam(host: string, port: number): Promise<boolean> {
    const head = await readHead(host, port,
        `GET /cgi-bin/CGIProxy.fcgi?cmd=getDevInfo HTTP/1.1\r\nHost: ${host}:${port}\r\n`
        + 'Accept: */*\r\nConnection: close\r\n\r\n', true);
    return head.includes('CGI_Result');
}

function readHead(host: string, port: number, request: string, wantBody = false): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    const socket = net.createConnection({ host, port });
    let buffer = '';
    const finish = () => {
        socket.destroy();
        resolve(buffer);
    };
    const timer = setTimeout(finish, PROBE_TIMEOUT_MS);
    socket.once('connect', () => socket.write(request));
    socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 4096 || (!wantBody && buffer.includes('\r\n\r\n'))) {
            clearTimeout(timer);
            finish();
        }
    });
    socket.once('error', () => {
        clearTimeout(timer);
        finish();
    });
    socket.once('close', () => {
        clearTimeout(timer);
        resolve(buffer);
    });
    return promise;
}

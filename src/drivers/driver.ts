// The one contract every vendor protocol implements, so the Scrypted-facing half of this plugin
// (ffmpeg, pacing, the self-test, HomeKit) is written once.
//
// Design note on the audio boundary: every driver accepts raw signed 16-bit little-endian PCM at
// its own native sample rate and does its own encoding internally. That is deliberate — the
// vendors disagree wildly about the wire format (Foscam wants raw PCM, Reolink IMA/DVI-4 ADPCM in
// 516-byte blocks, Tapo G.711 A-law inside MPEG-TS, an ONVIF backchannel L16 or G.711 in RTP) but
// they all agree about PCM. So ffmpeg is configured once, per-driver, with nothing but a sample
// rate, and every codec quirk stays inside the driver that owns it.

import type { PanTiltZoomCapabilities, PanTiltZoomCommand } from '@scrypted/sdk';

export type DriverName = 'foscam' | 'reolink' | 'tapo' | 'onvif-backchannel';

export interface TalkFormat {
    /** Native sample rate the device plays. ffmpeg is told to resample to exactly this. */
    sampleRate: number;
    /** PCM bytes handed to `write()` per call: one device frame's worth. */
    pcmFrameBytes: number;
    /** Milliseconds of audio to write as fast as the socket accepts it, before real-time pacing
     * begins. Default 0, which is correct for every vendor camera here: they all DISCARD audio
     * that arrives faster than real time, so front-loading would simply throw it away.
     *
     * Set it only for a device that QUEUES what it is sent. The feeder runs our own firmware,
     * which writes straight to an ALSA FIFO with no jitter buffer of its own -- so at exactly
     * real time, ordinary scheduling jitter in this process becomes an underrun on the device and
     * is heard as choppiness. Giving that FIFO a head start is what a hardware camera's internal
     * buffer does for the others. */
    prebufferMs?: number;
}

export interface DriverConfig {
    host: string;
    username: string;
    password: string;
    /** Tapo only: the cloud password is the talk secret, and a previous one is tried as a
     * fallback because cameras adopt a rotation at their own pace. */
    cloudPassword?: string;
    previousCloudPassword?: string;
    /** ONVIF backchannel only: RTSP port and mount path. */
    rtspPort?: number;
    rtspPath?: string;
    console: Console;
}

export interface IntercomDriver {
    readonly name: DriverName;
    /** Valid only after `open()` resolves: a couple of drivers learn their frame size from the
     * device (Reolink's block size comes from its TalkAbility response). */
    readonly format: TalkFormat;
    /** Whether the device echo-cancels its own speaker out of its own microphone. When true, an
     * acoustic self-test that hears nothing is INCONCLUSIVE, not a failure — see the repository
     * README. Drivers state this from the device's own capability report where one exists. */
    readonly echoCancels: boolean;
    /** Human-readable facts worth putting in the log or the self-test output, e.g. which password
     * derivation a Tapo camera actually accepted. */
    readonly notes: string[];

    /** Connects, authenticates and opens a talk session. Throws with a diagnosable message. */
    open(): Promise<void>;
    /** Sends exactly `format.pcmFrameBytes` of s16le PCM. The caller paces; drivers must not.
     *
     * Awaited by the pump, and that matters: a driver whose transport needs a round trip per
     * message (Reolink acknowledges each one) will interleave and produce choppy audio if
     * consecutive writes are allowed to overlap. */
    write(pcm: Buffer): Promise<void>;
    close(): Promise<void>;
}

/** Implemented only by drivers whose protocol also carries pan/tilt. */
export interface PtzCapableDriver {
    ptzCapabilities(): Promise<PanTiltZoomCapabilities>;
    ptzCommand(command: PanTiltZoomCommand): Promise<void>;
}

export function isPtzCapable(driver: IntercomDriver): driver is IntercomDriver & PtzCapableDriver {
    const candidate = driver as Partial<PtzCapableDriver>;
    return typeof candidate.ptzCommand === 'function' && typeof candidate.ptzCapabilities === 'function';
}

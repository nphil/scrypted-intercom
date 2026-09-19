# Reolink Intercom (Scrypted plugin)

Adds **working two-way audio** to a Reolink camera that Scrypted already streams, over Reolink's
proprietary Baichuan protocol (TCP 9000). It is a mixin, so it attaches to the existing camera
device and leaves its stream, Rebroadcast, NVR recording, PTZ and HomeKit publishing untouched.

Built for and verified against the **Reolink RLC-833A** at `192.168.1.103` ("Office Camera",
Scrypted device 128), firmware **v3.1.0.3016_2312052457**, hardware `IPC_523D88MP`.

## The bug this fixes

The symptom was a HomeKit talk button that did nothing. The cause was an advertised capability
that cannot exist on this hardware:

- `@scrypted/reolink` implements `startIntercom` **only** as an ONVIF audio backchannel
  (`plugins/reolink/src/main.ts` → `OnvifIntercom`), and advertises `ScryptedInterface.Intercom`
  whenever its `doorbell` or `useOnvifTwoWayAudio` setting is true.
- This camera had `useOnvifTwoWayAudio = true`, so Scrypted advertised `Intercom` and HomeKit
  drew a talk button — but calling it threw `ONVIF audio backchannel not found`.
- The camera genuinely has no ONVIF backchannel: ONVIF `GetAudioOutputs` returns an **empty**
  response, `GetAudioDecoderConfigurations` **faults**, its main ONVIF stream URI is a bare
  `rtsp://192.168.1.103:554/`, and `DESCRIBE` with `Require: www.onvif.org/ver20/backchannel`
  returns SDP identical to a plain DESCRIBE (no `sendonly` section). RTSP `OPTIONS` has no
  `ANNOUNCE`/`RECORD` either.

**No firmware update will fix that.** v3.1.0.3016 (Dec 2023) is the newest firmware for hardware
`IPC_523D88MP` per the [reolink-fw-archive](https://github.com/AT0myks/reolink-fw-archive), and
Scrypted's own Reolink plugin readme and
[Camera Support Report Card](https://github.com/koush/scrypted/wiki/Camera-Support-Report-Card)
both state that ONVIF two-way audio works on Reolink **doorbells**, not cameras. (The E1 Pro
gained it in a later firmware, so Reolink can do it — just not on this model.)

So `useOnvifTwoWayAudio` must be turned **off** on the camera, and this plugin supplies the
`Intercom` instead. `tools/configure.mjs` does both. Leaving both enabled means two `Intercom`
implementations on one device, and the broken one may win.

## Protocol

Baichuan, TCP port 9000, little-endian. The reference implementations are
[neolink](https://github.com/QuantumEntangledAndy/neolink) (Rust) and
[ha-reolink-talk](https://github.com/nelsonjchen/ha-reolink-talk) / 
[reolink_aio](https://github.com/starkillerOG/reolink_aio) (Python); this is an independent
TypeScript port with no runtime dependencies beyond Node's `net` and `crypto`.

Header: `f0debc0a` | cmdId(4) | messLen(4) | chId(1) | messId(3) | status+class(4) | *optional*
payloadOffset(4). `chId` is 250 with no channel, else channel+1.

Two header/body facts were established by tracing this camera, because a literal reading of the
available notes does not work:

1. For the **nonce request** the two bytes before the class are a fixed `12dc` marker, not a
   status field. Send a zero status there and the camera replies with a 20-byte, empty-body stub
   and no nonce at all.
2. The presence of the `payloadOffset` field is **not** "class 0x1464 has it, others do not".
   The camera's own replies use class `0x1466` for the nonce reply (20-byte, no offset) and class
   `0x0000` for everything else including login and TalkAbility (24-byte, **with** offset). The
   working rule is `hasPayloadOffsetField(class) = class !== 0x1465 && class !== 0x1466`. Get
   this wrong and the login reply's offset field is read as the start of the body, misaligning
   every byte after it and cascading into garbage on every later message.

Body encryption: the nonce request and login use a XOR scheme
(`out[i] = in[i] ^ XML_KEY[(offset+i) % 8] ^ offset`, `offset = chId`,
`XML_KEY = 1F 2D 3C 4B 5A 69 78 FF`); everything afterwards uses AES-128-CFB with
key `md5Modern(`${nonce}-${password}`).slice(0,16)` and IV `0123456789abcdef`, where
`md5Modern(s) = md5(s).hex().slice(0, 31).toUpperCase()` — note 31 characters, not 32.

Talk sequence: `TalkAbility` (cmd 10) → `TalkConfig` (cmd 201, retried once after a cmd 11 stop
on status 400/422) → audio (cmd 202) → stop (cmd 11). Audio is IMA/DVI-4 ADPCM at the advertised
sample rate (16 kHz here), mono, framed per block as a BcMedia ADPCM packet (magic `0x62773130`,
payload length twice, `0x0100`, half-block-size, then the block, zero-padded to 8 bytes), four
blocks per cmd 202 message.

### The block size, which is the whole game

The ADPCM block must be **`lengthPerEncoder / 2 + 4` = 516 bytes**, not `lengthPerEncoder`
(1024). With 1024-byte blocks the camera completes the handshake, acknowledges every single
audio message, reports no error anywhere — and plays **silence**. With 516 it plays clean audio.
neolink's own gstreamer pipeline shows the same value (`adpcmenc blockalign=516 layout=dvi`).
`talkFullBlockSize()` derives it from the camera's own TalkAbility so a caller cannot guess wrong.

Pacing is the caller's job and is not optional: the camera has no meaningful jitter buffer and
silently drops whatever arrives faster than real time. `mixin.ts` sends one 4-block message per
`(blocks * (blockSize-4) * 2) / sampleRate` seconds.

## Install

```sh
cd reolink-intercom
npm install --include=dev          # this machine sets npm omit=dev globally; without the flag the
                                   # webpack terser plugin is pruned and the build fails
NODE_ENV=production npm run build
NODE_TLS_REJECT_UNAUTHORIZED=0 npx scrypted-deploy <scrypted-host>:10443

SCRYPTED_URL=https://<host>:10443 SCRYPTED_USER=… SCRYPTED_PASS=… \
REOLINK_USER=… REOLINK_PASS=… node tools/configure.mjs
```

`configure.mjs` writes the plugin settings, turns off `useOnvifTwoWayAudio` on the camera, and
attaches the mixin. If the camera is already published to HomeKit, reload the HomeKit plugin
afterwards so the accessory re-advertises (`tools/selftest.mjs` does that at the end).

## Verifying it

**This camera cannot hear its own speaker.** It runs echo cancellation on the microphone — which
is the entire point of a talkback device — so audio that a person in the room hears clearly does
not appear in the camera's own RTSP audio track at all. The `Test Talkback` button therefore
reports the acoustic measurement for information but does **not** gate on it; gating on "the
camera heard itself" reports FAIL on a working setup and sends you debugging a non-problem.
(The sibling `foscam-intercom` plugin *does* gate on it, because that camera has no AEC and
happily records its own speaker.)

What the self-test does prove: login succeeded, the camera accepted `TalkConfig`, and every audio
message was accepted at the block size the camera itself advertised — which excludes the one
failure mode that lies (wrong block size → silent success).

### Results, live, on the deployed plugin

```
connected to the Baichuan port 192.168.1.103:9000
login accepted (nonce exchange + modern login)
TalkAbility: adpcm 16000 Hz mono, duplex FDX, audioStreamMode followVideoStream, lengthPerEncoder 1024
TalkConfig accepted (cmd 201)
encoded 63 ADPCM blocks of 516 bytes (lengthPerEncoder/2 + 4)
sent 16 talk messages / 63 blocks
talk stopped (cmd 11)
PASS: the camera accepted the talk session and every audio message at its own advertised block size.
```

Audible playback was confirmed by ear by the camera's owner standing in the room, from the
equivalent Python prototype — who reported it sounded **cleaner than neolink's own output** on
the same camera. `tools/verify.mjs` drives the real `startIntercom` interface (the same path
HomeKit uses) with three rising sweeps for a repeat listening check.

## Layout

| File | What it does |
| --- | --- |
| `src/baichuan.ts` | Protocol client: framing, XOR + AES-CFB bodies, nonce/login, TalkAbility, TalkConfig, cmd 202 audio, stop. Pure Node, no Scrypted dependency. |
| `src/adpcm.ts` | IMA/DVI-4 ADPCM encoder producing fixed-size blocks with continuous predictor state. |
| `src/mixin.ts` | The mixin: `Intercom` via ffmpeg → PCM → ADPCM → paced cmd 202 messages. |
| `src/main.ts` | Plugin: settings, `MixinProvider`, the self-test button. |
| `src/selfTest.ts` | Talkback self-test and its sweep detector. |
| `src/sdkFix.ts` | The `@scrypted/sdk` static-injection workaround this deployment needs. |
| `tools/configure.mjs` | Applies settings, disables the broken ONVIF path, attaches the mixin. |
| `tools/verify.mjs` | Drives the real `startIntercom` for a listening check. |
| `tools/selftest.mjs` | Presses the self-test button over the API and reloads HomeKit. |

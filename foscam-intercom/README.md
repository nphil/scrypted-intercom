# Foscam Intercom + PTZ (Scrypted plugin)

Adds **two-way audio** and **pan/tilt** to a Foscam camera that Scrypted already streams over
RTSP. It is a mixin, so it attaches to the existing camera device — the RTSP stream, Rebroadcast,
NVR recording, HomeKit publishing and object detection on that device are untouched.

Built for and verified against the **Foscam R2C** at `192.168.4.143` ("Gym Camera", Scrypted
device 168), firmware **2.91.2.80**, hardware 1.13.1.8, product model 7001.

## Why a plugin and not ONVIF

The R2C cannot do two-way audio through any standard, and this is not a configuration problem:

| Route | Result on this firmware |
| --- | --- |
| ONVIF backchannel (Profile T) | `GetAudioOutputConfigurations` → `ter:ActionNotSupported` / `ter:AudioOutputNotSupported`; `GetAudioDecoderConfigurations` → `ter:AudioDecodingNotSupported`. `GetAudioOutputs` does return a token (`audioOutput0`), which is why naive clients think it should work. |
| RTSP backchannel | The camera's RTSP server is `LIVE555 Streaming Media v2014.02.10`. `DESCRIBE /videoMain` with `Require: www.onvif.org/ver20/backchannel` returns **byte-identical SDP** to a plain DESCRIBE — one receive-only `m=video` (H264) and one receive-only `m=audio` (PCMU). No `sendonly` section. |
| RTSP `ANNOUNCE`/`RECORD` | Not in `OPTIONS`: `OPTIONS, DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, GET_PARAMETER, SET_PARAMETER`. |
| Foscam CGI API | No talk command exists. `getAudioStreamParam`, `getTalkParam`, `getRtmpConfig` and friends all answer `result -3` (unsupported). |
| The camera's own web UI | Connects to `ws://127.0.0.1:<port>` — i.e. it needs Foscam's locally installed native browser plugin, which speaks the proprietary protocol. Its message ids include `REQUEST_TALK` (50005). |

So the only audio-in path the hardware has is Foscam's proprietary low-level protocol, which is
what `src/foscamTalk.ts` implements. PTZ, by contrast, is plain documented CGI.

## The talk protocol, as it actually behaves on 2.91.2.80

Framing is the one documented for the FI9821W V2 in
[pyFosControl `LowlevelProtocol.md`](https://github.com/MStrecke/pyFosControl/blob/master/lowlevel/LowlevelProtocol.md):
connect to the **media port** (`cmd=getPortInfo` → `mediaPort`, here 88 — the same port as the
HTTP CGI and RTSP, demultiplexed by the first request line), send one HTTP-shaped request

```
SERVERPUSH / HTTP/1.1
Host: <ip>:88
Accept:*/*
Connection: Close
```

and then exchange frames of `<u32 command><"FOSC"><u32 payload length><payload>`, little-endian.

Two details differ from that document, and both are why a straight implementation of it produces
silence. Established live against this camera:

1. **Speaker on (command 4) needs the 164-byte login-shaped payload**
   `user[64] pwd[64] uid[u32] pad[32]` — *not* the 161-byte `flag + user + pwd + uid + pad[28]`
   the document lists. The camera replies command 20 to both, but the u32 in that reply is a
   status: `0` = accepted, `1` = rejected. Only the 164-byte form gets `0`, and only after a `0`
   does the camera route command 6 payloads to the speaker. With the 161-byte form everything
   looks fine — connection alive, frames accepted, no error — and nothing plays.
2. **Command 6 payloads are `len[u32] + raw audio`, with no frame header.** Prefixing the 36-byte
   header that the camera's *own* outbound audio frames (command 27) carry makes the camera drop
   the connection immediately.

Audio format, measured acoustically (tones and a 300→3200 Hz chirp pushed in, then recovered from
the camera's own RTSP microphone track): **raw signed 16-bit little-endian PCM, 8000 Hz, mono**,
in 960-byte frames (480 samples = 60 ms), **paced in real time**. The camera has no meaningful
jitter buffer: it absorbs a burst with no TCP backpressure at all (60 s of audio, ~1 MB, accepted
in 0.13 s) and discards whatever it cannot play immediately, so pacing is the client's
responsibility — `FoscamTalkClient` does it and reports dropped bytes.

Other useful findings about this firmware, from the same investigation:

* Command 0 (video on) also needs its leading flag byte set to **1**; with 0 the camera answers
  command 16 and streams nothing. Talkback does **not** require it — login → speaker on → talk
  data is enough.
* The inbound audio channel (command 2 → command 27 frames) is **not** useful: every 120-byte
  payload in a capture is byte-identical filler that decodes as G.726 silence, so the microphone
  is only readable over RTSP, not over this protocol.
* An idle session survives indefinitely with command 15 (`uid`) as a keepalive; the client sends
  one every 15 s.
* The camera rate-limits new logins. Opening sessions back to back gets them refused for a while,
  which looks exactly like a credential problem but is not.

## PTZ

Plain CGI (`src/foscamCgi.ts`): `ptzMove{Up,Down,Left,Right,TopLeft,…}` + `ptzStopRun`,
`ptzGotoPresetPoint`, `getPTZPresetPointList`, `setPTZSpeed`, `ptzReset`. The camera has **no
absolute positioning**, so Scrypted's movement types map like this:

| Scrypted | Camera |
| --- | --- |
| `Relative` (default) | continuous move for `\|magnitude\| × 1000 ms`, then `ptzStopRun` |
| `Continuous` | continuous move; stopped by the client's zero vector, or by a 5 s watchdog if that never arrives |
| `Absolute` | treated as relative, with a warning logged — the hardware cannot do it |
| `Preset` | `ptzGotoPresetPoint` (R2C ships `TopMost`, `BottomMost`, `LeftMost`, `RightMost`) |
| `Home` | `ptzReset` — the calibration sweep the vendor app's reset control runs |

Speed maps inverted: Scrypted `0..1` (fast at 1) → Foscam `4..0` (fast at 0).

## Install

```sh
cd foscam-intercom
npm install --include=dev          # this machine has npm omit=dev set globally; without the flag
                                   # the webpack terser plugin is pruned and the build fails
NODE_ENV=production npm run build
NODE_TLS_REJECT_UNAUTHORIZED=0 npx scrypted-deploy <scrypted-host>:10443
```

`scrypted-deploy` needs `~/.scrypted/login.json`:
`{ "<host>:10443": { "username": "<user>", "token": "<password>" } }`.

Then set the camera address and credentials in the **Foscam Intercom + PTZ** plugin's own
Settings, and enable it on the camera (Devices → camera → Extensions). Both steps in one go:

```sh
SCRYPTED_URL=https://<host>:10443 SCRYPTED_USER=… SCRYPTED_PASS=… \
FOSCAM_USER=… FOSCAM_PASS=… node tools/configure.mjs
```

If the camera is already published to HomeKit, reload the HomeKit plugin afterwards so the
accessory re-advertises with two-way audio (`tools/selftest.mjs` does this at the end).

## Verifying it

Two buttons in the plugin's Settings, both of which report into a read-only field below them:

* **Test Pan/Tilt** — pans left, stops, pans right, stops, reads the preset list.
* **Test Talkback** — pushes a 300→3200 Hz sweep through the talk protocol while recording the
  camera's own RTSP microphone track, then checks that the recording contains a rising sweep of
  the right size and duration. This is the only check that proves *audible* playback; the
  protocol's own acknowledgements prove only that the camera accepted the request.

`tools/selftest.mjs` presses both over the API. `tools/verify.mjs` goes one level higher and
drives the real Scrypted interfaces — `startIntercom` with an ffmpeg lavfi sweep, and
`ptzCommand` between snapshots — which is what exercises the plugin's own ffmpeg transcode and
pacing rather than the protocol library alone.

### Results, live, on the deployed plugin

* `Test Pan/Tilt` → `PASS`, presets read back as `["TopMost","BottomMost","LeftMost","RightMost"]`.
* `Test Talkback` → `PASS`: 66 frames / 63360 bytes sent, 0 dropped; the microphone recording
  rose 950 Hz → 3150 Hz over 4.10 s (the sweep is 4.0 s long).
* `tools/verify.mjs both` → `camera.startIntercom()` with a lavfi sweep came back out of the
  camera speaker (609 Hz at t=3.65 s rising monotonically to 3156 Hz at t=7.30 s in a recording
  made independently of the plugin); `ptzCommand({ movement: 'Relative', pan: -0.5 })` moved the
  camera (mean absolute pixel difference between before/after snapshots 17.9 of 255, versus 3.6
  after panning back).
* Device 168's interface list gained `Intercom` and `PanTiltZoom`, with
  `ptzCapabilities = {"pan":true,"tilt":true,"zoom":false,"presets":{…}}`, while keeping its
  existing `VideoCamera`/`Camera`/`ObjectDetector`/NVR/HomeKit mixins.

## Layout

| File | What it does |
| --- | --- |
| `src/foscamTalk.ts` | The low-level protocol client: handshake, login, keepalive, speaker on/off, real-time paced talk frames. No Scrypted dependency. |
| `src/foscamCgi.ts` | Foscam CGI client: pan/tilt, presets, speed, speaker volume. Throws on any non-zero `<result>`. |
| `src/mixin.ts` | The mixin device: `Intercom` (ffmpeg → 8 kHz mono s16le → talk frames) and `PanTiltZoom`. |
| `src/main.ts` | Plugin: settings, `MixinProvider`, the two self-test buttons. |
| `src/selfTest.ts` | The talkback self-test, including the Goertzel sweep detector it judges with. |
| `src/sdkFix.ts` | Same `@scrypted/sdk` static-injection workaround the Kibble plugin needs; every module takes `sdk` from here. |

## Firmware cross-check: G.726 is native, PCM plays better

A static analysis of the firmware disagrees with the acoustic measurement, and both results are
kept here because the disagreement is load-bearing.

The `app` image decrypts with `openssl enc -d -aes-128-cbc -md md5 -k "WWZ7zy*v2"` (the key the
camera's own `FirmwareUpgrade`/`webService` binaries reconstruct via a string-obfuscation
routine). Foscam rotated that key somewhere between `2.91.2.72` (Mar 2022) and `2.91.2.76`
(Sep 2023), so `2.91.2.80` — the version this camera runs — stays encrypted; the analysis is of
`2.91.2.72`, the same "J"-platform userland (the R2C, R2M, MPS2011 and MPS2013 all ship the
identical `FosIPC_J_app`/`FosIPC_J_sys` images, stated in each release's own `Read me.txt`).
Note that foscam.com overwrites the file behind a download id on every release, so historical
builds only survive on foscam.eu under stable per-version ids.

In that image, the talk path decodes **G.726 ADPCM at 16 kbit/s** (2 bits/sample, 8 kHz), 120-byte
frames — exactly symmetric with the 120-byte audio portion of the camera's own outbound command
27 frames, packed oldest-sample-first (`byte = c0<<6 | c1<<4 | c2<<2 | c3`).

Live A/B on the camera, same three-tone signal at the same level, measured from its own RTSP
microphone track (peak height as a multiple of the noise-floor median):

| cmd 6 format | 1000 Hz | 2500 Hz | 400 Hz |
| --- | --- | --- | --- |
| raw PCM 8 kHz, 960-byte frames | **194×** | 38× | 1× |
| G.726-16k, 120-byte frames | 5× | 2× | 0× |

Both formats play at correct pitch and correct duration, which rules out either being
misinterpreted (reading PCM as 2-bit ADPCM would stretch time and drop pitch eightfold, and a
300→3200 Hz chirp comes back with the right sweep rate). The camera therefore appears to dispatch
on payload length. Raw PCM reproduces far more strongly, so that is what this plugin sends; the
G.726 path is documented in case a future firmware drops the PCM branch. The missing 400 Hz in
both rows is the camera's speaker, not the codec.

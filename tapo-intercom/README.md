# Tapo Intercom (Scrypted plugin)

Gives TP-Link Tapo cameras working **local** two-way audio in Scrypted, including models the
first-party `@scrypted/tapo` two-way audio mixin can never authenticate against. It is a mixin,
so it attaches to the camera device Scrypted already has and leaves streaming, recording and
HomeKit publishing alone.

Built against three cameras, and the differences between them are the whole story:

| Camera | Model | Firmware | With the first-party plugin | Cause |
| --- | --- | --- | --- | --- |
| Plant Room `192.168.4.188` | C225 | 1.3.1 Build 260514 | works | — |
| Tool Room `192.168.4.174` | C120 | 1.9.2 Build 260311 | works | — |
| Bird `192.168.4.201` | C120 | 1.4.3 Build 251111 | **hard 401, always** | see below |

## The bug this fixes

Tapo's talk endpoint (`POST http://<ip>:8800/stream`, plain HTTP) answers the first request with
an HTTP Digest challenge:

```
WWW-Authenticate: Digest realm="TP-Link IP-Camera", algorithm="MD5", encrypt_type="3",
                  qop="auth", nonce="...", opaque="64943214654649846565646421"
```

`encrypt_type="3"` means "derive the digest password as SHA256 of the Tapo cloud password"
(otherwise MD5). Upstream trusts that flag outright
(`plugins/tapo/src/tapo-api.ts`: `const useSHA256 = wwwAuthenticate.includes('encrypt_type="3"')`).

**On real hardware that flag is not reliable.** Measured against all three cameras, each
advertising `encrypt_type="3"`:

```
192.168.4.188  C225  fw 1.3.1  advertises sha256, accepts sha256
192.168.4.174  C120  fw 1.9.2  advertises sha256, accepts sha256
192.168.4.201  C120  fw 1.4.3  advertises sha256, accepts MD5 ONLY   <-- 401s forever upstream
```

So this client tries the advertised derivation, falls back to the other one on 401, and reports
which actually worked (`TapoClient.auth.used` vs `.advertised`, surfaced in the plugin log and
the self-test output). With the fallback, the Bird camera returns a talk session immediately:

```
PLANT C225 (control)   advertised=sha256 used=sha256 session=71 muxHeader=376B
BIRD  C120 fw1.4.3     advertised=sha256 used=md5    session=68 muxHeader=376B
TOOL  C120 fw1.9.2     advertised=sha256 used=sha256 session=73 muxHeader=376B
```

Two other things that cost time and are worth knowing:

* **`qop=auth` is mandatory.** The older RFC 2069 digest form (no qop/nc/cnonce) 401s on all
  three cameras, which looks identical to a wrong password.
* **`algorithm="MD5"` and `encrypt_type` are different things.** The digest hashing is always
  MD5; `encrypt_type` only selects how the *password* is hashed. Conflating them produces a 401
  that also looks like bad credentials.

## Is this cloud-dependent? No.

The secret is a hash of the Tapo **cloud account** password, but the camera verifies it locally —
nothing is sent to TP-Link. Verified by sampling the host's connection table through a full talk
session: the only camera connections were `192.168.4.201:8800` (talk) and `:554` (RTSP), and no
non-private destination appeared at all.

The local "camera account" (Tapo app → Advanced Settings → Camera Account) is **not** accepted by
the talk endpoint — it works for RTSP and ONVIF only — so the cloud password cannot be avoided as
a *local secret* on these models. This plugin uses it only for that, and uses the camera account
separately for the self-test's RTSP listen-back.

Also ruled out by measurement on these cameras, so nobody re-chases them:

* **ONVIF backchannel does not exist on any of them.** `DESCRIBE /stream1` with
  `Require: www.onvif.org/ver20/backchannel` returns SDP byte-identical to a plain DESCRIBE
  (H264 + PCMA, both receive-only), and RTSP `OPTIONS` has no `ANNOUNCE`/`RECORD`. If a camera
  in Scrypted carries an `onvifTwoWay: "true"` setting, that flag is inert.
* **"Third-Party Compatibility"** in the Tapo app was already enabled throughout, so it is not
  the explanation for any of this.

## Protocol

After the digest 200, the same socket becomes a bidirectional multipart stream. Client parts are
framed `----client-stream-boundary--`, the camera's replies `----device-stream-boundary--`.

1. Talk session: send a part `Content-Type: application/json` with body
   `{"params":{"talk":{"mode":"aec"},"method":"get"},"seq":N,"type":"request"}` — `method` lives
   *inside* `params`; a flat `method` returns HTTP 400. The camera replies with a JSON part
   carrying `params.session_id`.
2. Audio: parts of `Content-Type: audio/mp2t` with `X-If-Encrypt: 0` and
   `X-Session-Id: <session_id>`, body = MPEG-TS.
3. Audio format: **G.711 A-law, 8 kHz, mono**, muxed into MPEG-TS on PID 68 with Tapo's private
   stream type **0x90**. (A research pass claimed 0x6F; that is wrong and produces silence.)
   Paced in real time — 320 A-law bytes is exactly 40 ms.

If the part framing is even slightly wrong the camera does not error: it silently never replies.
A request timeout here almost always means framing, not connectivity.

## Verifying it

`Test Talkback` plays a 300→3200 Hz sweep and records the camera's own RTSP audio to check the
sweep comes back, because these cameras will happily accept a session and every audio part while
playing nothing.

**Caveat that matters, learned the hard way:** both C120s report `aec: 1` in `getAudioSpec`, i.e.
they echo-cancel their own speaker out of their microphone. On those models a *negative* acoustic
result does not prove silence — it may simply be cancellation. During this work a C120 was
wrongly diagnosed as "silent" on exactly that mistake, and was in fact audible to a person in the
room. Treat a failed acoustic check on an AEC camera as inconclusive and confirm by ear; the
C225, which does not AEC, records its own speaker fine and is a good control.

## Install

```sh
cd tapo-intercom
npm install --include=dev          # this machine sets npm omit=dev globally; without the flag the
                                   # webpack terser plugin is pruned and the build fails
NODE_ENV=production npm run build
NODE_TLS_REJECT_UNAUTHORIZED=0 npx scrypted-deploy <scrypted-host>:10443

SCRYPTED_URL=https://<host>:10443 SCRYPTED_USER=… SCRYPTED_PASS=… \
TAPO_CAMERA_NAME="Bird Camera" TAPO_HOST=192.168.4.201 TAPO_CLOUD_PASS=… \
TAPO_RTSP_USER=… TAPO_RTSP_PASS=… node tools/configure.mjs
```

`configure.mjs` also **removes the first-party "Tapo Two Way Audio" mixin** from that camera.
Leave both attached and there are two `Intercom` implementations on one device, with the broken
one able to win. If the camera is already in HomeKit, reload the HomeKit plugin afterwards so the
accessory re-advertises with two-way audio.

## Layout

| File | What it does |
| --- | --- |
| `src/tapoClient.ts` | Protocol client: digest auth with derivation fallback, the multipart stream, talk session, MPEG-TS muxing. Pure Node. |
| `src/digestAuth.ts` | The `qop=auth` digest header these cameras require. |
| `src/mpegts.ts` | MPEG-TS muxer (PAT/PMT/PES), written from go2rtc's MIT-licensed muxer — see the file header for provenance. |
| `src/mixin.ts` | The mixin: `Intercom` via ffmpeg → A-law → MPEG-TS, paced. |
| `src/main.ts` | Plugin: settings, `MixinProvider`, self-test button. |
| `src/selfTest.ts` | Talkback self-test, A-law encoder and sweep detector. |
| `tools/configure.mjs` | Applies settings, removes the upstream mixin, attaches this one. |

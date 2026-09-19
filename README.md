<img src=".github/assets/icon.svg" width="96" align="right" alt="">

# Scrypted two-way audio plugins for cameras that lie about their capabilities

Three Scrypted mixin plugins that add working two-way audio (and, for Foscam, pan/tilt) to
cameras where the standards-based path does not exist or where the first-party plugin cannot
authenticate:

| Plugin | Cameras | Why it exists |
| --- | --- | --- |
| [`foscam-intercom`](foscam-intercom) | Foscam R2C | no ONVIF backchannel, no RTSP backchannel, no CGI talk command — uses Foscam's proprietary protocol on the media port, plus PTZ over CGI |
| [`reolink-intercom`](reolink-intercom) | Reolink RLC-833A (and likely other non-doorbell Reolinks) | Reolink cameras have no ONVIF backchannel (only doorbells do) — uses the Baichuan protocol on TCP 9000 |
| [`tapo-intercom`](tapo-intercom) | TP-Link Tapo C120, C225 | the first-party plugin trusts an auth flag the cameras get wrong, and 401s forever on some of them |

Each plugin's own README documents its protocol at byte level, including the specific details that
cause silent failure. **The single most useful thing in this repository is arguably the
[verification trap](#the-verification-trap--read-this-before-believing-any-test) section** — many
of these cameras echo-cancel their own speaker, so they cannot hear themselves, and a naive
"play a tone and listen" test reports a working camera as broken.

Licensed ISC; see `NOTICE.md` for third-party attribution (the MPEG-TS muxer derives from
go2rtc, MIT).

Written up 2026-09-19 after getting talkback working on five cameras that all presented the same
symptom: a talk button in HomeKit that did nothing. Addresses and device names below are from the
author's own install; treat them as examples.

**If a camera goes quiet, start at [Triage](#triage-when-a-camera-goes-quiet).**

## Current state

| Camera | Address | Model | Talkback provided by | PTZ provided by |
| --- | --- | --- | --- | --- |
| Gym | 192.168.4.143 | Foscam R2C | `foscam-intercom` (ours) | `foscam-intercom` (ours) |
| Office | 192.168.1.103 | Reolink RLC-833A | `reolink-intercom` (ours) | Scrypted `ONVIF PTZ` mixin |
| Plant Room | 192.168.4.188 | Tapo C225 | `tapo-intercom` (ours) | Scrypted `ONVIF PTZ` mixin |
| Bird | 192.168.4.201 | Tapo C120 | `tapo-intercom` (ours) | none |
| Tool Room | 192.168.4.174 | Tapo C120 | `tapo-intercom` (ours) | none |

The plugins live in this workspace and are deployed to Scrypted at
`https://scrypted.local:10443` (BeastNAS, tailnet address) with `npx scrypted-deploy`.

The first-party `@scrypted/tapo` plugin has been **uninstalled** — it cannot authenticate to at
least one of these cameras (see below), and running two Intercom implementations on one device is
ambiguous. `@scrypted/reolink` is still installed (it provides the Office camera itself) but its
`useOnvifTwoWayAudio` setting is deliberately **off**.

## The one idea behind all five fixes

Every single failure was a device **advertising a capability or a protocol dialect it does not
honour**, and Scrypted believing it:

* Reolink: Scrypted advertised `Intercom` because `useOnvifTwoWayAudio` was on, but the camera
  has no ONVIF backchannel at all, so `startIntercom` threw `ONVIF audio backchannel not found`.
* Tapo: every camera's auth challenge says `encrypt_type="3"` (meaning "hash the password with
  SHA256"), and one of them accepts **only** the MD5 hash. Upstream trusts the flag, so it 401s
  there forever.
* Tapo ONVIF: all three carried `onvifTwoWay: "true"` while exposing no ONVIF audio output
  whatsoever. Now set to false.

So: **do not trust a capability flag. Ask the device, then verify by listening.**

## Why each camera needs what it needs

### Gym — Foscam R2C → `foscam-intercom`
No standards-based audio-in exists: ONVIF answers `AudioOutputNotSupported`, the RTSP server is a
LIVE555 build from 2014 with no backchannel and no `ANNOUNCE`, and the CGI API has no talk
command. Talkback goes over Foscam's proprietary protocol on the media port (88). The critical
detail is the speaker-on payload shape; full protocol notes in `foscam-intercom/README.md`.
This plugin also provides pan/tilt over the Foscam CGI API.

### Office — Reolink RLC-833A → `reolink-intercom`
Reolink cameras (as opposed to Reolink **doorbells**) have no ONVIF backchannel, and no firmware
will add it — v3.1.0.3016 is the last firmware for hardware `IPC_523D88MP`. Talkback goes over
Reolink's Baichuan protocol on TCP 9000. The critical detail: ADPCM blocks must be
`lengthPerEncoder / 2 + 4` = **516** bytes; at 1024 the camera acknowledges everything and plays
silence. Full notes in `reolink-intercom/README.md`.

### All three Tapo → `tapo-intercom`
Talkback goes over Tapo's own protocol on port 8800 (HTTP Digest, then a multipart stream, then
G.711 A-law in MPEG-TS with Tapo's private stream type `0x90`). Two reasons this is a custom
plugin rather than the first-party one:

1. **The auth dialect is per-device and unpredictable.** Two C120s on *byte-identical* firmware
   (1.9.3 Build 260521), identical `hw_id` and `oem_id`, disagree about which password hash they
   accept. It is not the model and not the firmware — it appears to be the credential the Tapo
   app provisioned when each camera was paired, which firmware updates do not rewrite. Our client
   tries what the camera advertises, falls back to the other, and logs which worked.
2. **A cloud-password change does not reach all cameras at once.** After rotating the Tapo account
   password, both C120s had the new password within minutes while the C225 still required the old
   one. Hence the optional `Previous Tapo Cloud Password` setting — clear it once every camera
   reports `current`.

Full notes in `tapo-intercom/README.md`.

## Quality, latency and reliability — measured

**Quality is capped by the hardware, not by this code.** The Tapo talk path plays **8 kHz G.711
A-law and nothing else**. Proven by feeding the same 1 kHz tone encoded at two rates and
recovering it from the camera's own microphone: fed as 8 kHz it came back at 1000 Hz, fed as
16 kHz it came back at ~496 Hz, i.e. the camera replayed it at 8 kHz regardless. The
`device_speaker.sampling_rate: ["16","8"]` in `getAudioSpec` does NOT apply to this path. So
~3.4 kHz voice bandwidth is the ceiling for any client, the Tapo app included — there is no
quality left on the table.

**Latency** added by this plugin: ffmpeg transcode (started with `-fflags nobuffer -flags
low_delay -probesize 32 -analyzeduration 0`), one 40 ms frame of framing, and LAN transit —
roughly 60–100 ms on top of whatever the caller (HomeKit/WebRTC) already costs. The queue is
capped at 1 s and drops the OLDEST audio rather than letting lag grow without bound. The frame
size is the one tuning knob (`FRAME_BYTES` in `mixin.ts`, 320 B = 40 ms); 20 ms frames were
observed to play correctly but were not proven a measurable improvement, so the value matching
upstream's RTP framing was kept. The Tapo app was never instrumented, so "comparable to the app"
is inference from the shared 8 kHz path, not a measurement.

**Reliability**, verified rather than assumed:
* A talk session tears down cleanly — microphone room noise on the RTSP stream measured rms 766
  before a session and rms 1982 after, i.e. the camera is not left in a degraded state.
* These cameras are `half_duplex`, so while a talk session is open the mic audio on the RTSP
  stream is suppressed. **Overlapping talk sessions therefore make acoustic measurements read as
  silence** — this wasted real time during development. Run one session at a time when measuring.
* Known gap: there is **no mid-call auto-reconnect**. If the camera drops the stream mid-talk the
  call ends and the user presses talk again.

## Credentials, and how they drift

Three separate secrets, which do NOT change together:

| Secret | Used for | State after the 2026-09-19 password rotation |
| --- | --- | --- |
| Tapo **cloud** password (hashed) | talkback on :8800 | Bird + Tool Room adopted the new one within minutes; Plant Room still required the OLD one |
| Local control API (`stok` login) | pytapo / camera settings | follows the cloud password, same lag per camera |
| **Camera account** (`cameraaccount`) | RTSP and ONVIF | unchanged by the rotation |

This is why the plugin has both `Tapo Cloud Password` and `Previous Tapo Cloud Password`, and why
the RTSP credentials are configured separately. Rotating the account password without the
fallback set would have silently broken talkback on whichever cameras had not yet synced.

## Is any of this cloud-dependent? No.

Tapo talkback uses a hash of the **Tapo cloud account password** as the secret, but the camera
verifies it locally. Verified by sampling the host's connection table through a live talk session:
the only camera connections were `:8800` (talk) and `:554` (RTSP), and no non-private destination
appeared at all. The local "camera account" (`cameraaccount`) is *not* accepted by the talk endpoint —
it works for RTSP and ONVIF only — so the cloud password cannot be eliminated, only kept local.

## The verification trap — read this before believing any test

Several of these cameras **echo-cancel their own speaker out of their own microphone**
(`aec: 1` on the Tapo C120s; the Reolink does it too). On those cameras, playing audio and failing
to hear it through the camera's own mic **proves nothing** — talkback can be working perfectly.

This actually happened here: a Tapo C120 was diagnosed as "silent" on exactly that inference and
was in fact clearly audible to a person standing in the room. Both self-tests therefore report
`INCONCLUSIVE`, never `FAIL`, when the sweep does not return; only a protocol failure is a FAIL.

Cameras that do **not** echo-cancel (Foscam R2C, Tapo C225) record their own speaker happily and
make good controls.

**The only conclusive test of audibility is a human ear, or the talk button in HomeKit.**

## Triage: when a camera goes quiet

1. **Is it a protocol failure or a silent one?** Run the plugin's self-test:
   ```sh
   cd tapo-intercom   # or reolink-intercom / foscam-intercom
   SCRYPTED_URL=https://scrypted.local:10443 SCRYPTED_USER=… SCRYPTED_PASS=… node tools/selftest.mjs
   ```
   A protocol failure names itself (401, no session, timeout). `INCONCLUSIVE` means the protocol
   is fine and you need to listen.

2. **Tapo 401?** Check the dialect — takes 5 seconds and distinguishes "wrong password" from
   "different derivation" from "different protocol entirely":
   ```sh
   python3 /tmp/tapo_digest2.py     # recreate from tapo-intercom/README.md if /tmp was cleared
   ```
   The plugin already falls back between SHA256 and MD5 and between the current and previous
   password, so a 401 here means something new: a factory reset/re-pair (dialect changed), a
   password change not recorded in the plugin, or a firmware that moved to KLAP auth (not
   implemented — would need adding to `tapoClient.ts`).

3. **A talk button that does nothing, with no error?** Look for a dead capability flag:
   `useOnvifTwoWayAudio` on Reolink, `onvifTwoWay` on the ONVIF-provided cameras. If a device
   advertises `Intercom` from a flag rather than from one of these plugins, that is the bug.

4. **Changed the Tapo account password?** Put the old one in `Previous Tapo Cloud Password` and
   the new one in `Tapo Cloud Password`, then re-run the self-test on each camera; the
   `auth ok: used … with the … cloud password` line tells you which cameras have caught up.

5. **After any change that affects HomeKit**, reload the HomeKit plugin so accessories
   re-advertise two-way audio — every `tools/selftest.mjs` does this at the end. A camera whose
   audio works in Scrypted but not HomeKit usually just needs this.

## Useful commands

```sh
# deploy a plugin after editing it (note --include=dev: npm omit=dev is set globally here,
# and without the flag the webpack terser plugin is pruned and the build fails)
cd <plugin> && npm install --include=dev && NODE_ENV=production npm run build \
  && NODE_TLS_REJECT_UNAUTHORIZED=0 npx scrypted-deploy scrypted.local:10443

# attach a plugin to a camera (and remove the upstream mixin where applicable)
node tools/configure.mjs        # see each README for the env vars

# Tapo: A/B a camera against the first-party plugin, then restore (reversible)
cd tapo-intercom && TAPO_CAMERA_NAME="Bird Camera" node tools/ab_upstream.mjs

# Tapo: turn off the inert ONVIF two-way flags
cd tapo-intercom && node tools/clear-onvif-twoway.mjs
```

`~/.scrypted/login.json` holds the deploy credentials; `scrypted-deploy` needs it.

## Deliberate decisions, so they are not "fixed" later by mistake

* **`useOnvifTwoWayAudio` (Reolink) and `onvifTwoWay` (Tapo) stay OFF.** They advertise
  capabilities these cameras do not have. Turning them on re-creates the original bug.
* **`@scrypted/tapo` stays uninstalled.** It cannot authenticate to the Bird camera on any
  firmware released so far.
* **Tapo auto-upgrade stays OFF** (it already is, on all three). It is what stops a working
  camera breaking unattended at 03:00.
* **The self-tests do not fail on a missing sweep.** That is not laziness; see the verification
  trap above.
* **The Foscam is not firmware-updated.** Its talkback rides an undocumented protocol validated
  against build 2.91.2.80 specifically.

## Published copy on GitHub

A sanitized snapshot of the three plugins plus this document is pushed to
**https://github.com/nphil/scrypted-intercom** (PUBLIC, ISC licensed). The sanitising replaces
the Scrypted host with `scrypted.local` and the camera account name with `cameraaccount`; no
passwords were ever in these files (all credentials come from Scrypted settings or environment
variables). History was squashed to a single commit before publishing, deliberately: the first
draft had vendored an unlicensed file and it needed to be gone from history, not just from HEAD.

**Licensing, in case it comes up:** `tapo-intercom/src/mpegts.ts` is written from go2rtc's
`pkg/mpegts/muxer.go` (MIT), NOT copied from Scrypted's Tapo plugin. Scrypted's copy sits in a
directory with no licence grant (its root `LICENSE.md` defers licensing per directory and
`plugins/tapo` declares none), so it cannot be redistributed. The rewrite was verified on the
hardware: test sweeps through a Tapo C120 were confirmed audible before the vendored file was
deleted.

**The deployed source of truth is this workspace, not GitHub** — `scrypted-deploy` runs from
`foscam-intercom/`, `reolink-intercom/` and `tapo-intercom/` here. So after changing a plugin,
refresh the published copy deliberately:

```sh
rm -rf /tmp/pub/scrypted-intercom/{foscam,reolink,tapo}-intercom
cd /tmp/pub/scrypted-intercom && git pull
for p in foscam-intercom reolink-intercom tapo-intercom; do
  mkdir -p $p && cp -r ~/$p/{src,tools,package.json,tsconfig.json,webpack.nodejs.config.js,README.md} $p/
done
cp ~/CAMERA_TALKBACK.md README.md          # then re-apply the repo README header, see git history
grep -rl "<scrypted-host-ip>\|<camera-account>" . | xargs -r sed -i \
  "s/<scrypted-host-ip>/scrypted.local/g; s/<camera-account>/cameraaccount/g"
git add -A && git commit -m "…" && git push
```

Before every push, re-run the secret scan:

```sh
grep -rniE "<your-password-fragments>" --include=*.ts --include=*.mjs --include=*.md .
```

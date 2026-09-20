<img src=".github/assets/icon.svg" width="96" align="right" alt="">

# Scrypted two-way audio for cameras that lie about their capabilities

One Scrypted plugin, `camera-intercom`, that adds working two-way audio (and vendor pan/tilt) to
cameras where the standards-based path does not exist, or where the first-party plugin cannot
authenticate. Drivers live behind one interface, so a new camera is a new driver file rather than
a new plugin:

| Driver | Devices | Why it exists |
| --- | --- | --- |
| `onvif-backchannel` | anything implementing Profile T two-way audio (Amcrest/Dahua, Hikvision, Reolink **doorbells**, the author's own feeder firmware) | the standards-based path — tried first, and the only driver that is not a vendor workaround |
| `foscam` | Foscam R2C | no ONVIF backchannel, no RTSP backchannel, no CGI talk command — Foscam's proprietary protocol on the media port, plus PTZ over CGI |
| `reolink` | Reolink RLC-833A (and likely other non-doorbell Reolinks) | Reolink *cameras* have no ONVIF backchannel, only doorbells do — the Baichuan protocol on TCP 9000 |
| `tapo` | TP-Link Tapo C120, C225 | the first-party plugin trusts an auth flag the cameras get wrong, and 401s forever on some of them |

The protocols are documented at byte level at the top of each file in `src/protocols/`, including
the specific details that cause silent failure.

**The two most useful things here are arguably the
[verification trap](#the-verification-trap--read-this-before-believing-any-test) — these cameras
echo-cancel, so they cannot hear themselves and a naive "play a tone and record it" test reports a
working camera as broken — and
[Making it sound good](#making-it-sound-good-which-was-a-separate-problem-entirely), which is four
different faults that all sounded identical.**

Licensed ISC; see `NOTICE.md` for third-party attribution (the MPEG-TS muxer derives from
go2rtc, MIT).

Addresses and device names below are from the author's own install, with addresses rewritten;
treat them as examples.

---

**If a camera goes quiet, start at [Triage](#triage-when-a-camera-goes-quiet).**

## Current state

One plugin, `@nphil/camera-intercom`, serves every device. It replaced three separate per-vendor
plugins (`foscam-intercom`, `reolink-intercom`, `tapo-intercom`, all now uninstalled) so a new
camera means a new driver file, not a new plugin.

| Camera | Address | Model | Driver | PTZ provided by |
| --- | --- | --- | --- | --- |
| Gym | 10.0.0.11 | Foscam R2C | `foscam` | `Vendor PTZ` mixin (Foscam CGI) |
| Office | 10.0.0.12 | Reolink RLC-833A | `reolink` | Scrypted `ONVIF PTZ` mixin |
| Plant Room | 10.0.0.13 | Tapo C225 | `tapo` | Scrypted `ONVIF PTZ` mixin |
| Bird | 10.0.0.14 | Tapo C120 | `tapo` | none |
| Tool Room | 10.0.0.15 | Tapo C120 | `tapo` | none |
| Cat Feeder | 10.0.0.16 | LibreFeed (our firmware) | `onvif-backchannel` | none |

All six verified by ear on 2026-09-19: clean, continuous, full level.

Two Scrypted devices come from the plugin: **Camera Intercom** (the talkback mixin) and **Vendor
PTZ** (a separate mixin provider — `canMixin` cannot see the device, so one combined provider
would advertise dead `PanTiltZoom` on cameras that have none).

Deployed to Scrypted at `https://scrypted.local:10443` (the author's server, over a tailnet) with
`npx scrypted-deploy`.

Not ours, deliberately left alone: **Back Door** and **Front Door** are Reolink *doorbells*,
which genuinely do implement the ONVIF backchannel, so they keep working on `@scrypted/reolink`.
**Backyard** is dead hardware. The first-party `@scrypted/tapo` is **uninstalled** (it cannot
authenticate to one of these cameras); `@scrypted/reolink` stays, with `useOnvifTwoWayAudio`
deliberately **off**.

## The one idea behind all the protocol fixes

Every protocol failure was a device **advertising a capability or a protocol dialect it does not
honour**, and Scrypted believing it:

* Reolink: Scrypted advertised `Intercom` because `useOnvifTwoWayAudio` was on, but the camera
  has no ONVIF backchannel at all, so `startIntercom` threw `ONVIF audio backchannel not found`.
* Tapo: every camera's auth challenge says `encrypt_type="3"` (meaning "hash the password with
  SHA256"), and one of them accepts **only** the MD5 hash. Upstream trusts the flag, so it 401s
  there forever.
* Tapo ONVIF: all three carried `onvifTwoWay: "true"` while exposing no ONVIF audio output
  whatsoever. Now set to false.

So: **do not trust a capability flag. Ask the device, then verify by listening.**

## Making it sound good, which was a separate problem entirely

Getting each protocol to accept audio did not make any of it sound *right*. Four distinct faults
produced near-identical symptoms — "beep, pause, then continuous" — and each needed its own
evidence. The pump in `src/mixin.ts` now holds three invariants, each earned:

| Fault | How it sounded | Cause | Fix |
| --- | --- | --- | --- |
| Per-frame ADPCM reset | pulsing tone, ticks | encoder state reset every frame (pre-existing in the old Reolink plugin) | one encoder per session |
| Device warm-up | short beep, gap, then fine | device drops audio while its speaker path opens | open the session on `WARMUP_MS` (300 ms) of **silence** |
| Pacing debt | gap after any startup stumble | on underrun the clock kept accruing debt, then fired frames back-to-back to catch up — and every device **discards** faster-than-real-time audio, so the burst was binned | never carry debt; reset the clock to now |
| ffmpeg's ragged start | beep, pause, then continuous | ffmpeg's first read lands early as a lump, then pauses; the pump faithfully rendered that shape | hold a `LEAD_MS` (250 ms) buffer before real audio flows; re-earn it after a stall |

Plus: the stream is **continuous** — when the source has nothing ready the frame is silence, never
a hole — and the downsample from HomeKit's 16/24 kHz Opus uses soxr with triangular dither where
ffmpeg has it (probed once, falls back safely).

**The feeder needed the opposite of every camera.** Vendor cameras *discard* early audio, so the
pump sends at exactly real time. Our own firmware *queued* what it was sent and wrote it straight
into ALSA with no jitter buffer, so exact-real-time pacing left zero slack and scheduler jitter
became underruns. That is now fixed in the firmware (`librefeed`: 120 ms preroll, silence
concealment, 500 ms cap, and it logs `concealed`/`dropped` counts), which benefits every
backchannel client rather than just this plugin. `format.prebufferMs` — set **only** by the
`onvif-backchannel` driver — fills that preroll immediately instead of waiting for it.

### Two instrument traps that cost real time

1. **`lavfi`'s `sine` generates at about −18 dBFS.** A tone played through the plugin sounded
   "quieter and different" than a Python sender at 0.8 full scale — 16 dB of it was the
   *generator*. Any loudness judgement made with a raw `sine` is measuring ffmpeg, not the path.
   Lift it (`-af volume=6.3`) before believing anything about level.
2. **ffmpeg lets the last `-af` win.** Adding the resampler as `-af aresample=…` silently
   discarded the caller's entire filter chain — it ate the `volume=` above and presented exactly
   as "the device plays quietly". Resampler settings therefore go in as swresample *output
   options* (`-resampler soxr -precision 28 -dither_method triangular`), which compose.

## Why each camera needs what it needs

### Gym — Foscam R2C → `foscam` driver
No standards-based audio-in exists: ONVIF answers `AudioOutputNotSupported`, the RTSP server is a
LIVE555 build from 2014 with no backchannel and no `ANNOUNCE`, and the CGI API has no talk
command. Talkback goes over Foscam's proprietary protocol on the media port (88). The critical
detail is the speaker-on payload shape; full protocol notes at the top of
`camera-intercom/src/protocols/foscamTalk.ts`. Pan/tilt comes from the same plugin's `Vendor
PTZ` mixin over the Foscam CGI API (`src/protocols/foscamCgi.ts`).

### Office — Reolink RLC-833A → `reolink` driver
Reolink cameras (as opposed to Reolink **doorbells**) have no ONVIF backchannel, and no firmware
will add it — v3.1.0.3016 is the last firmware for hardware `IPC_523D88MP`. Talkback goes over
Reolink's Baichuan protocol on TCP 9000. The critical detail: ADPCM blocks must be
`lengthPerEncoder / 2 + 4` = **516** bytes; at 1024 the camera acknowledges everything and plays
silence. Full notes in `camera-intercom/src/protocols/baichuan.ts`.

### All three Tapo → `tapo` driver
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

Full notes in `camera-intercom/src/protocols/tapoClient.ts`.

## The doorbells, and what "poor quality/latency" actually was (2026-09-19)

Front Door and Back Door are **Reolink Video Doorbell PoE-W** (fw v3.0.0.6460), wired PoE. They
were on the stock `@scrypted/reolink` intercom, which works -- but over the ONVIF backchannel,
and that backchannel offers **`PCMU/8000` only** (read from the device's own SDP). Their vendor
protocol on port 9000 carries **16 kHz ADPCM**, so both are now on the `reolink` driver: double
the bandwidth for the caller's voice, plus this plugin's pacing.

Upstream's `onvif-intercom.ts` also holds three latency costs this path does not:

| Stock ONVIF intercom | This plugin |
| --- | --- |
| aggregates packets up to **160 ms** before sending | 64 ms frames, sent when due |
| holds **one packet back permanently** (`pending`), so an utterance's last packet waits for the next | no hold |
| forwards RTP with no pacing or jitter handling -- HomeKit's jitter reaches the device as cut-outs | paced, debt-free, silence-filled |
| no warm-up, so the device eats the first words | 300 ms of silence first |

### Latency, measured rather than guessed

Reported symptom was 1-2 s from speaking to hearing it. The plugin now records every session
(`Recent Talk Sessions` setting, or `node tools/sessions.mjs`), including **`OUR LATENCY`**: the
age of the audio at the moment it goes on the wire, which is exactly this pipeline's contribution.

* **Ours: 109-114 ms average, 160-190 ms peak** -- close to the lead, as designed.
* A **latency cap** replaced an earlier memory cap. The queue was bounded at 3 s (raised while
  worrying about clipping the caller's first word), and since the pump drains at exactly real time
  and never faster, any burst from the source became a backlog that persisted for the whole
  session. It is now `lead + 120 ms`, and audio beyond that is dropped rather than carried as
  delay.
* The **warm-up no longer builds a backlog**: it discards what arrives during the window instead
  of queueing it behind the silence. Before, a session opened by sending silence while real audio
  piled up, then threw ~600 ms of it away to hold the cap -- measured as +780 ms of added delay.
* **Low-latency RTSP input flags** (`-max_delay 0 -reorder_queue_size 0`) are added when the
  caller hands us an `rtsp://` input, which HomeKit always does: it re-serves the phone's Opus
  through a local RTSP server, and ffmpeg's RTSP demuxer defaults to half a second of buffering.
* Wired devices run a **120 ms lead** instead of 250 ms (`leadOverrides`, per host: both doorbells
  and the Office camera). Confirmed clean by ear at 120 ms. The wifi cameras keep the default,
  where the lead absorbs real jitter.

Remaining delay is not in this plugin: HomeKit encodes Opus on the phone, ships it over wifi to
Scrypted, Scrypted re-serves it through a local RTSP server, we decode and re-encode, then the
device buffers before its speaker. A differential measurement (same tone, once through a direct
Baichuan sender and once through Scrypted, both captured in one recording off the camera's own
RTSP audio) put the whole Scrypted path at +778 ms *at session start*; steady-state ours is the
109-114 ms above.

### Four artifacts chased on the Office camera, and what each actually was (2026-09-19)

All four presented as "the audio sounds wrong", and only two were this plugin's fault. Worth
reading before tuning anything here, because three of them are instrument or device behaviour:

| Reported as | Cause | Resolution |
| --- | --- | --- |
| "two tones overlaid", crackle | the latency cap had been tightened below the source's normal burst (~206 ms real clients, ~450 ms from lavfi), so it trimmed mid-stream; every trim is a discontinuity | trim only where it cannot be heard |
| "slight repeating rattle" | same cause, smaller | same fix; `dropped` in the telemetry is the check, and it should read 0 |
| "started loud, went quiet, garbled at the end" | the startup lump (~700 ms) was carried as standing delay for the whole session, so the device ran with a permanent backlog | shed the excess at PRIME time, where nothing has been sent yet and dropping is inaudible; latency went 592 ms -> 114 ms |
| "loud start then immediately quieter" | the CAMERA's automatic level control clamping a near-full-scale tone about a second in | not a fault; the tone tools now generate ~0.3 FS, below the knee |

Catch-up policy, as it now stands: the queue is bounded by latency (`lead + 150 ms`, floor
250 ms), and exceeding it drops the oldest audio **only when that audio is quiet** -- a pause
between words, which conversation supplies constantly. A caller who never pauses keeps their
latency rather than hearing holes punched in their speech, and the delay is recovered at the next
breath. A hard ceiling (1.2 s) still drops regardless, because past that the delay is worse than
a glitch. Priming is the exception: there the excess is dropped unconditionally, since no audio
has been sent yet and trimming only chooses where the stream starts.

Pacing holds the exact frame period on average and resyncs only after a gap larger than
`RESYNC_THRESHOLD_MS` (1 s). Resetting the clock on ordinary lateness makes the period
"frameMs + processing time", which starves the device slowly.

### The Office camera's audio ceiling is the device, not this code

Speech through the Office camera sounds tinny and gritty. That is the protocol, and it is worth
recording so it is not chased again:

* Its only talk path is Baichuan **IMA ADPCM, 4 bits per sample**. The camera exposes no ONVIF
  backchannel at all (Reolink cameras do not; only their doorbells do), so there is no 8-bit
  G.711 alternative to switch to -- `onvif-backchannel` against it fails with "offers no sendonly
  audio section", which is the correct answer, not a bug.
* Our encoder is not the problem: a round trip through it measures **27.6 dB SNR**, at the top of
  what 4-bit IMA ADPCM achieves. Verified by decoding our own blocks with the standard IMA
  algorithm and comparing against the input.
* **Reolink's own app sounds equally bad on the same camera** (owner's judgement). That is the
  ceiling, and we are at parity with the vendor.

Note wider is not automatically better here. The doorbells' ONVIF backchannel offers `PCMU/8000`:
narrower band than 16 kHz ADPCM, but 8 bits per sample against 4, so roughly 38 dB SNR against
27 dB. If a doorbell ever sounds gritty, `backchannelOverrides` (`host=port/path`) plus a
`driverOverrides` entry switches that camera to the standards-based path with this plugin's
pacing underneath, and the two can be compared by ear.

### Doorbell latency: the lowest-latency path, and where the rest of the delay lives

The doorbells accept BOTH talk protocols, and they are not equal:

| Path | Frames | This plugin's latency | Codec |
| --- | --- | --- | --- |
| Baichuan ADPCM 16 kHz | 64 ms | ~205 ms | 4 bits/sample |
| **ONVIF backchannel PCMU 8 kHz** | **20 ms** | **88-98 ms** | 8 bits/sample |

The backchannel wins on both counts that this plugin controls -- a third of the frame size and
half the pipeline latency -- and G.711 is 8 bits per sample against ADPCM's 4, so the narrower
band is not necessarily the worse sound. Front Door runs it (`backchannelOverrides`
`<host>=554/Preview_01_sub` plus a `driverOverrides` entry) and was confirmed clean by ear.

Reaching it needed a real fix: **the RTSP client never authenticated**. It was written against a
device with auth disabled, so `DESCRIBE` returned 401 and the driver reported "offers no sendonly
audio section" -- indistinguishable from a camera that genuinely has no backchannel. It now does
RFC 2617 digest per method (the response hashes METHOD and URI, so every request carries its own)
with `qop=auth` or the older no-qop form, and Basic as a fallback.

**The remaining 1-2 s the owner hears is not in this plugin.** Measured: 88-98 ms here, and the
device's own playback plus the RTSP capture path is a few hundred ms. Reolink's own app is
similarly laggy on the same doorbell, which puts a large buffer inside the camera's firmware --
unreachable from any client. What was ruled out along the way: `reolink_aio` (the Home Assistant
integration's library) implements no talkback at all, its `udp_protocol.py` is P2P discovery
rather than audio, and the doorbell's CGI exposes only `volume`/`visitorLoudspeaker` for talk
while `GetTalkAbility` answers "not support". There is no documented or undocumented buffer knob.

### Scrypted app talkback does not work on NVR-recorded cameras

Established by elimination on 2026-09-19, and NOT caused by this plugin:

| Camera | Scrypted NVR mixin | App talkback | HomeKit |
| --- | --- | --- | --- |
| Bird, Office | no | works | works |
| Front Door, Back Door, Cat Feeder | **yes** | nothing happens | works |

With NVR attached the app plays the camera through the NVR pipeline (`starting fork
@scrypted/nvr`, no WebRTC session in the log at all), and talkback lives inside the WebRTC
session control -- so there is no talk path to call. Proven by removing the NVR mixin from the
feeder: app talkback started working immediately, and came back on restoring it.

This is client-side, so it cannot be patched on the server the way the `offerDirection` bug was.
NVR 0.12.105 dates from August, so unlike that regression it is long-standing behaviour. The
practical position: **HomeKit is the intercom path for NVR-recorded cameras** and works on every
one of them; the app works on cameras without NVR.

### Office camera zoom: another dead capability

`ptzCapabilities` correctly says `{pan:false, tilt:false, zoom:true}`, and Scrypted's `ONVIF PTZ`
mixin accepted `ptzCommand` and returned success while the lens **never moved** -- verified with
the camera's own `GetZoomFocus` readback (21 before, 21 after). It also accepted *pan* commands on
a camera that reports no pan. The same move over Reolink's CGI went 4 -> 21.

Office now uses this plugin's `Vendor PTZ` over `protocols/reolinkCgi.ts` (timed `ZoomInc`/
`ZoomDec` bursts plus a mandatory `Stop`), with the ONVIF PTZ mixin detached. Verified through the
Scrypted UI's own buttons: 11 -> 5 -> 12. Every zoom logs its before/after position, so a silent
no-op cannot hide again.

### Mixin ORDER matters: providers before consumers

A Scrypted mixin sees the device as it exists BELOW itself (`mixinDeviceInterfaces`), and consumers
decide what to offer from that view -- the WebRTC plugin negotiates its audio as `sendrecv` only
when it can see `Intercom`, `recvonly` otherwise. With this plugin's mixin applied last, WebRTC
could not see it. `tools/reorder-mixins.mjs` moves `Camera Intercom` and `Vendor PTZ` to the front
of every camera's chain; run it after attaching to a new camera.

Note this was masked while the vendors' broken two-way flags were still on: they made the base
device advertise `Intercom` (a dead capability, but a visible one), so consumers saw it.

### Scrypted app talkback: a real bug in @scrypted/webrtc, and the local fix

**Symptom:** talkback from the Scrypted iOS and Android apps did nothing, on every camera --
including the **Ring** doorbell, whose intercom has nothing to do with this plugin. HomeKit
talkback worked everywhere throughout.

**Root cause** (found 2026-09-19 by instrumenting the installed plugin). `setPlaybackInternal` in
`@scrypted/webrtc` 0.2.89 picks the transceiver to receive the caller's microphone on:

```js
find(e => "audio" === e.receiver.track.kind &&
     ("sendrecv" === e.offerDirection || "recvonly" === e.offerDirection))
```

`offerDirection` is werift's record of a direction that arrived in a REMOTE offer. Scrypted's own
apps let the SERVER generate the offer, so it is `undefined` -- while the transceiver's own
`direction` is `sendrecv`. The find matches nothing and the function returns. Every failure path
in it is a bare `return`, so there is no log and no error anywhere:

```
TALKBACK-DEBUG 1 setPlayback called, options={"audio":true,"video":true} killed=false hasIntercom=true
TALKBACK-DEBUG 2 transceiver found=false offerDirection=undefined
              allDirections=[{"kind":"video","dir":"sendonly"},{"kind":"audio","dir":"sendrecv"}]
TALKBACK-DEBUG 2a BAILED: no audio transceiver offering sendrecv/recvonly
```

**Fix:** fall back to `direction` when `offerDirection` is unset -- the same information from the
local side of the negotiation. Applied to both sites that use the filter (`setPlaybackInternal`
and the `on-demand` audio branch):

```sh
cd camera-intercom
SCRYPTED_URL=… SCRYPTED_USER=… SCRYPTED_PASS=… tools/apply-webrtc-patch.sh
```

Confirmed working afterwards from the iOS app over Tailscale: `OUR LATENCY avg 96-127 ms`.

**This patch edits an installed plugin bundle and a WebRTC plugin update WILL wipe it.** The
untouched file is kept as `main.nodejs.js.orig` inside the container; re-run the script above
after an update, and check first whether upstream has fixed it. Worth reporting upstream: the
same one-line change in `plugins/webrtc/src/session-control.ts` fixes it for everyone.

**How much time this cost, and the lesson:** several wrong turns were taken first -- mixin
ordering, stream transcoding, the queue cap, the remote/Tailscale path -- because the failure was
completely silent. The thing that actually solved it was instrumenting the three bare `return`s.
When a code path has no logging and the symptom is "nothing happens", add the logging first
instead of forming theories about the parts that do log. Two supporting habits paid off here:
this plugin records EVERY `startIntercom` (so "the app never reaches us" was a fact, not a
guess), and testing the **Ring** camera -- a device this plugin does not touch -- proved the
fault was not ours before any code was changed.

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

1. **Is it a protocol failure or a silent one?** Run the plugin's self-test (the plugin's
   `Self test` setting, or `tools/verify.mjs` for every device at once):
   ```sh
   cd camera-intercom
   SCRYPTED_URL=https://scrypted.local:10443 SCRYPTED_USER=… SCRYPTED_PASS=… \
     node tools/verify.mjs "Gym Camera" "Office Camera" "Plant Room Camera" \
       "Bird Camera" "Tool Room Camera" "Plant Room Cat Feeder"
   ```
   A protocol failure names itself (401, no session, timeout). `INCONCLUSIVE` means the protocol
   is fine and you need to listen.

2. **Does it sound wrong rather than fail?** Play a level-matched tone on each device in turn —
   this is the tool that found every audio fault above:
   ```sh
   SCRYPTED_URL=… SCRYPTED_USER=… SCRYPTED_PASS=… SECONDS=6 node tools/listen-all.mjs "Bird Camera"
   ```
   It lifts the tone 6.3× on purpose (see the instrument traps above) and spaces sessions out,
   because several of these cameras suppress their speaker while another talk session is open.
   The plugin console also reports `… ms sent as silence (N source stall(s))` — non-zero means
   the *source* was struggling, not the device.

3. **Tapo 401?** Check the dialect — takes 5 seconds and distinguishes "wrong password" from
   "different derivation" from "different protocol entirely". The plugin already falls back
   between SHA256 and MD5 and between the current and previous password, so a 401 means
   something new: a factory reset/re-pair (dialect changed), a password change not recorded in
   the plugin, or a firmware that moved to KLAP auth (not implemented — would need adding to
   `tapoClient.ts`).

4. **A talk button that does nothing, with no error?** Look for a dead capability flag:
   `useOnvifTwoWayAudio` on Reolink, `onvifTwoWay` on the ONVIF-provided cameras. If a device
   advertises `Intercom` from a flag rather than from this plugin, that is the bug.

5. **Feeder choppy?** That is a buffering question, not an audio-path one. Ask the device: its
   own `POST /speaker/tone` bypasses the network entirely, so if that is smooth while talkback is
   not, the fault is in how the FIFO is being fed. Then read `/tmp/librefeed-media.log` for
   `done (<played>, <concealed>, <dropped>)` — steady concealment means the firmware's 120 ms
   preroll is too small or the network is struggling; drops mean a sender ahead of real time.

6. **Changed the Tapo account password?** Put the old one in `Previous Tapo Cloud Password` and
   the new one in `Tapo Cloud Password`, then re-run the self-test on each camera; the
   `auth ok: used … with the … cloud password` line tells you which cameras have caught up.

7. **After any change that affects HomeKit**, reload the HomeKit plugin so accessories
   re-advertise two-way audio. A camera whose audio works in Scrypted but not HomeKit usually
   just needs this.

## Useful commands

```sh
cd camera-intercom

# deploy after editing (note --include=dev: npm omit=dev is set globally here, and without the
# flag the webpack terser plugin is pruned and the build fails)
npm install --include=dev && NODE_ENV=production npm run build \
  && NODE_TLS_REJECT_UNAUTHORIZED=0 npx scrypted-deploy scrypted.local:10443

# attach the plugin to a camera (credentials per vendor, address per device)
SCRYPTED_URL=… SCRYPTED_USER=… SCRYPTED_PASS=… node tools/configure.mjs "Bird Camera"

# what advertises Intercom right now, and which plugin provides it
node tools/inventory.mjs

# listening test, level-matched, one device at a time
SECONDS=6 node tools/listen-all.mjs "Gym Camera"

# feeder firmware: roll back the media binary if a change misbehaves
ssh root@10.0.0.16 'cd /opt/librefeed && mv librefeed-media.bak librefeed-media && kill $(pidof librefeed-media)'
```

`~/.scrypted/login.json` holds the deploy credentials; `scrypted-deploy` needs it.

## Deliberate decisions, so they are not "fixed" later by mistake

* **`useOnvifTwoWayAudio` (Reolink) and `onvifTwoWay` (Tapo) stay OFF.** They advertise
  capabilities these cameras do not have. Turning them on re-creates the original bug.
* **Back Door and Front Door stay on `@scrypted/reolink`.** They are doorbells, which *do*
  implement the ONVIF backchannel. Working cameras do not get migrated onto our code.
* **`@scrypted/tapo` stays uninstalled.** It cannot authenticate to the Bird camera on any
  firmware released so far.
* **Tapo auto-upgrade stays OFF** (it already is, on all three). It is what stops a working
  camera breaking unattended at 03:00.
* **The self-tests do not fail on a missing sweep.** That is not laziness; see the verification
  trap above. A working C120 was once diagnosed as broken this way.
* **The Foscam is not firmware-updated.** Its talkback rides an undocumented protocol validated
  against build 2.91.2.80 specifically.
* **`prebufferMs` is per-driver and only the feeder sets it.** Front-loading audio into a vendor
  camera is thrown away — they discard anything faster than real time.
* **The Kibble plugin keeps `ObjectDetector` and nothing else.** Its intercom half moved to the
  `onvif-backchannel` driver. Do not detach the Kibble mixin from the feeder to "clean up" — it
  still carries the detection feed (the migration script learned this the hard way).

## Published copy on GitHub

A sanitized snapshot of the plugin plus this document is pushed to
**https://github.com/nphil/scrypted-intercom** (PUBLIC, ISC licensed). Sanitising replaces the
Scrypted host with `scrypted.local`, the camera account with `cameraaccount`, and the cameras'
LAN addresses in measurement comments with generic labels; no passwords were ever in these files
(all credentials come from Scrypted settings or environment variables). History was squashed to a
single commit before the first push, deliberately: an early draft had vendored an unlicensed file
and it needed to be gone from history, not just from HEAD.

**Licensing, in case it comes up:** `src/protocols/mpegts.ts` is written from go2rtc's
`pkg/mpegts/muxer.go` (MIT), NOT copied from Scrypted's Tapo plugin. Scrypted's copy sits in a
directory with no licence grant (its root `LICENSE.md` defers licensing per directory and
`plugins/tapo` declares none), so it cannot be redistributed. The rewrite was verified on the
hardware: test sweeps through a Tapo C120 were confirmed audible before the vendored file was
deleted.

**The deployed source of truth is this workspace, not GitHub** — `scrypted-deploy` runs from
`camera-intercom/` here. So after changing the plugin, refresh the published copy deliberately:

```sh
cd /tmp/pub/scrypted-intercom && git pull
rm -rf src tools && cp -r ~/camera-intercom/{src,tools} .
cp ~/camera-intercom/{package.json,tsconfig.json,webpack.nodejs.config.js} .
cp ~/CAMERA_TALKBACK.md README.md          # then re-apply the repo README header, see git history
grep -rl "<scrypted-host-ip>\|<camera-account>" . | xargs -r sed -i \
  "s/<scrypted-host-ip>/scrypted.local/g; s/<camera-account>/cameraaccount/g"
git add -A && git commit -m "…" && git push
```

Before every push, re-run the secret scan:

```sh
grep -rniE "<your-password-fragments>" --include=*.ts --include=*.mjs --include=*.md .
```

#!/usr/bin/env python3
"""Fixes WebRTC talkback in @scrypted/webrtc 0.2.89 for sessions where the SERVER makes the offer.

`setPlaybackInternal` picks the audio transceiver to receive the caller's microphone on:

    find(e => "audio" === e.receiver.track.kind &&
         ("sendrecv" === e.offerDirection || "recvonly" === e.offerDirection))

`offerDirection` is werift's record of a direction that arrived in a REMOTE offer. When Scrypted
generates the offer itself -- which is what the Scrypted iOS/Android apps do here -- the property
is undefined even though the transceiver's own `direction` is "sendrecv". The find then matches
nothing, and the function returns with no log and no error, so talkback silently does nothing on
every camera regardless of which plugin provides Intercom.

Measured on this install (instrumented):
    setPlayback called, options={"audio":true,...} hasIntercom=true
    transceiver found=false offerDirection=undefined
    allDirections=[{"kind":"video","dir":"sendonly"},{"kind":"audio","dir":"sendrecv"}]

The fix falls back to `direction` when `offerDirection` is absent, which is the same information
from the local side of the negotiation.

This is a LOCAL patch to an installed plugin bundle and will be lost when the plugin updates --
`main.nodejs.js.orig` is the untouched file. Re-run this script after an update, and check first
whether upstream has fixed it.
"""
import re
import sys

PATH = '/server/volume/plugins/@scrypted/webrtc/zip/unzipped/main.nodejs.js'
src = open(PATH).read()

# Remove the diagnostic logging added earlier, restoring the original control flow first.
src = re.sub(r'console\.log\("TALKBACK-DEBUG[^;]*?\);', '', src)
src = src.replace('if(!this.intercom){return;}', 'if(!this.intercom)return;')
src = src.replace('if(!t){return;}', 'if(!t)return;')
src = src.replace('if(!t.receiver.track){await t.onTrack.asPromise();}',
                  't.receiver.track||await t.onTrack.asPromise();')

old = '("sendrecv"===e.offerDirection||"recvonly"===e.offerDirection)'
new = '("sendrecv"===(e.offerDirection??e.direction)||"recvonly"===(e.offerDirection??e.direction))'

# Two sites use this filter: `setPlaybackInternal` and the "on-demand" audio branch. Both are
# wrong in the same way, so both are fixed.
count = src.count(old)
if count not in (1, 2):
    print(f'ABORT: expected one or two transceiver filters, found {count}')
    sys.exit(1)

src = src.replace(old, new)
print(f'sites patched: {count}')
open(PATH, 'w').write(src)
print('patched: transceiver filter now falls back to direction when offerDirection is unset')
print('diagnostics removed:', 'TALKBACK-DEBUG' not in src)

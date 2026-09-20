#!/usr/bin/env python3
"""Adds logging to the silent early-returns in @scrypted/webrtc's talkback path.

Every failure mode in `setPlaybackInternal` is a bare `return` -- no log, no error -- so from
outside there is no way to tell "the client never asked" from "no intercom was wired" from "the
client's audio track never arrived". This makes that visible. Companion to
patch-webrtc-talkback.py, which applies the FIX and strips these logs again.

Idempotent: safe to re-run, and a no-op if the logging is already present.

  ssh <host> "docker exec -i scrypted sh -c 'cat > /tmp/dbg.py && python3 /tmp/dbg.py'" \\
    < tools/debug-webrtc-talkback.py
"""
import sys

PATH = '/server/volume/plugins/@scrypted/webrtc/zip/unzipped/main.nodejs.js'
src = open(PATH).read()

if 'TALKBACK-DEBUG' in src:
    print('already instrumented; nothing to do')
    sys.exit(0)

# Entry plus the intercom check. Matches both the unpatched and patched forms of the transceiver
# filter, since the fix may already be applied.
entry_old = 'async setPlaybackInternal(e){if(this.killed.finished)return;if(!this.intercom)return;'
entry_new = ('async setPlaybackInternal(e){'
             'console.log("TALKBACK-DEBUG 1 setPlayback called, options=",JSON.stringify(e),'
             '"killed=",this.killed.finished,"hasIntercom=",!!this.intercom);'
             'if(this.killed.finished)return;'
             'if(!this.intercom){console.log("TALKBACK-DEBUG 1a BAILED: no intercom on the session control");return;}')

find_old = 'if(!t)return;t.receiver.track||await t.onTrack.asPromise();'
find_new = ('console.log("TALKBACK-DEBUG 2 transceiver found=",!!t,"offerDirection=",t&&t.offerDirection,'
            '"direction=",t&&t.direction,"hasTrack=",!!(t&&t.receiver&&t.receiver.track),'
            '"all=",JSON.stringify(this.connectionManagement.pc.getTransceivers().map(x=>({kind:x.receiver&&x.receiver.track&&x.receiver.track.kind,offer:x.offerDirection,dir:x.direction}))));'
            'if(!t){console.log("TALKBACK-DEBUG 2a BAILED: no audio transceiver matched");return;}'
            'if(!t.receiver.track){console.log("TALKBACK-DEBUG 3 waiting for the client audio track...");'
            'await t.onTrack.asPromise();console.log("TALKBACK-DEBUG 3a client audio track ARRIVED");}')

missing = [name for name, needle in (('entry', entry_old), ('transceiver', find_old))
           if src.count(needle) < 1]
if missing:
    print(f'ABORT: could not find {", ".join(missing)} site(s); the bundle has changed shape')
    sys.exit(1)

src = src.replace(entry_old, entry_new).replace(find_old, find_new)
open(PATH, 'w').write(src)
print('instrumented: entry, intercom check, transceiver lookup, track wait')

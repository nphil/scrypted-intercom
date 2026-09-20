#!/usr/bin/env bash
# Re-applies the WebRTC talkback fix to the Scrypted container and reloads the plugin.
#
# Needed after any @scrypted/webrtc update, because the patch edits the installed plugin bundle.
# Check first whether upstream has fixed it: the bug is that `setPlaybackInternal` selects the
# talkback audio transceiver by `offerDirection`, which werift only sets when the CLIENT offered.
# Scrypted's own apps let the server offer, so talkback silently did nothing on every camera.
set -euo pipefail
HOST="${SCRYPTED_SSH_HOST:-root@your-docker-host}"
HERE="$(cd "$(dirname "$0")" && pwd)"

ssh -o StrictHostKeyChecking=no "$HOST" \
  "docker exec -i scrypted sh -c 'cat > /tmp/fix_webrtc.py && python3 /tmp/fix_webrtc.py'" \
  < "$HERE/patch-webrtc-talkback.py"

SCRYPTED_URL="${SCRYPTED_URL:?set SCRYPTED_URL}" \
SCRYPTED_USER="${SCRYPTED_USER:?set SCRYPTED_USER}" \
SCRYPTED_PASS="${SCRYPTED_PASS:?set SCRYPTED_PASS}" \
node -e "
const {connectScryptedClient}=require('@scrypted/client');
process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
(async()=>{
  const sdk=await connectScryptedClient({baseUrl:process.env.SCRYPTED_URL,pluginId:'@scrypted/core',username:process.env.SCRYPTED_USER,password:process.env.SCRYPTED_PASS});
  await (await sdk.systemManager.getComponent('plugins')).reload('@scrypted/webrtc');
  console.log('webrtc reloaded');
  process.exit(0);
})();"

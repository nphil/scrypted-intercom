// Prints the plugin's own record of recent talk sessions: queue depth (= latency the caller
// hears), what was dropped to bound it, and whether the source stalled.
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
let ci;
for (const id of Object.keys(sm.getSystemState())) {
    const d = sm.getDeviceById(id);
    if (d?.name === 'Camera Intercom') ci = d;
}
const settings = await ci.getSettings();
const sessions = settings.find(s => s.key === 'lastSessions')?.value;
console.log('RECENT TALK SESSIONS (newest first):');
console.log(sessions || '  (none recorded yet on this build)');
process.exit(0);

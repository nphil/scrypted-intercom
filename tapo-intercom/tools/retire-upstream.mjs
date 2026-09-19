// Verifies nothing still uses the first-party @scrypted/tapo plugin, then uninstalls it.
// Refuses to uninstall while any device still has its mixin attached, so the migration cannot
// half-happen.
//   SCRYPTED_USER=… SCRYPTED_PASS=… [APPLY=true] node tools/retire-upstream.mjs
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sdk = await connectScryptedClient({
    baseUrl: process.env.SCRYPTED_URL, pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;

let upstream;
const users = [];
for (const id of Object.keys(sm.getSystemState())) {
    const d = sm.getDeviceById(id);
    if (d?.name === 'Tapo Two Way Audio' || d?.pluginId === '@scrypted/tapo')
        upstream = upstream || d;
}
if (!upstream) {
    console.log('@scrypted/tapo is not installed — nothing to retire.');
    process.exit(0);
}
for (const id of Object.keys(sm.getSystemState())) {
    const d = sm.getDeviceById(id);
    if ((d?.mixins || []).includes(upstream.id))
        users.push(d.name);
}
console.log(`upstream mixin device: ${upstream.name} (${upstream.id}) pluginId=${upstream.pluginId}`);
console.log(`still attached to: ${users.length ? users.join(', ') : '(nothing)'}`);
if (users.length) {
    console.log('REFUSING to uninstall while devices still use it — migrate them first.');
    process.exit(1);
}
if (process.env.APPLY !== 'true') {
    console.log('dry run: set APPLY=true to uninstall @scrypted/tapo');
    process.exit(0);
}
const plugins = await sm.getComponent('plugins');
console.log('plugin component methods:', Object.keys(plugins).filter(k => typeof plugins[k] === 'function').join(', '));
for (const method of ['removePlugin', 'uninstallPlugin', 'kill']) {
    if (typeof plugins[method] === 'function') {
        await plugins[method]('@scrypted/tapo');
        console.log(`called plugins.${method}('@scrypted/tapo')`);
        break;
    }
}
process.exit(0);

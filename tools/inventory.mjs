import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
const sdk=await connectScryptedClient({baseUrl:process.env.SCRYPTED_URL,pluginId:'@scrypted/core',username:process.env.SCRYPTED_USER,password:process.env.SCRYPTED_PASS});
const sm=sdk.systemManager;
console.log('=== devices advertising Intercom, and who provides it ===');
for(const id of Object.keys(sm.getSystemState())){
  const d=sm.getDeviceById(id);
  if(!(d?.interfaces||[]).includes('Intercom')) continue;
  const mx=(d.mixins||[]).map(i=>sm.getDeviceById(i)?.name);
  console.log(`  ${(d.name||'').padEnd(28)} id=${String(d.id).padEnd(4)} plugin=${(d.pluginId||'').padEnd(22)} mixins=[${mx.join(', ')}]`);
}
console.log('=== our plugins / providers present ===');
for(const n of ['Camera Intercom','Vendor PTZ','Foscam Intercom + PTZ','Reolink Intercom','Tapo Intercom','Kibble Feeder']){
  let f; for(const id of Object.keys(sm.getSystemState())){const d=sm.getDeviceById(id); if(d?.name===n) f=d;}
  console.log(`  ${n.padEnd(24)} ${f?`id=${f.id} pluginId=${f.pluginId}`:'(absent)'}`);
}
console.log('=== kibble plugin settings (feeder host/ports) ===');
let kib; for(const id of Object.keys(sm.getSystemState())){const d=sm.getDeviceById(id); if(d?.name==='Kibble Feeder') kib=d;}
if(kib){ try{ for(const s of await kib.getSettings()) if(/host|port|path/i.test(s.key)) console.log(`  ${s.key} = ${JSON.stringify(s.value)}`); }catch(e){ console.log('  settings unavailable:', e.message); } }
process.exit(0);

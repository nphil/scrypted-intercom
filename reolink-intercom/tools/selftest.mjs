import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
const sdk=await connectScryptedClient({baseUrl:process.env.SCRYPTED_URL,pluginId:'@scrypted/core',username:process.env.SCRYPTED_USER,password:process.env.SCRYPTED_PASS});
const sm=sdk.systemManager;
let plugin; for(const id of Object.keys(sm.getSystemState())){const d=sm.getDeviceById(id); if(d?.name==='Reolink Intercom') plugin=d;}
await plugin.putSetting('testTalkback','1');
await new Promise(r=>setTimeout(r,26000));
const s=await plugin.getSettings();
console.log('--- lastTalkbackTest ---\n'+(s.find(x=>x.key==='lastTalkbackTest')?.value||'(empty)'));
try{ const p=await sm.getComponent('plugins'); await p.reload('@scrypted/homekit'); console.log('--- homekit reloaded'); }catch(e){ console.log('homekit reload failed:',e.message); }
process.exit(0);

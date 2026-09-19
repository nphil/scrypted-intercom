import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
const sdk=await connectScryptedClient({baseUrl:process.env.SCRYPTED_URL,pluginId:'@scrypted/core',username:process.env.SCRYPTED_USER,password:process.env.SCRYPTED_PASS});
const sm=sdk.systemManager;
const byName=n=>{for(const id of Object.keys(sm.getSystemState())){const d=sm.getDeviceById(id); if(d?.name===n) return d;}};
for(const n of ['Back Door Camera','Front Door Camera','Plant Room Cat Feeder','Backyard Camera']){
  const c=byName(n); if(!c){console.log(`${n}: missing`);continue;}
  console.log(`\n=== ${n} (${c.id}, ${c.pluginId})`);
  try{ for(const s of await c.getSettings()) if(/^(ip|urls|useOnvifTwoWayAudio|doorbell|httpPort|onvifTwoWay)$/.test(s.key)) console.log(`   ${s.key} = ${JSON.stringify(s.value)}`); }catch(e){ console.log('   settings:', e.message); }
  const m=await sdk.mediaManager.createFFmpegMediaObject({inputArguments:['-re','-f','lavfi','-i','sine=frequency=1000:duration=2']});
  try{ await c.startIntercom(m); await new Promise(r=>setTimeout(r,2200)); await c.stopIntercom(); console.log('   startIntercom: OK'); }
  catch(e){ console.log('   startIntercom THREW:', e.message.slice(0,80)); }
}
process.exit(0);

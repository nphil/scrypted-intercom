import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
const sdk=await connectScryptedClient({baseUrl:process.env.SCRYPTED_URL,pluginId:'@scrypted/core',username:process.env.SCRYPTED_USER,password:process.env.SCRYPTED_PASS});
const sm=sdk.systemManager;
const byName=n=>{for(const id of Object.keys(sm.getSystemState())){const d=sm.getDeviceById(id); if(d?.name===n) return d;}};
const cam=byName('Office Camera');
const merged=byName('Camera Intercom');
const old=byName('Reolink Intercom');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const tone=async(label)=>{
  const fresh=sm.getDeviceById(cam.id);
  const m=await sdk.mediaManager.createFFmpegMediaObject({inputArguments:['-re','-f','lavfi','-i','sine=frequency=1000:duration=5']});
  console.log(`>>> TEST ${label}: 5s continuous 1 kHz tone now`);
  try{ await fresh.startIntercom(m); await sleep(5500); await fresh.stopIntercom(); }
  catch(e){ console.log(`    threw: ${e.message}`); }
};
const setProvider=async(want,other)=>{
  const mixins=new Set(cam.mixins||[]); mixins.delete(other.id); mixins.add(want.id);
  await cam.setMixins([...mixins]); await sleep(6000);
};
await setProvider(merged, old);
await tone('ONE (new merged plugin)');
await sleep(9000);
await setProvider(old, merged);
await tone('TWO (old reolink-intercom plugin)');
await sleep(2000);
await setProvider(merged, old);   // leave it on the merged plugin
console.log('restored: Office Camera back on Camera Intercom');
process.exit(0);

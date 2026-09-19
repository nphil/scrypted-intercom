import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
const sdk=await connectScryptedClient({baseUrl:process.env.SCRYPTED_URL,pluginId:'@scrypted/core',username:process.env.SCRYPTED_USER,password:process.env.SCRYPTED_PASS});
const sm=sdk.systemManager;
const byName=n=>{for(const id of Object.keys(sm.getSystemState())){const d=sm.getDeviceById(id); if(d?.name===n) return d;}};
const ptz=byName('Vendor PTZ');
console.log('Vendor PTZ provider:', ptz ? `device ${ptz.id}` : 'NOT FOUND');
if(ptz){
  const gym=byName('Gym Camera');
  const mixins=new Set(gym.mixins||[]); mixins.add(ptz.id);
  await gym.setMixins([...mixins]);
  await new Promise(r=>setTimeout(r,5000));
}
for(const n of ['Gym Camera','Office Camera','Plant Room Camera','Bird Camera','Tool Room Camera']){
  const c=byName(n);
  const mx=(c.mixins||[]).map(i=>sm.getDeviceById(i)?.name).filter(x=>/Intercom|PTZ/i.test(x||''));
  console.log(`${n.padEnd(20)} Intercom=${(c.interfaces||[]).includes('Intercom')} PanTiltZoom=${(c.interfaces||[]).includes('PanTiltZoom')} | ${mx.join(', ')}`);
}
process.exit(0);

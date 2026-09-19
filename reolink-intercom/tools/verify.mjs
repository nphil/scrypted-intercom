// Drives the real Scrypted Intercom on the camera (not the plugin's self-test), so the
// mixin's own ffmpeg transcode + ADPCM encode + pacing are what produce the sound.
//   SCRYPTED_USER=… SCRYPTED_PASS=… node tools/verify.mjs
import { connectScryptedClient } from '@scrypted/client';
process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
const sdk=await connectScryptedClient({baseUrl:process.env.SCRYPTED_URL,pluginId:'@scrypted/core',username:process.env.SCRYPTED_USER,password:process.env.SCRYPTED_PASS});
const sm=sdk.systemManager;
const name=process.env.REOLINK_CAMERA_NAME||'Office Camera';
let cam; for(const id of Object.keys(sm.getSystemState())){const d=sm.getDeviceById(id); if(d?.name===name) cam=d;}
// three 2s sweeps 300->3200 Hz, unmistakable to a listener
const expr="aevalsrc='0.9*sin(2*PI*(300*mod(t\\,2)+725*mod(t\\,2)*mod(t\\,2)))':s=16000:d=6";
const media=await sdk.mediaManager.createFFmpegMediaObject({inputArguments:['-re','-f','lavfi','-i',expr]});
console.log(`startIntercom on ${name} (${cam.id}) — three rising sweeps`);
await cam.startIntercom(media);
await new Promise(r=>setTimeout(r,8000));
await cam.stopIntercom();
console.log('stopIntercom resolved');
process.exit(0);

// Direct Baichuan sender: no Scrypted, no ffmpeg, no warm-up, no lead. Synthesises a tone and
// paces it perfectly, so whatever delay remains belongs to the protocol and the device.
import { BaichuanClient, talkFullBlockSize } from '/tmp/bcdirect/baichuan.js';
import { ImaDviEncoder } from '/tmp/bcdirect/adpcm.js';

const host = process.argv[2], user = process.argv[3], pass = process.argv[4];
const client = new BaichuanClient({ host, username: user, password: pass, console });
await client.connect();
await client.login();
const ability = await client.getTalkAbility();
const full = talkFullBlockSize(ability);
const rate = ability.sampleRate;
console.log(`ability: ${rate} Hz, block ${full} bytes, duplex ${ability.duplex}`);
await client.startTalk(ability);

const encoder = new ImaDviEncoder();
const samplesPerBlock = (full - 4) * 2;
const frameMs = samplesPerBlock / rate * 1000;
const pcm = Buffer.alloc(samplesPerBlock * 2);
const started = Date.now();
console.log(`T0 ${started}`);
let sent = 0;
const total = Math.round(6000 / frameMs);
for (let f = 0; f < total; f++) {
    for (let i = 0; i < samplesPerBlock; i++) {
        const t = (f * samplesPerBlock + i) / rate;
        pcm.writeInt16LE(Math.round(0.8 * 32767 * Math.sin(2 * Math.PI * 1000 * t)), i * 2);
    }
    await client.sendTalkBlocks([encoder.encode(pcm, full)]);
    sent++;
    const due = started + sent * frameMs;
    const slack = due - Date.now();
    if (slack > 0) await new Promise(r => setTimeout(r, slack));
}
console.log(`sent ${sent} frames of ${frameMs.toFixed(0)} ms in ${Date.now() - started} ms`);
client.close();
process.exit(0);

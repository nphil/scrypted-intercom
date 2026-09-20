// G.711 companding, shared by every driver that needs it (Tapo's talk stream is A-law; ONVIF
// backchannels commonly offer mu-law, A-law, or both).
//
// Both encoders are the standard reference algorithms and were checked against Python's
// `audioop.lin2alaw` / `lin2ulaw` over a full-scale sine: byte-for-byte identical, same RMS and
// same residual after decode. That check is worth repeating if either is ever "optimised" --
// during development a suspected encoder bug turned out to be a test-signal level problem, and
// only a byte-exact comparison against the reference settled it.

/** 16-bit linear PCM (little-endian) to G.711 A-law. */
export function linearToAlaw(pcm: Buffer): Buffer {
    const out = Buffer.alloc(pcm.length / 2);
    for (let i = 0; i < out.length; i++) {
        const sample = pcm.readInt16LE(i * 2);
        const sign = sample < 0 ? 0x00 : 0x80;
        const magnitude = Math.min(32635, Math.abs(sample));
        let exponent = 7;
        for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1)
            exponent--;
        const mantissa = (magnitude >> (exponent === 0 ? 4 : exponent + 3)) & 0x0F;
        out[i] = (sign | (exponent << 4) | mantissa) ^ 0x55;
    }
    return out;
}

/** 16-bit linear PCM (little-endian) to G.711 mu-law. */
export function linearToUlaw(pcm: Buffer): Buffer {
    const BIAS = 0x84;
    const CLIP = 32635;
    const out = Buffer.alloc(pcm.length / 2);
    for (let i = 0; i < out.length; i++) {
        const sample = pcm.readInt16LE(i * 2);
        const sign = sample < 0 ? 0x80 : 0x00;
        const magnitude = Math.min(CLIP, Math.abs(sample)) + BIAS;
        let exponent = 7;
        for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1)
            exponent--;
        const mantissa = (magnitude >> (exponent + 3)) & 0x0F;
        out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
    }
    return out;
}

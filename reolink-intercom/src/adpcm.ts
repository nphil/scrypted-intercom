// IMA/DVI-4 ADPCM encoder for Reolink's Baichuan talkback audio (cmd 202 payload).
//
// Ported from the working Python prototype at /tmp/hatalk_standalone.py (`_ima_encode_nibble` +
// `ima_adpcm_encode_dvi_blocks`), which produced audible, undistorted playback on a Reolink
// RLC-833A (192.168.1.103, fw v3.1.0.3016_2312052457) -- confirmed by the camera owner standing
// in the room. The step/index tables below are the standard IMA ADPCM tables; the block layout
// (4-byte predictor header, low-nibble-first packing, zero-filled tail) is ported faithfully
// rather than re-derived, because this camera is picky about block framing in ways that fail
// silently (wrong framing plays either silence or noise, never a loud error) -- see
// baichuan.ts's `talkFullBlockSize` for the sibling gotcha on the wire block *size*.

/** Standard IMA ADPCM step-index adjustment table, indexed by the 4-bit code just produced. */
const IMA_INDEX_TABLE: readonly number[] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

/** Standard IMA ADPCM step-size table (89 entries), indexed by step index (0..88). */
const IMA_STEP_TABLE: readonly number[] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408,
    449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
    9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];

/**
 * Encodes PCM s16le mono into IMA/DVI-4 ADPCM blocks of exactly `fullBlockSize` bytes each.
 *
 * Each block is a 4-byte predictor header (i16 LE initial predictor, u8 step index, u8 reserved)
 * followed by `fullBlockSize - 4` bytes of packed 4-bit nibbles (2 samples per byte, low nibble
 * first). Predictor/step state is continuous from block to block *within one call* -- the header
 * just lets a decoder resync mid-stream -- but every call starts fresh (predictor seeded from the
 * input's first sample, step index 0), since this signature carries no state across calls. The
 * mixin calls this once per audio group rather than once for a whole session, so encoding state
 * does reset at every group boundary; because the predictor reseeds from that group's own first
 * sample rather than jumping from an unrelated stored value, this is inaudible in practice (only
 * the step index's momentary loss of adaptation is a minor, silent cost).
 *
 * The final block is zero-padded to `fullBlockSize` if the input runs out mid-block, so the
 * output length is always an exact multiple of `fullBlockSize` -- callers can slice it into
 * fixed-size blocks with no remainder handling.
 */
export function encodeImaDviBlocks(pcmS16le: Buffer, fullBlockSize: number): Buffer {
    if (fullBlockSize < 8)
        throw new RangeError(`fullBlockSize must be >= 8 (got ${fullBlockSize})`);
    if (pcmS16le.length % 2 !== 0)
        throw new RangeError(`pcmS16le length must be even (s16le samples), got ${pcmS16le.length}`);

    const sampleCount = pcmS16le.length / 2;
    if (sampleCount === 0)
        return Buffer.alloc(0);

    const payloadBytes = fullBlockSize - 4;
    const payloadSamples = payloadBytes * 2;

    let predictor = pcmS16le.readInt16LE(0); // sample[0] seeds the predictor; it is not itself encoded
    let stepIndex = 0;

    const encodeNibble = (sample: number): number => {
        const step = IMA_STEP_TABLE[stepIndex];
        let diff = sample - predictor;
        let sign = 0;
        if (diff < 0) {
            sign = 8;
            diff = -diff;
        }

        let delta = 0;
        let vpdiff = step >> 3;
        if (diff >= step) {
            delta |= 4;
            diff -= step;
            vpdiff += step;
        }
        if (diff >= step >> 1) {
            delta |= 2;
            diff -= step >> 1;
            vpdiff += step >> 1;
        }
        if (diff >= step >> 2) {
            delta |= 1;
            vpdiff += step >> 2;
        }

        predictor = sign ? predictor - vpdiff : predictor + vpdiff;
        predictor = Math.max(-32768, Math.min(32767, predictor));

        stepIndex += IMA_INDEX_TABLE[delta | sign];
        stepIndex = Math.max(0, Math.min(88, stepIndex));

        return (delta | sign) & 0xf;
    };

    const blocks: Buffer[] = [];
    let pos = 1; // sample[0] already consumed as the initial predictor
    while (pos <= sampleCount) {
        const block = Buffer.alloc(fullBlockSize); // zero-fills the tail once input runs out
        block.writeInt16LE(predictor, 0);
        block.writeUInt8(stepIndex, 2);
        // byte 3 stays 0 (reserved)

        for (let i = 0; i < payloadSamples; i += 2) {
            const s0 = pos < sampleCount ? pcmS16le.readInt16LE(pos * 2) : 0;
            pos++;
            const s1 = pos < sampleCount ? pcmS16le.readInt16LE(pos * 2) : 0;
            pos++;
            const lo = encodeNibble(s0);
            const hi = encodeNibble(s1);
            block[4 + i / 2] = lo | (hi << 4);
        }

        blocks.push(block);
        if (pos >= sampleCount)
            break;
    }

    return Buffer.concat(blocks);
}

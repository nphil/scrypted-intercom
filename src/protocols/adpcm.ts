// IMA/DVI-4 ADPCM encoder for Reolink's Baichuan talkback audio (cmd 202 payload).
//
// Block layout: a 4-byte predictor header (i16 LE predictor, u8 step index, u8 reserved) followed
// by `fullBlockSize - 4` bytes of packed 4-bit nibbles, two samples per byte, low nibble first.
// The tables are the standard IMA ADPCM ones. The framing is ported faithfully rather than
// re-derived because this camera fails silently on framing mistakes — wrong framing plays
// silence or noise, never an error (see `talkFullBlockSize` in baichuan.ts for the sibling gotcha
// on the wire block *size*).
//
// STREAMING STATE — the reason this is a class:
// an earlier version exposed only a one-shot function that seeded the predictor from each call's
// first sample and reset the step index to 0 every time. That is correct for encoding a whole
// file in one call, and audibly wrong for streaming: the mixin encodes one ~256 ms group per
// call, so the quantiser restarted at its smallest step (7) every group and had to ramp back up.
// The camera's owner described the result exactly — a tone that pulsed rather than sustained,
// with a "tick" at each group boundary from the reset transient. Carrying predictor and step
// index across calls fixes both. One encoder instance per talk session.

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

export class ImaDviEncoder {
    private predictor = 0;
    private stepIndex = 0;
    private seeded = false;

    /** Encodes PCM s16le mono into whole blocks of exactly `fullBlockSize` bytes, continuing the
     * quantiser state from the previous call. Output length is always a multiple of
     * `fullBlockSize`, so callers can slice it with no remainder handling. */
    encode(pcmS16le: Buffer, fullBlockSize: number): Buffer {
        if (fullBlockSize < 8)
            throw new RangeError(`fullBlockSize must be >= 8 (got ${fullBlockSize})`);
        if (pcmS16le.length % 2 !== 0)
            throw new RangeError(`pcmS16le length must be even (s16le samples), got ${pcmS16le.length}`);

        const sampleCount = pcmS16le.length / 2;
        if (sampleCount === 0)
            return Buffer.alloc(0);

        // Only the very first call seeds the predictor from the audio; after that the running
        // state is the whole point.
        let pos = 0;
        if (!this.seeded) {
            this.predictor = pcmS16le.readInt16LE(0);
            this.stepIndex = 0;
            this.seeded = true;
            pos = 1;
        }

        const payloadSamples = (fullBlockSize - 4) * 2;
        const blocks: Buffer[] = [];
        while (pos < sampleCount) {
            const block = Buffer.alloc(fullBlockSize); // zero-fills the tail if input runs out
            // The header carries the state this block starts from, which is what lets a decoder
            // resync mid-stream.
            block.writeInt16LE(clampSample(this.predictor), 0);
            block.writeUInt8(this.stepIndex, 2);

            for (let i = 0; i < payloadSamples; i += 2) {
                const low = this.encodeNibble(pos < sampleCount ? pcmS16le.readInt16LE(pos * 2) : this.predictor);
                pos++;
                const high = this.encodeNibble(pos < sampleCount ? pcmS16le.readInt16LE(pos * 2) : this.predictor);
                pos++;
                block[4 + i / 2] = low | (high << 4);
            }
            blocks.push(block);
        }
        return blocks.length === 1 ? blocks[0] : Buffer.concat(blocks);
    }

    private encodeNibble(sample: number): number {
        const step = IMA_STEP_TABLE[this.stepIndex];
        let diff = sample - this.predictor;
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

        this.predictor = clampSample(sign ? this.predictor - vpdiff : this.predictor + vpdiff);
        this.stepIndex = Math.max(0, Math.min(88, this.stepIndex + IMA_INDEX_TABLE[delta | sign]));
        return delta | sign;
    }
}

function clampSample(value: number): number {
    return Math.max(-32768, Math.min(32767, value));
}

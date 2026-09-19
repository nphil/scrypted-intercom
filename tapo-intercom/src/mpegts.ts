// Minimal MPEG-TS muxer: PAT, PMT and PES for a single elementary stream.
//
// Written from the MPEG-TS format and the structure of go2rtc's `pkg/mpegts/muxer.go`
// (https://github.com/AlexxIT/go2rtc, MIT licence, Copyright (c) Alexey Khit), which is the
// upstream both this and Scrypted's Tapo plugin descend from. Implemented here rather than
// vendored so this repository carries only code it can redistribute: Scrypted's own copy sits in
// a plugin directory with no licence grant (its root LICENSE.md defers licensing to each
// directory, and plugins/tapo declares none), whereas go2rtc's MIT terms permit this.
//
// Tapo-specific details that matter:
//   * The camera wants G.711 A-law under Tapo's PRIVATE stream type 0x90, with PES stream id
//     0xC0 (audio). A standard PCMA stream type is not accepted.
//   * Every TS packet is exactly 188 bytes; short payloads are padded with an adaptation field.
//     The camera rejects a stream whose packets do not align.

const PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;
const PAT_PID = 0x0000;
const PMT_PID = 0x1000;
const FLAG_PUSI = 0x4000;
const FLAG_ADAPTATION = 0x20;
const FLAG_PAYLOAD = 0x10;

/** Tapo's private stream type for G.711 A-law. */
export const STREAM_TYPE_PCMA_TAPO = 0x90;
/** PES stream id for an audio elementary stream. */
const AUDIO_STREAM_ID = 0xC0;

/** MPEG-2 systems CRC32: poly 0x04C11DB7, MSB-first, init all ones, written little-endian. */
function crc32Mpeg(data: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (const byte of data) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit++)
            crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) >>> 0 : (crc << 1) >>> 0;
    }
    return crc >>> 0;
}

interface Track {
    pid: number;
    streamType: number;
    streamId: number;
    continuity: number;
    pts: number;
}

export class MpegTsMuxer {
    private tracks: Track[] = [];

    /** Registers an elementary stream and returns its PID. */
    addTrack(streamType: number, pid: number): number {
        this.tracks.push({ pid, streamType, streamId: AUDIO_STREAM_ID, continuity: 0, pts: 0 });
        return pid;
    }

    /** PAT + PMT. Must be sent once before any payload. */
    header(): Buffer {
        return Buffer.concat([this.programAssociation(), this.programMap()]);
    }

    /** Wraps one chunk of elementary-stream data as PES inside 188-byte TS packets.
     * `ptsIncrement` is in 90 kHz ticks. */
    payload(pid: number, payload: Buffer, ptsIncrement: number): Buffer {
        const track = this.tracks.find(t => t.pid === pid);
        if (!track)
            throw new Error(`mpegts: no track for pid ${pid}`);
        track.pts = (track.pts + ptsIncrement) >>> 0;

        const pes = Buffer.alloc(14 + payload.length);
        pes[0] = 0x00;
        pes[1] = 0x00;
        pes[2] = 0x01;                       // packet start code prefix
        pes[3] = track.streamId;
        pes.writeUInt16BE(3 + 5 + payload.length, 4); // PES packet length
        pes[6] = 0x80;                       // marker bits
        pes[7] = 0x80;                       // PTS present
        pes[8] = 5;                          // PES header data length
        writePts(pes, 9, track.pts);
        payload.copy(pes, 14);

        const packets: Buffer[] = [];
        let remaining = pes;
        let first = true;
        while (remaining.length) {
            const packet = Buffer.alloc(PACKET_SIZE);
            packet[0] = SYNC_BYTE;
            packet.writeUInt16BE((first ? FLAG_PUSI : 0) | track.pid, 1);
            const counter = track.continuity & 0x0F;
            track.continuity++;
            if (remaining.length < PACKET_SIZE - 4) {
                // Short chunk: pad with an adaptation field so the packet is still 188 bytes.
                packet[3] = FLAG_ADAPTATION | FLAG_PAYLOAD | counter;
                const adaptationSize = PACKET_SIZE - 4 - 1 - remaining.length;
                packet[4] = adaptationSize;
                remaining.copy(packet, 5 + adaptationSize);
                remaining = remaining.subarray(remaining.length);
            } else {
                packet[3] = FLAG_PAYLOAD | counter;
                remaining.copy(packet, 4, 0, PACKET_SIZE - 4);
                remaining = remaining.subarray(PACKET_SIZE - 4);
            }
            packets.push(packet);
            first = false;
        }
        return Buffer.concat(packets);
    }

    private programAssociation(): Buffer {
        const section = Buffer.alloc(12);
        section[0] = 0x00;                   // table id: PAT
        section.writeUInt16BE(0xB000 | (5 + 4 + 4), 1); // syntax indicator + section length
        section.writeUInt16BE(0x0001, 3);    // transport stream id
        section[5] = 0xC1;                   // reserved + version 0 + current
        section[6] = 0x00;                   // section number
        section[7] = 0x00;                   // last section number
        section.writeUInt16BE(0x0001, 8);    // program number
        section.writeUInt16BE(0xE000 | PMT_PID, 10); // reserved + program map PID
        return this.psiPacket(PAT_PID, section);
    }

    private programMap(): Buffer {
        const esLength = this.tracks.length * 5;
        const section = Buffer.alloc(12 + esLength);
        section[0] = 0x02;                   // table id: PMT
        section.writeUInt16BE(0xB000 | (5 + 4 + esLength + 4), 1);
        section.writeUInt16BE(0x0001, 3);    // program number
        section[5] = 0xC1;
        section[6] = 0x00;
        section[7] = 0x00;
        section.writeUInt16BE(0xE000 | 0x1FFF, 8);  // PCR PID: unused
        section.writeUInt16BE(0xF000, 10);          // program info length 0
        let offset = 12;
        for (const track of this.tracks) {
            section[offset] = track.streamType;
            section.writeUInt16BE(0xE000 | track.pid, offset + 1);
            section.writeUInt16BE(0xF000, offset + 3); // ES info length 0
            offset += 5;
        }
        return this.psiPacket(PMT_PID, section);
    }

    /** Wraps a PSI section (PAT/PMT) in one 188-byte packet: pointer field, section, CRC32,
     * then stuffing to the end of the packet. */
    private psiPacket(pid: number, section: Buffer): Buffer {
        // Zero stuffing after the section, matching go2rtc (which these cameras accept).
        const packet = Buffer.alloc(PACKET_SIZE, 0x00);
        packet[0] = SYNC_BYTE;
        packet.writeUInt16BE(FLAG_PUSI | pid, 1);
        packet[3] = FLAG_PAYLOAD;            // continuity counter 0: PAT/PMT are sent once
        packet[4] = 0x00;                    // pointer field
        section.copy(packet, 5);
        const crc = crc32Mpeg(section);
        packet.writeUInt32LE(crc, 5 + section.length);
        return packet;
    }
}

/** PTS in the 5-byte "PTS only" form the PES optional header uses. */
function writePts(buffer: Buffer, offset: number, pts: number): void {
    buffer[offset] = 0x20 | ((pts >>> 29) & 0x0E) | 1;
    buffer[offset + 1] = (pts >>> 22) & 0xFF;
    buffer[offset + 2] = ((pts >>> 14) & 0xFE) | 1;
    buffer[offset + 3] = (pts >>> 7) & 0xFF;
    buffer[offset + 4] = ((pts << 1) & 0xFE) | 1;
}

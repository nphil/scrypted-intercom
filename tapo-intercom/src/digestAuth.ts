// HTTP Digest for Tapo's talk endpoint.
//
// Written out rather than reused from a generic helper because these cameras are strict in two
// ways that were measured directly against them:
//   * `qop=auth` is MANDATORY. The older RFC 2069 form (response = MD5(HA1:nonce:HA2), no
//     qop/nc/cnonce) returns 401 on every one of the three cameras tested.
//   * the digest hashing is MD5 regardless of what the password derivation is; the camera's
//     `encrypt_type` flag describes how to hash the PASSWORD, not the digest. Conflating the two
//     produces a 401 that looks exactly like bad credentials.

import * as crypto from 'crypto';

export interface DigestChallenge {
    realm: string;
    nonce: string;
    opaque: string;
    /** Raw header, kept so callers can inspect flags such as encrypt_type. */
    raw: string;
}

export function parseChallenge(wwwAuthenticate: string): DigestChallenge {
    const fields: Record<string, string> = {};
    for (const [, key, value] of wwwAuthenticate.matchAll(/(\w+)="([^"]*)"/g))
        fields[key] = value;
    return {
        realm: fields.realm ?? '',
        nonce: fields.nonce ?? '',
        opaque: fields.opaque ?? '',
        raw: wwwAuthenticate,
    };
}

export function digestAuthHeader(challenge: DigestChallenge, secret: string, uri = '/stream'): string {
    const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
    const cnonce = crypto.randomBytes(8).toString('hex');
    const nc = '00000001';
    const ha1 = md5(`admin:${challenge.realm}:${secret}`);
    const ha2 = md5(`POST:${uri}`);
    const response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
    return `Digest username="admin", realm="${challenge.realm}", nonce="${challenge.nonce}", `
        + `uri="${uri}", algorithm="MD5", qop="auth", nc=${nc}, cnonce="${cnonce}", `
        + `response="${response}", opaque="${challenge.opaque}"`;
}

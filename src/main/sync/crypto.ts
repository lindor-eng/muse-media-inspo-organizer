import crypto from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Everything sync sends after pairing is authenticated and encrypted with keys derived from one
 * secret the paired Macs share (the group key):
 *
 * - Requests carry no body. Each is signed: an HMAC over method, path and query, a timestamp and
 *   a random nonce. A server refuses old timestamps and repeated nonces, so a request overheard
 *   on the network can't be replayed.
 * - Responses are AES-256-GCM under a key derived from the group key and that request's nonce,
 *   so a response only decrypts as the answer to the request it answers. The GCM tag is the last
 *   16 bytes of the body.
 *
 * Pairing has nothing shared yet, so it uses an X25519 exchange checked by people: both Macs
 * show a six-digit code derived from it, and each person agrees the codes match. The asking Mac
 * commits to its public key before seeing the other's (a hash first, the key after), so a
 * machine in the middle can't search for keys that make the two codes agree; it gets one
 * guess in a million per attempt, and every attempt puts a prompt in front of both people.
 */

export interface GroupKeys {
  auth: Buffer;
  enc: Buffer;
  /** Public label for the group, advertised over Bonjour. */
  tag: string;
}

const MAX_SKEW_MS = 5 * 60 * 1000;
const TAG_BYTES = 16;

function hkdf(key: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', key, salt, info, 32));
}

export function newGroupKey(): Buffer {
  return crypto.randomBytes(32);
}

export function deriveKeys(groupKey: Buffer): GroupKeys {
  const none = Buffer.alloc(0);
  return {
    auth: hkdf(groupKey, none, 'muse-sync auth'),
    enc: hkdf(groupKey, none, 'muse-sync enc'),
    tag: hkdf(groupKey, none, 'muse-sync tag').subarray(0, 8).toString('hex'),
  };
}

// MARK: - Requests

export interface SignedHeaders {
  'x-muse-device': string;
  'x-muse-time': string;
  'x-muse-nonce': string;
  'x-muse-sig': string;
}

function signature(keys: GroupKeys, method: string, target: string, time: string, nonce: string, device: string): Buffer {
  return crypto
    .createHmac('sha256', keys.auth)
    .update([method.toUpperCase(), target, time, nonce, device].join('\n'))
    .digest();
}

export function signRequest(keys: GroupKeys, method: string, target: string, device: string): SignedHeaders {
  const time = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  return {
    'x-muse-device': device,
    'x-muse-time': time,
    'x-muse-nonce': nonce,
    'x-muse-sig': signature(keys, method, target, time, nonce, device).toString('hex'),
  };
}

/** Nonces seen inside the accepted time window. */
export class NonceCache {
  private seen = new Map<string, number>();

  /** False if the nonce was already used. */
  claim(nonce: string, now = Date.now()): boolean {
    if (this.seen.size > 5000) {
      for (const [n, at] of this.seen) if (now - at > 2 * MAX_SKEW_MS) this.seen.delete(n);
    }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now);
    return true;
  }
}

export type VerifyResult = { ok: true; device: string; nonce: string } | { ok: false; reason: string };

export function verifyRequest(
  keys: GroupKeys,
  method: string,
  target: string,
  headers: Record<string, string | string[] | undefined>,
  nonces: NonceCache,
): VerifyResult {
  const get = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const device = get('x-muse-device');
  const time = get('x-muse-time');
  const nonce = get('x-muse-nonce');
  const sig = get('x-muse-sig');
  if (!device || !time || !nonce || !sig) return { ok: false, reason: 'unsigned' };
  if (!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig)) return { ok: false, reason: 'malformed' };
  if (Math.abs(Date.now() - Number(time)) > MAX_SKEW_MS) return { ok: false, reason: 'clock' };
  const expected = signature(keys, method, target, time, nonce, device);
  const given = Buffer.from(sig, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature' };
  }
  if (!nonces.claim(nonce)) return { ok: false, reason: 'replay' };
  return { ok: true, device, nonce };
}

// MARK: - Responses

export function responseKey(keys: GroupKeys, nonce: string): Buffer {
  return hkdf(keys.enc, Buffer.from(nonce, 'hex'), 'muse-sync response');
}

export function seal(key: Buffer, plaintext: Buffer): { iv: string; body: Buffer } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('hex'), body };
}

export function open(key: Buffer, ivHex: string, body: Buffer): Buffer {
  if (body.length < TAG_BYTES) throw new Error('response too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
}

/** Encrypts a stream, appending the GCM tag after the last byte. */
export function sealStream(key: Buffer): { iv: string; stream: Transform } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      done(null, cipher.update(chunk));
    },
    flush(done: TransformCallback) {
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      done();
    },
  });
  return { iv: iv.toString('hex'), stream };
}

/**
 * Decrypts a stream made by `sealStream`. The tag is the last 16 bytes, so the most recent 16
 * are always held back; a stream that was tampered with or cut short fails at the end, and
 * whatever it wrote has to be thrown away.
 */
export function openStream(key: Buffer, ivHex: string): Transform {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  let held = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      const all = held.length ? Buffer.concat([held, chunk]) : chunk;
      if (all.length <= TAG_BYTES) {
        held = Buffer.from(all);
        return done();
      }
      held = Buffer.from(all.subarray(all.length - TAG_BYTES));
      done(null, decipher.update(all.subarray(0, all.length - TAG_BYTES)));
    },
    flush(done: TransformCallback) {
      try {
        if (held.length !== TAG_BYTES) throw new Error('stream too short');
        decipher.setAuthTag(held);
        this.push(decipher.final());
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  });
}

// MARK: - Pairing

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface PairKeys {
  privateKey: crypto.KeyObject;
  /** Raw 32-byte public key. */
  publicKey: Buffer;
}

export function newPairKeys(): PairKeys {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, publicKey: Buffer.from(der.subarray(der.length - 32)) };
}

export function commitment(publicKey: Buffer): string {
  return crypto.createHash('sha256').update(publicKey).digest('hex');
}

export function sharedSecret(own: PairKeys, peerPublic: Buffer): Buffer {
  if (peerPublic.length !== 32) throw new Error('bad public key');
  const key = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, peerPublic]), format: 'der', type: 'spki' });
  return crypto.diffieHellman({ privateKey: own.privateKey, publicKey: key });
}

/** Both keys in a fixed order: the asking Mac's, then the asked Mac's. */
function transcript(initiator: Buffer, responder: Buffer): Buffer {
  return Buffer.concat([initiator, responder]);
}

/** The six digits both people compare. */
export function pairingCode(shared: Buffer, initiator: Buffer, responder: Buffer): string {
  const bytes = hkdf(shared, transcript(initiator, responder), 'muse-sync pairing code');
  return String(bytes.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** Encrypts the group key on its way to the asking Mac. */
export function pairingWrapKey(shared: Buffer, initiator: Buffer, responder: Buffer): Buffer {
  return hkdf(shared, transcript(initiator, responder), 'muse-sync pairing wrap');
}

import sharp from 'sharp';

/** 64-bit perceptual hash via average-hash (8x8 grayscale, mean threshold). */
export async function computePHash(imagePath: string): Promise<bigint | null> {
  try {
    const { data } = await sharp(imagePath)
      .resize(8, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (data.length !== 64) return null;
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += data[i];
    const mean = sum / 64;
    let bits = 0n;
    for (let i = 0; i < 64; i++) {
      if (data[i] >= mean) bits |= 1n << BigInt(i);
    }
    return bits;
  } catch {
    return null;
  }
}

export function phashToBlob(hash: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(hash, 0);
  return buf;
}

export function blobToPhash(buf: Buffer): bigint {
  return buf.readBigUInt64BE(0);
}

/** Hamming distance between two 64-bit pHashes (0 identical, 64 inverse). */
export function phashHamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/** Maps Hamming distance (0..64) to a 0..1 similarity score. */
export function phashSimilarity(distance: number): number {
  return Math.max(0, 1 - distance / 64);
}

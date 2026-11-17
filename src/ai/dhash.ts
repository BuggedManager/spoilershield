/**
 * Perceptual difference hash (dHash, 64 bit) – used by the optional, local
 * image matcher. Robust to resizing, recompression and small colour changes;
 * NOT robust to heavy crops, overlays or mirrored images.
 */
export const HASH_W = 9;
export const HASH_H = 8;

/** RGBA pixel data of a 9×8 image → 16-char hex hash. */
export function dhashFromRgba(data: Uint8ClampedArray | number[], w = HASH_W, h = HASH_H): string {
  const gray = new Array<number>(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  let hex = '';
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      nibble = (nibble << 1) | (gray[y * w + x] > gray[y * w + x + 1] ? 1 : 0);
      if (++bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

/** Maximum Hamming distance treated as a match (out of 64 bits). */
export const MATCH_DISTANCE = 10;

export function matchesAny(hash: string, refs: string[], max = MATCH_DISTANCE): boolean {
  for (const r of refs) if (hamming(hash, r) <= max) return true;
  return false;
}

export interface ImageRef {
  id: string;
  name: string;
  hash: string;
}
export const IMAGE_REFS_KEY = 'imageRefs';

export function sanitizeRefs(raw: unknown): ImageRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is ImageRef => !!r && typeof r === 'object' && typeof r.hash === 'string' && /^[0-9a-f]{16}$/.test(r.hash))
    .map((r) => ({ id: String(r.id ?? r.hash).slice(0, 40), name: String(r.name ?? 'Reference').slice(0, 80), hash: r.hash }))
    .slice(0, 300);
}

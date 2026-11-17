/**
 * Background-side image hashing for the optional image matcher.
 * Requires the optional "<all_urls>" host permission (requested only when the
 * user enables image detection). Images are re-fetched from their ORIGINAL host
 * (normally served from the browser cache) – never sent anywhere else.
 */
import { dhashFromRgba, HASH_H, HASH_W } from './dhash';

const cache = new Map<string, string | null>();
const CACHE_MAX = 800;
const MAX_BYTES = 8 * 1024 * 1024;
let inflight = 0;
const MAX_INFLIGHT = 4;

export async function imageHashFromUrl(url: string): Promise<string | null> {
  if (!/^https?:\/\//.test(url) || url.length > 2048) return null;
  if (cache.has(url)) return cache.get(url) ?? null;
  if (inflight >= MAX_INFLIGHT) return null; // resource budget: caller retries later
  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  if (!granted) return null;
  inflight++;
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'force-cache', referrerPolicy: 'no-referrer' });
    if (!res.ok) return remember(url, null);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) return remember(url, null);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size > MAX_BYTES) return remember(url, null);
    const bmp = await createImageBitmap(blob, { resizeWidth: HASH_W, resizeHeight: HASH_H, resizeQuality: 'medium' });
    const canvas = new OffscreenCanvas(HASH_W, HASH_H);
    const ctx = canvas.getContext('2d');
    if (!ctx) return remember(url, null);
    ctx.drawImage(bmp, 0, 0, HASH_W, HASH_H);
    bmp.close();
    return remember(url, dhashFromRgba(ctx.getImageData(0, 0, HASH_W, HASH_H).data));
  } catch {
    return remember(url, null);
  } finally {
    inflight--;
  }
}

function remember(url: string, h: string | null) {
  cache.set(url, h);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return h;
}

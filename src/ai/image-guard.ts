/**
 * Optional local image matcher (Layer 5, experimental, OFF by default).
 *
 * Compares visible images against perceptual hashes of reference images the
 * user added in Settings (e.g. official GTA 6 key art they want hidden).
 * - Only images near the viewport are checked (IntersectionObserver).
 * - Strict budget: ≤4 concurrent hashes, ≤120 per minute per tab, results cached per URL.
 * - If no references exist or the permission is missing, it does nothing (fallback = text detection only).
 * It cannot recognise arbitrary GTA 6 screenshots – there is no bundled ML model.
 */
import { IMAGE_REFS_KEY, matchesAny, sanitizeRefs } from './dhash';

const STATE = 'data-ss-state';
const CHECKED = 'data-ss-img';
export const IMG_GUARD_ATTR = 'data-ss-img-guard';
const MIN_SIZE = 48;
const PER_MINUTE = 120;

export class ImageGuard {
  pageCount = 0;
  private refs: string[] = [];
  private io: IntersectionObserver | null = null;
  private mo: MutationObserver | null = null;
  private results = new Map<string, boolean>();
  private blocked = new Set<HTMLImageElement>();
  private queue: HTMLImageElement[] = [];
  private active = 0;
  private windowStart = Date.now();
  private used = 0;
  private running = false;

  constructor(
    private doc: Document,
    private onBlocked: () => void,
  ) {}

  async start(maximum: boolean) {
    const r = await chrome.storage.local.get(IMAGE_REFS_KEY);
    this.refs = sanitizeRefs(r[IMAGE_REFS_KEY]).map((x) => x.hash);
    if (!this.refs.length) {
      this.stop();
      return;
    }
    if (this.running) return;
    this.running = true;
    if (maximum) this.doc.documentElement.setAttribute(IMG_GUARD_ATTR, '');
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          this.io?.unobserve(e.target);
          this.enqueue(e.target as HTMLImageElement);
        }
      }
    }, { rootMargin: '300px' });
    this.doc.querySelectorAll('img').forEach((i) => this.io?.observe(i));
    this.mo = new MutationObserver((recs) => {
      for (const rec of recs) {
        rec.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          const el = n as Element;
          if (el.tagName === 'IMG') this.io?.observe(el);
          else el.querySelectorAll?.('img').forEach((i) => this.io?.observe(i));
        });
        if (rec.type === 'attributes' && (rec.target as Element).tagName === 'IMG') {
          (rec.target as Element).removeAttribute(CHECKED);
          this.io?.observe(rec.target as Element);
        }
      }
    });
    this.mo.observe(this.doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
  }

  stop() {
    this.running = false;
    this.io?.disconnect();
    this.mo?.disconnect();
    this.io = this.mo = null;
    this.doc.documentElement.removeAttribute(IMG_GUARD_ATTR);
    for (const img of this.blocked) img.removeAttribute(STATE);
    this.blocked.clear();
    this.queue = [];
  }

  revealAll() {
    for (const img of this.blocked) img.setAttribute(STATE, 'revealed');
  }

  private done(img: HTMLImageElement) {
    img.setAttribute(CHECKED, '');
  }

  private enqueue(img: HTMLImageElement) {
    const src = img.currentSrc || img.src;
    const rect = img.getBoundingClientRect();
    if (!src || !/^https?:/.test(src) || (rect.width < MIN_SIZE && rect.height < MIN_SIZE)) return this.done(img);
    const cached = this.results.get(src);
    if (cached !== undefined) return this.apply(img, cached);
    this.queue.push(img);
    this.pump();
  }

  private pump() {
    while (this.running && this.active < 4 && this.queue.length) {
      const now = Date.now();
      if (now - this.windowStart > 60000) {
        this.windowStart = now;
        this.used = 0;
      }
      if (this.used >= PER_MINUTE) {
        // budget exhausted: never keep images hidden because of the budget
        this.queue.splice(0).forEach((i) => this.done(i));
        return;
      }
      const img = this.queue.shift()!;
      const src = img.currentSrc || img.src;
      this.active++;
      this.used++;
      chrome.runtime
        .sendMessage({ type: 'ss:imageHash', url: src })
        .then((res: { hash: string | null } | undefined) => {
          const hit = !!res?.hash && matchesAny(res.hash, this.refs);
          if (res?.hash) this.results.set(src, hit);
          this.apply(img, hit);
        })
        .catch(() => this.done(img))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  private apply(img: HTMLImageElement, hit: boolean) {
    if (hit && img.getAttribute(STATE) !== 'revealed') {
      img.setAttribute(STATE, 'blocked');
      if (!this.blocked.has(img)) {
        this.blocked.add(img);
        this.pageCount++;
        this.onBlocked();
      }
    }
    this.done(img);
  }
}

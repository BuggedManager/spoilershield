/**
 * DOM scanner: preventive hiding, evaluation queue, overlays.
 *
 * Flow
 *  1. A <style> is injected at document_start. Adapter "cards" are hidden by CSS
 *     (`html[data-ss-guard] card:not([data-ss-state])`) from the moment they are
 *     parsed/inserted until they have been evaluated.
 *  2. A MutationObserver collects inserted / changed nodes. Its callback runs as a
 *     microtask – before the browser paints – and evaluates synchronously within a
 *     time budget. Anything left over is marked data-ss-state="pending" (hidden) and
 *     finished in later animation frames.
 *  3. Cards: evaluated as a whole (text + attributes, nested cards excluded).
 *     Everything else: generic detector finds the smallest sensible container.
 *  4. Blocked elements get data-ss-state="blocked" (hidden) + an opaque overlay.
 */
import { GLOBAL_CARDS, MAXIMUM_CARDS, type SiteAdapter } from '../adapters';
import { NO_DETECTION, type Detection, type Detector } from '../detection/engine';
import { hashText } from '../detection/normalize';
import { createOverlay, OVERLAY_ATTR, type OverlayHandle } from '../overlays/overlay';
import type { Mode } from '../storage/settings';

export const STATE_ATTR = 'data-ss-state';
export const GUARD_ATTR = 'data-ss-guard';
export const POS_ATTR = 'data-ss-pos';
export const HOVER_ATTR = 'data-ss-hover';
export const BOX_ATTR = 'data-ss-box';
export const REPLACED_TITLE = '\u{1F6E1} Title hidden by SpoilerShield';

export interface ScannerConfig {
  detector: Detector | null;
  mode: Mode;
  blockImages: boolean;
  protectTitle: boolean;
}

export interface ScannerDeps {
  doc: Document;
  adapter: SiteAdapter;
  onBlocked?: (newItems: number) => void;
  getShadowRoot?: (el: Element) => ShadowRoot | null;
  budgetMs?: number;
  now?: () => number;
  raf?: (cb: () => void) => void;
}

type UnitKind = 'card' | 'generic' | 'page';
interface UnitState {
  sig: number;
  kind: UnitKind;
  det: Detection;
  firstSeen: number;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'TEXTAREA', 'INPUT', 'SELECT', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'BR', 'HR', 'SVG', 'PATH']);
const VOID_TAGS = new Set(['IMG', 'VIDEO', 'PICTURE', 'SOURCE', 'INPUT', 'BR', 'HR', 'AREA', 'EMBED', 'WBR', 'CANVAS', 'IFRAME']);
const CARD_LIKE =
  'article,[role="article"],li,[role="listitem"],[role="option"],[role="row"],tr,figure,blockquote,aside,dd,[class*="card" i],[class*="teaser" i],[class*="tile" i]';
const MAX_UNIT_TEXT = 1500;
const MAX_IMAGE_UNIT_TEXT = 400;
const SPLIT_ROOT_TEXT = 20000;
const MAX_COLLECT = 20000;
const MAX_ATTR_ELS = 40;
const MAX_DIRTY = 20000;
const BLOCKED_IMG_SVG =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#15141c"/><path fill="#8b5cf6" d="M80 22 66 27.5v10c0 9 6 17 14 19 8-2 14-10 14-19v-10z"/><text x="80" y="74" fill="#c4b5fd" font-family="system-ui,sans-serif" font-size="8" text-anchor="middle">Image hidden by SpoilerShield</text></svg>',
  );

const OBSERVE: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['title', 'aria-label', 'alt', 'post-title', GUARD_ATTR],
};

export function validSelectors(list: string[], doc: Document): string[] {
  const frag = doc.createDocumentFragment();
  return list.filter((s) => {
    try {
      frag.querySelector(s);
      return true;
    } catch {
      return false;
    }
  });
}

export class Scanner {
  private cfg: ScannerConfig = { detector: null, mode: 'strict', blockImages: true, protectTitle: true };
  private readonly deps: ScannerDeps;
  private readonly doc: Document;
  private readonly observer: MutationObserver;
  private style: HTMLStyleElement | null = null;
  private cardSel = '';
  private exclSel = '';
  private running = false;
  private dirty = new Set<Node>();
  private flushSeen = new Set<Element>();
  private states = new WeakMap<Element, UnitState>();
  /** element → Detection.key that the user revealed */
  private readonly revealedKey = new WeakMap<Element, number>();
  private readonly overlays = new WeakMap<Element, OverlayHandle>();
  private readonly tracked = new Set<Element>();
  private readonly pendingEls = new Set<Element>();
  private readonly emptyCards = new Set<Element>();
  private readonly counted = new Set<number>();
  private readonly posSet = new WeakSet<Element>();
  private readonly holders = new WeakMap<Element, Element>();
  /** blocked/revealed units whose overlay must be (re)attached at the end of the flush */
  private readonly toAttach = new Set<Element>();
  private readonly observedRoots = new WeakSet<ShadowRoot>();
  private flushScheduled = false;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;
  private originalTitle: string | null = null;
  private navHandler = () => {
    this.checkTitle();
    this.evaluatePageUnits();
    this.commitOverlays();
  };
  /** click on a blocked <img> reveals it instead of following links */
  private clickHandler = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (!t || t.tagName !== 'IMG' || t.getAttribute(STATE_ATTR) !== 'blocked') return;
    e.preventDefault();
    e.stopPropagation();
    if (this.states.has(t)) this.reveal(t, false);
    else t.setAttribute(STATE_ATTR, 'revealed');
  };
  private playHandler = (e: Event) => {
    const t = e.target as HTMLMediaElement | null;
    if (t && typeof t.closest === 'function' && t.closest(`[${STATE_ATTR}="blocked"]`)) t.pause();
  };
  /** unique items blocked on this page since load */
  pageCount = 0;
  /** diagnostics */
  readonly metrics = { evaluations: 0, flushes: 0, maxFlushMs: 0, totalFlushMs: 0, pendingMarked: 0 };

  constructor(deps: ScannerDeps) {
    this.deps = deps;
    this.doc = deps.doc;
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.rebuildSelectors();
  }

  get isRunning() {
    return this.running;
  }

  setConfig(cfg: ScannerConfig): void {
    const prev = this.cfg;
    this.cfg = cfg;
    this.rebuildSelectors();
    if (!this.running) return;
    this.applyStyle();
    this.doc.documentElement?.setAttribute(GUARD_ATTR, cfg.mode === 'maximum' ? 'max' : 'on');
    if (prev.detector !== cfg.detector || prev.mode !== cfg.mode || prev.blockImages !== cfg.blockImages || prev.protectTitle !== cfg.protectTitle) {
      this.rescanAll();
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.applyStyle();
    this.doc.documentElement?.setAttribute(GUARD_ATTR, this.cfg.mode === 'maximum' ? 'max' : 'on');
    this.observer.observe(this.doc, OBSERVE);
    for (const ev of this.deps.adapter.navEvents ?? []) this.doc.addEventListener(ev, this.navHandler);
    this.doc.addEventListener('play', this.playHandler, true);
    this.doc.addEventListener('click', this.clickHandler, true);
    if (this.doc.documentElement) this.dirty.add(this.doc.documentElement);
    this.checkTitle();
    this.flush();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.observer.disconnect();
    for (const ev of this.deps.adapter.navEvents ?? []) this.doc.removeEventListener(ev, this.navHandler);
    this.doc.removeEventListener('play', this.playHandler, true);
    this.doc.removeEventListener('click', this.clickHandler, true);
    this.style?.remove();
    this.style = null;
    this.doc.documentElement?.removeAttribute(GUARD_ATTR);
    this.doc.documentElement?.removeAttribute(HOVER_ATTR);
    const all = new Set<Element>([...this.tracked, ...this.pendingEls, ...this.doc.querySelectorAll(`[${STATE_ATTR}],[${POS_ATTR}],[${BOX_ATTR}]`)]);
    for (const el of all) this.clearElement(el);
    this.tracked.clear();
    this.pendingEls.clear();
    this.emptyCards.clear();
    this.dirty.clear();
    this.states = new WeakMap();
    if (this.originalTitle !== null && this.doc.title === REPLACED_TITLE) this.doc.title = this.originalTitle;
  }

  /** Re-evaluate the whole page (settings changed). Runs synchronously → no flash. */
  rescanAll(): void {
    for (const el of [...this.tracked]) {
      const st = this.states.get(el);
      if (!st || st.kind === 'generic') this.clearElement(el);
    }
    this.states = new WeakMap();
    if (this.originalTitle !== null && this.doc.title === REPLACED_TITLE) this.doc.title = this.originalTitle;
    if (this.doc.documentElement) this.dirty.add(this.doc.documentElement);
    this.checkTitle();
    this.flushSeen = new Set();
    this.flush();
  }

  revealAll(): number {
    let n = 0;
    for (const el of this.tracked) {
      if (el.getAttribute(STATE_ATTR) === 'blocked') {
        this.reveal(el, false);
        n++;
      }
    }
    return n;
  }

  hideAll(): number {
    let n = 0;
    for (const el of this.tracked) {
      if (el.getAttribute(STATE_ATTR) === 'revealed') {
        this.hideAgain(el, false);
        n++;
      }
    }
    return n;
  }

  status() {
    let blocked = 0;
    let revealed = 0;
    for (const el of this.tracked) {
      if (!el.isConnected) continue;
      const s = el.getAttribute(STATE_ATTR);
      if (s === 'blocked') blocked++;
      else if (s === 'revealed') revealed++;
    }
    return { blocked, revealed, pageCount: this.pageCount, titleHidden: this.doc.title === REPLACED_TITLE };
  }

  // ---------------------------------------------------------------------------

  private rebuildSelectors() {
    const list = [...this.deps.adapter.cards, ...GLOBAL_CARDS, ...(this.cfg.mode === 'maximum' ? MAXIMUM_CARDS : [])];
    const valid = validSelectors(list, this.doc);
    this.cardSel = valid.join(',');
    this.exclSel = [this.cardSel, `[${STATE_ATTR}="blocked"]`, `[${STATE_ATTR}="revealed"]`, 'script', 'style', 'noscript', 'template']
      .filter(Boolean)
      .join(',');
  }

  private buildCss(): string {
    const prehide = validSelectors([...this.deps.adapter.cards, ...GLOBAL_CARDS], this.doc);
    const S = STATE_ATTR;
    return [
      prehide.length ? `html[${GUARD_ATTR}] :is(${prehide.join(',')}):not([${S}]) { visibility: hidden !important; }` : '',
      `html[${GUARD_ATTR}="max"] :is(${MAXIMUM_CARDS.join(',')}):not([${S}]) { visibility: hidden !important; }`,
      `[${S}="pending"] { visibility: hidden !important; }`,
      `[${S}="blocked"] { visibility: hidden !important; isolation: isolate !important; }`,
      `[${S}="blocked"] > :not([${OVERLAY_ATTR}]):not([${BOX_ATTR}]) { opacity: 0 !important; pointer-events: none !important; }`,
      `[${S}="blocked"] [${BOX_ATTR}] > :not([${OVERLAY_ATTR}]) { opacity: 0 !important; pointer-events: none !important; }`,
      `[${S}="revealed"] { isolation: isolate !important; }`,
      `[${POS_ATTR}] { position: relative !important; }`,
      `img[${S}="blocked"] { visibility: visible !important; content: url("${BLOCKED_IMG_SVG}") !important; object-fit: contain !important; background: #15141c !important; cursor: pointer !important; }`,
      `html[data-ss-img-guard] img:not([data-ss-img]):not([${S}]) { visibility: hidden !important; }`,
      this.deps.adapter.css ?? '',
    ].join('\n');
  }

  private applyStyle() {
    if (!this.style) {
      this.style = this.doc.createElement('style');
      this.style.setAttribute('data-ss-style', '');
    }
    const css = this.buildCss();
    if (this.style.textContent !== css) this.style.textContent = css;
    this.ensureStyleAttached();
  }

  private ensureStyleAttached() {
    if (this.style && !this.style.isConnected) (this.doc.head ?? this.doc.documentElement)?.appendChild(this.style);
  }

  private isOurs(n: Node): boolean {
    return n.nodeType === 1 && ((n as Element).hasAttribute(OVERLAY_ATTR) || n === this.style);
  }

  private onMutations(records: MutationRecord[]) {
    if (!this.running) return;
    for (const r of records) {
      if (r.type === 'childList') {
        r.addedNodes.forEach((n) => {
          if (n.nodeType === 1) {
            if (!this.isOurs(n)) this.dirty.add(n);
          } else if (n.nodeType === 3) {
            const p = n.parentElement ?? (r.target.nodeType === 1 ? (r.target as Element) : null);
            if (p) this.dirty.add(p);
          }
        });
        if (r.removedNodes.length && r.target.nodeType === 1) {
          let oursRemoved = false;
          r.removedNodes.forEach((n) => {
            if (this.isOurs(n)) oursRemoved = true;
          });
          const t = r.target as Element;
          if (oursRemoved) this.dirty.add(t);
          else if (this.cardSel && !r.addedNodes.length) {
            const card = t.closest(this.cardSel);
            if (card) this.dirty.add(card);
          }
        }
      } else if (r.type === 'characterData') {
        const p = (r.target as CharacterData).parentElement;
        if (p) this.dirty.add(p);
      } else if (r.type === 'attributes') {
        const t = r.target as Element;
        if (r.attributeName === GUARD_ATTR) {
          if (t === this.doc.documentElement && !t.hasAttribute(GUARD_ATTR)) t.setAttribute(GUARD_ATTR, this.cfg.mode === 'maximum' ? 'max' : 'on');
        } else if (!this.isOurs(t)) this.dirty.add(t);
      }
    }
    if (this.dirty.size > MAX_DIRTY) {
      this.dirty.clear();
      if (this.doc.documentElement) this.dirty.add(this.doc.documentElement);
    }
    this.flushSeen = new Set();
    this.flush();
  }

  private now() {
    return this.deps.now ? this.deps.now() : performance.now();
  }

  private flush() {
    if (!this.running) return;
    this.ensureStyleAttached();
    if (!this.cfg.detector) {
      for (const n of this.dirty) this.markPending(n);
      return;
    }
    const start = this.now();
    const budget = this.deps.budgetMs ?? 12;
    for (const node of this.dirty) {
      this.dirty.delete(node);
      if (this.hasDirtyAncestor(node)) continue;
      this.process(node);
      if (this.now() - start > budget) break;
    }
    this.commitOverlays();
    const ms = this.now() - start;
    this.metrics.flushes++;
    this.metrics.totalFlushMs += ms;
    if (ms > this.metrics.maxFlushMs) this.metrics.maxFlushMs = ms;
    if (this.dirty.size) {
      for (const n of this.dirty) this.markPending(n);
      this.scheduleFlush();
    }
  }

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const run = () => {
      this.flushScheduled = false;
      this.flushSeen = new Set();
      this.flush();
    };
    if (this.deps.raf) this.deps.raf(run);
    else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  private hasDirtyAncestor(n: Node): boolean {
    for (let p = n.parentNode; p; p = p.parentNode) if (this.dirty.has(p)) return true;
    return false;
  }

  private markPending(n: Node) {
    let el = n.nodeType === 1 ? (n as Element) : n.parentElement;
    if (!el || !el.isConnected) return;
    if (el === this.doc.documentElement) el = this.doc.body;
    if (!el || el.tagName === 'HEAD' || this.doc.head?.contains(el)) return;
    const card = this.cardSel ? el.closest(this.cardSel) : null;
    const target = card ?? el;
    const s = target.getAttribute(STATE_ATTR);
    if (s === 'blocked' || s === 'revealed' || s === 'pending') return;
    target.setAttribute(STATE_ATTR, 'pending');
    this.pendingEls.add(target);
    this.metrics.pendingMarked++;
  }

  private process(node: Node) {
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!el || !el.isConnected) return;
    if (this.pendingEls.delete(el) && el.getAttribute(STATE_ATTR) === 'pending' && !(this.cardSel && el.matches(this.cardSel))) {
      el.removeAttribute(STATE_ATTR);
    }
    const head = this.doc.head;
    if (el.tagName === 'TITLE' || el.tagName === 'HEAD' || (head && head.contains(el))) {
      if (el.tagName === 'TITLE' || el.closest('title') || el.querySelector('title')) this.checkTitle();
      return;
    }
    if (this.isOurs(el) || SKIP_TAGS.has(el.tagName)) return;
    if (el.tagName.includes('-')) this.observeShadow(el);

    let insideCard: Element | null = null;
    if (this.cardSel) {
      insideCard = el.closest(this.cardSel);
      if (insideCard) this.evaluateCard(insideCard);
      el.querySelectorAll(this.cardSel).forEach((c) => this.evaluateCard(c));
    }
    const pu = this.deps.adapter.pageUnits;
    if (pu) {
      for (const u of pu) {
        if (el.closest(u.selector) || el.querySelector(u.selector)) {
          this.evaluatePageUnits();
          break;
        }
      }
    }
    if (!insideCard) this.genericScan(el);
  }

  private observeShadow(el: Element) {
    const root = this.deps.getShadowRoot ? this.deps.getShadowRoot(el) : (el as HTMLElement).shadowRoot;
    if (!root || this.observedRoots.has(root)) return;
    this.observedRoots.add(root);
    this.observer.observe(root, OBSERVE);
    for (const c of Array.from(root.children)) if (!this.isOurs(c)) this.dirty.add(c);
  }

  private evaluateCard(card: Element) {
    if (this.flushSeen.has(card)) return;
    this.flushSeen.add(card);
    this.pendingEls.delete(card);
    this.evaluateUnit(card, this.unitText(card), 'card');
  }

  private evaluatePageUnits() {
    const pu = this.deps.adapter.pageUnits;
    if (!pu || !this.cfg.detector) return;
    const title = this.originalTitle ?? this.doc.title;
    for (const u of pu) {
      const el = this.doc.querySelector(u.selector);
      if (el) this.evaluateUnit(el, u.text(this.doc, this.doc.title === REPLACED_TITLE ? title : this.doc.title), 'page');
    }
  }

  private checkTitle() {
    if (!this.cfg.detector || !this.running) return;
    const t = this.doc.title;
    if (!t || t === REPLACED_TITLE) return;
    this.originalTitle = t;
    if (!this.cfg.protectTitle) return;
    const d = this.cfg.detector.evaluate(t);
    if (d.blocked) {
      this.doc.title = REPLACED_TITLE;
      this.count(hashText('title\u0000' + t));
    }
    this.evaluatePageUnits();
  }

  /** Core state machine for one unit. */
  private evaluateUnit(el: Element, text: string, kind: UnitKind): Detection {
    const det0 = this.cfg.detector;
    if (!det0) return NO_DETECTION;
    const sig = hashText(text);
    const prev = this.states.get(el);
    const cur = el.getAttribute(STATE_ATTR);
    if (prev && prev.sig === sig && cur && cur !== 'pending') {
      if ((cur === 'blocked' || cur === 'revealed') && !this.overlayIntact(el)) this.toAttach.add(el);
      return prev.det;
    }
    this.metrics.evaluations++;
    const det = text.trim() ? det0.evaluate(text) : NO_DETECTION;
    const firstSeen = prev?.firstSeen ?? this.now();
    this.states.set(el, { sig, kind, det, firstSeen });
    if (det.blocked) {
      if (this.revealedKey.get(el) === det.key) this.setRevealed(el, det);
      else this.block(el, det, sig);
    } else if (
      kind === 'card' &&
      !text.trim() &&
      this.now() - firstSeen < (this.cfg.mode === 'maximum' ? 3000 : 1200) &&
      !(this.cardSel && el.querySelector(this.cardSel))
    ) {
      // card skeleton without content yet – keep hidden until content arrives
      el.setAttribute(STATE_ATTR, 'pending');
      this.emptyCards.add(el);
      this.scheduleEmptyCheck();
    } else {
      this.unblock(el, kind === 'card' ? 'safe' : null);
    }
    return det;
  }

  private scheduleEmptyCheck() {
    if (this.emptyTimer) return;
    this.emptyTimer = setTimeout(() => {
      this.emptyTimer = null;
      if (!this.running) return;
      for (const c of this.emptyCards) if (c.isConnected) this.dirty.add(c);
      this.emptyCards.clear();
      this.flushSeen = new Set();
      this.flush();
    }, 300);
  }

  private count(sig: number) {
    if (this.counted.has(sig)) return;
    if (this.counted.size > 20000) this.counted.clear();
    this.counted.add(sig);
    this.pageCount++;
    this.deps.onBlocked?.(1);
  }

  private block(el: Element, det: Detection, sig: number) {
    this.tracked.add(el);
    this.pendingEls.delete(el);
    this.emptyCards.delete(el);
    this.revealedKey.delete(el);
    if (VOID_TAGS.has(el.tagName)) {
      el.setAttribute(STATE_ATTR, 'blocked');
      if (el.tagName === 'VIDEO') (el as HTMLVideoElement).pause?.();
      this.count(sig);
      return;
    }
    // content is hidden right now by CSS; overlay placement is batched (one style read per flush)
    el.setAttribute(STATE_ATTR, 'blocked');
    this.toAttach.add(el);
    void det;
    el.querySelectorAll('video,audio').forEach((m) => {
      try {
        (m as HTMLMediaElement).pause();
      } catch {
        /* ignore */
      }
    });
    this.count(sig);
  }

  private setRevealed(el: Element, _det: Detection) {
    this.tracked.add(el);
    el.setAttribute(STATE_ATTR, 'revealed');
    this.toAttach.add(el);
  }

  /** Read phase (computed styles for all pending overlays at once), then write phase. */
  private commitOverlays() {
    if (!this.toAttach.size) return;
    const items = [...this.toAttach];
    this.toAttach.clear();
    const view = this.doc.defaultView;
    const plans: { el: Element; holder: Element; needPos: boolean; det: Detection }[] = [];
    for (const el of items) {
      const s = el.getAttribute(STATE_ATTR);
      const st = this.states.get(el);
      if (!el.isConnected || !st || (s !== 'blocked' && s !== 'revealed') || VOID_TAGS.has(el.tagName)) continue;
      const holder = this.holders.get(el) ?? this.holderFor(el);
      const needPos = !holder.hasAttribute(POS_ATTR) && (!view || ['static', ''].includes(view.getComputedStyle(holder).position));
      plans.push({ el, holder, needPos, det: st.det });
    }
    for (const p of plans) {
      this.holders.set(p.el, p.holder);
      if (p.holder !== p.el) p.holder.setAttribute(BOX_ATTR, '');
      if (p.needPos) {
        p.holder.setAttribute(POS_ATTR, '');
        this.posSet.add(p.holder);
      }
      this.attachOverlay(p.el, p.det);
    }
  }

  /** Element that actually generates a box (skips display:contents wrappers). */
  private holderFor(el: Element): Element {
    const view = this.doc.defaultView;
    let cur = el;
    for (let i = 0; i < 4 && view; i++) {
      if (view.getComputedStyle(cur).display !== 'contents' || cur.children.length !== 1) break;
      cur = cur.children[0];
    }
    return cur;
  }

  private overlayParent(el: Element): Element | ShadowRoot {
    const holder = this.holders.get(el) ?? el;
    const sr = this.deps.getShadowRoot ? this.deps.getShadowRoot(holder) : (holder as HTMLElement).shadowRoot;
    return sr ?? holder;
  }

  private overlayIntact(el: Element): boolean {
    const h = this.overlays.get(el);
    return !!h && h.host.parentNode === this.overlayParent(el);
  }

  private attachOverlay(el: Element, det: Detection) {
    if (VOID_TAGS.has(el.tagName)) return;
    let h = this.overlays.get(el);
    const label = det.profileName ?? 'GTA 6';
    if (!h) {
      h = createOverlay(this.doc, {
        label,
        spoiler: det.spoiler,
        onReveal: () => this.reveal(el, true),
        onHide: () => this.hideAgain(el, true),
        onHover: (on) => {
          const html = this.doc.documentElement;
          if (on && el.getAttribute(STATE_ATTR) === 'blocked') html.setAttribute(HOVER_ATTR, '');
          else html.removeAttribute(HOVER_ATTR);
        },
      });
      this.overlays.set(el, h);
    } else h.update(label, det.spoiler);
    const parent = this.overlayParent(el);
    if (h.host.parentNode !== parent) parent.appendChild(h.host);
    h.setMode(el.getAttribute(STATE_ATTR) === 'revealed' ? 'revealed' : 'blocked');
  }

  reveal(el: Element, focus: boolean) {
    const st = this.states.get(el);
    if (!st) return;
    this.revealedKey.set(el, st.det.key);
    el.setAttribute(STATE_ATTR, 'revealed');
    this.doc.documentElement.removeAttribute(HOVER_ATTR);
    const h = this.overlays.get(el);
    h?.setMode('revealed');
    if (focus) h?.focus();
  }

  hideAgain(el: Element, focus: boolean) {
    this.revealedKey.delete(el);
    el.setAttribute(STATE_ATTR, 'blocked');
    const h = this.overlays.get(el);
    h?.setMode('blocked');
    el.querySelectorAll('video,audio').forEach((m) => (m as HTMLMediaElement).pause?.());
    if (focus) h?.focus();
  }

  private unblock(el: Element, newState: 'safe' | null) {
    const h = this.overlays.get(el);
    if (h) {
      h.remove();
      this.overlays.delete(el);
    }
    const holder = this.holders.get(el) ?? el;
    if (this.posSet.has(holder)) {
      holder.removeAttribute(POS_ATTR);
      this.posSet.delete(holder);
    }
    if (holder !== el) holder.removeAttribute(BOX_ATTR);
    this.holders.delete(el);
    this.tracked.delete(el);
    this.emptyCards.delete(el);
    this.pendingEls.delete(el);
    if (newState) {
      if (el.getAttribute(STATE_ATTR) !== newState) el.setAttribute(STATE_ATTR, newState);
    } else if (el.hasAttribute(STATE_ATTR)) el.removeAttribute(STATE_ATTR);
  }

  private clearElement(el: Element) {
    const h = this.overlays.get(el);
    if (h) {
      h.remove();
      this.overlays.delete(el);
    }
    const holder = this.holders.get(el) ?? el;
    el.removeAttribute(STATE_ATTR);
    el.removeAttribute(POS_ATTR);
    holder.removeAttribute(POS_ATTR);
    holder.removeAttribute(BOX_ATTR);
    this.posSet.delete(holder);
    this.holders.delete(el);
    this.tracked.delete(el);
  }

  // ---- text extraction --------------------------------------------------------

  /** Text + descriptive attributes of a unit, excluding nested cards / blocked units. */
  unitText(el: Element): string {
    const excl = this.exclSel;
    const hasExcluded = excl ? el.querySelector(excl) !== null : false;
    let text = hasExcluded ? this.textExcluding(el, excl) : (el.textContent ?? '');
    if (text.length > MAX_COLLECT) text = text.slice(0, MAX_COLLECT);
    const parts: string[] = [text];
    const extra = this.deps.adapter.extraText;
    if (extra) parts.push(extra(el));
    else {
      const t = el.getAttribute('title');
      const a = el.getAttribute('aria-label');
      if (t) parts.push(t);
      if (a) parts.push(a);
    }
    const sel = this.cfg.blockImages ? '[title],[aria-label],img[alt],img[src],a[href]' : '[title],[aria-label],a[href]';
    const list = el.querySelectorAll(sel);
    const n = Math.min(list.length, MAX_ATTR_ELS);
    for (let i = 0; i < n; i++) {
      const e = list[i];
      if (hasExcluded) {
        const c = e.closest(excl);
        if (c && c !== el) continue;
      }
      const title = e.getAttribute('title');
      if (title) parts.push(title);
      const aria = e.getAttribute('aria-label');
      if (aria) parts.push(aria);
      if (e.tagName === 'IMG') {
        const alt = e.getAttribute('alt');
        if (alt) parts.push(alt);
        const src = e.getAttribute('src');
        if (src && !src.startsWith('data:')) parts.push(fileName(src));
      } else if (e.tagName === 'A') {
        const href = e.getAttribute('href');
        if (href && href.length < 300 && !href.startsWith('javascript:')) parts.push(pathOf(href));
      }
    }
    return parts.join('\n');
  }

  private textExcluding(el: Element, excl: string): string {
    const out: string[] = [];
    let len = 0;
    const walker = this.doc.createTreeWalker(el, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
      acceptNode: (n) => {
        if (n.nodeType === 1) {
          const e = n as Element;
          if (e !== el && (SKIP_TAGS.has(e.tagName) || this.isOurs(e) || e.matches(excl))) return 2; // REJECT
          return 3; // SKIP (descend)
        }
        return 1; // ACCEPT text
      },
    });
    for (let n = walker.nextNode(); n && len < MAX_COLLECT; n = walker.nextNode()) {
      const v = n.nodeValue;
      if (v) {
        out.push(v);
        len += v.length;
      }
    }
    return out.join(' ');
  }

  // ---- generic detector ----------------------------------------------------------

  private isEditable(el: Element): boolean {
    return (el as HTMLElement).isContentEditable === true || el.closest('[contenteditable=""],[contenteditable="true"]') !== null;
  }

  private genericScan(root0: Element) {
    let root = root0;
    if (root === this.doc.documentElement) {
      if (this.doc.body) this.dirty.add(this.doc.body);
      return;
    }
    const s = root.getAttribute(STATE_ATTR);
    if (s === 'blocked' || s === 'revealed') return;
    const full = root.textContent ?? '';
    if (full.length > SPLIT_ROOT_TEXT && root.children.length) {
      for (const c of Array.from(root.children)) this.dirty.add(c);
      return;
    }
    if (full.length < 200 && root !== this.doc.body) {
      // small change: evaluate with the surrounding container for context (no style reads here – hot path)
      const u = this.contextFor(root);
      if (u && u !== root && !this.isEditable(u)) {
        const us = u.getAttribute(STATE_ATTR);
        if (us === 'blocked' || us === 'revealed') return;
        root = u;
      }
    }
    if (this.isEditable(root)) return;
    const detector = this.cfg.detector!;
    const quick = detector.evaluate(this.unitText(root));
    if (!quick.blocked) {
      // a previously blocked generic unit may have become safe
      const st = this.states.get(root);
      if (st?.kind === 'generic' && root.getAttribute(STATE_ATTR)) this.evaluateUnit(root, this.unitText(root), 'generic');
      return;
    }
    const units = new Set<Element>();
    const excl = this.exclSel;
    const walker = this.doc.createTreeWalker(root, 5, {
      acceptNode: (n) => {
        if (n.nodeType === 1) {
          const e = n as Element;
          if (e !== root && (SKIP_TAGS.has(e.tagName) || this.isOurs(e) || (excl && e.matches(excl)) || e.getAttribute('contenteditable') === 'true')) return 2;
          if (e.tagName === 'IMG' && this.cfg.blockImages) return 1;
          return 3;
        }
        return (n.nodeValue ?? '').trim().length >= 2 ? 1 : 3;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const u = this.unitFor(n, n.nodeType === 1);
      if (u) units.add(u);
      if (units.size > 400) break;
    }
    const ordered = [...units].sort((a, b) => depth(b) - depth(a));
    let any = false;
    for (const u of ordered) {
      if (!u.isConnected || (this.cardSel && u.matches(this.cardSel))) continue;
      const anc = u.parentElement?.closest(`[${STATE_ATTR}="blocked"],[${STATE_ATTR}="revealed"]`);
      if (anc) continue;
      if (this.evaluateUnit(u, this.unitText(u), 'generic').blocked) any = true;
    }
    if (!any && root !== this.doc.body && full.length <= 3000 && !(this.cardSel && root.matches(this.cardSel))) {
      this.evaluateUnit(root, this.unitText(root), 'generic');
    }
  }

  private contextFor(el: Element): Element | null {
    const body = this.doc.body;
    let cur: Element | null = el.parentElement;
    for (let d = 0; cur && cur !== body && d < 6; d++, cur = cur.parentElement) {
      if (cur.matches(CARD_LIKE)) return (cur.textContent?.length ?? 0) <= MAX_UNIT_TEXT ? cur : null;
    }
    const p = el.parentElement;
    return p && p !== body && (p.textContent?.length ?? 0) <= MAX_UNIT_TEXT ? p : null;
  }

  /** Smallest sensible container to hide for a matching text node / image. */
  private unitFor(n: Node, isImage: boolean): Element | null {
    const start = n.nodeType === 1 ? (n as Element) : n.parentElement;
    if (!start) return null;
    const body = this.doc.body;
    const html = this.doc.documentElement;
    const limit = isImage ? MAX_IMAGE_UNIT_TEXT : MAX_UNIT_TEXT;
    let cur: Element | null = start;
    let mediaLink: Element | null = null;
    const para = isImage ? null : start.closest('p');
    for (let d = 0; cur && cur !== body && cur !== html && d < 12; d++, cur = cur.parentElement) {
      if (cur.matches(CARD_LIKE)) {
        // prose: a paragraph inside a multi-paragraph container is hidden on its own
        if (para && cur.contains(para) && cur.querySelectorAll('p').length > 1) return para;
        if ((cur.textContent?.length ?? 0) <= limit) return cur;
        break;
      }
      if (!mediaLink && cur.tagName === 'A' && cur.querySelector('img,picture,video') && (cur.textContent?.length ?? 0) <= limit) mediaLink = cur;
    }
    if (mediaLink) return mediaLink;
    const view = this.doc.defaultView;
    cur = start;
    for (let d = 0; cur && cur !== body && cur !== html && d < 8; d++, cur = cur.parentElement) {
      if (VOID_TAGS.has(cur.tagName) || cur.tagName === 'PICTURE') continue;
      const disp = view ? view.getComputedStyle(cur).display : 'block';
      if (disp && disp !== 'inline' && disp !== 'contents' && disp !== 'none') {
        if (isImage && (cur.textContent?.length ?? 0) > limit) return start.tagName === 'IMG' ? start : null;
        return cur;
      }
    }
    if (start === body || start === html) return null;
    return start;
  }
}

function depth(el: Element): number {
  let d = 0;
  for (let p = el.parentElement; p; p = p.parentElement) d++;
  return d;
}

function fileName(src: string): string {
  const clean = src.split(/[?#]/)[0];
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last).slice(0, 120);
  } catch {
    return last.slice(0, 120);
  }
}

function pathOf(href: string): string {
  let p = href;
  const i = p.indexOf('://');
  if (i >= 0) {
    const j = p.indexOf('/', i + 3);
    p = j >= 0 ? p.slice(j) : '';
  }
  p = p.split(/[?#]/)[0];
  try {
    return decodeURIComponent(p).slice(0, 200);
  } catch {
    return p.slice(0, 200);
  }
}

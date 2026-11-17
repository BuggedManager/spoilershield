/**
 * Multi-layer detection engine.
 *  Layer 1  exact phrase matching           (token-index lookup, longest match wins)
 *  Layer 2  normalized matching             (normalize(): unicode, spacing, punctuation, hashtags)
 *  Layer 3  contextual scoring              (weights + context gating + diversity bonus)
 *  Layer 4  extended detection (optional)   (typo-tolerant matching + indirect references)
 * Layer 5 (images) lives in src/ai/.
 */
import type { CompiledDictionary } from './dictionary';
import { hashText, normalize } from './normalize';
import type { Category, TermEntry } from './vocabulary';
import { compileGroup, compileUserTerms, dedupe } from './vocabulary';
import type { CustomKeyword, GameProfile, Mode, Sensitivity } from '../storage/settings';

export interface DetectorOptions {
  mode: Mode;
  sensitivity: Sensitivity;
  blockGameContent: boolean;
  blockStorySpoilers: boolean;
  languages: string[];
  extended: boolean;
  builtinEnabled: boolean;
  customKeywords: CustomKeyword[];
  profiles: GameProfile[];
}

export interface Detection {
  blocked: boolean;
  score: number;
  threshold: number;
  /** true if story-spoiler terminology contributed */
  spoiler: boolean;
  profileId: string | null;
  profileName: string | null;
  /** matched categories (never the matched text itself) */
  categories: Category[];
  /** stable identity of what matched (hash of matched terms) – used to keep a reveal across minor text changes */
  key: number;
}

export const MODE_THRESHOLD: Record<Mode, number> = { standard: 60, strict: 40, maximum: 30 };
export const SENSITIVITY_OFFSET: Record<Sensitivity, number> = { low: 20, medium: 0, high: -15 };
/** minimum direct game evidence before context-only words count */
export const CONTEXT_MIN = 20;
export const DIVERSITY_BONUS = 15;
export const SPOILER_RELIEF = 20;
const FUZZY_FACTOR = 0.8;
const MAX_TEXT = 20000;
const CACHE_MAX = 1500;
const CACHE_KEY_MAX = 2000;
/** real words near dictionary targets that must never fuzzy-match */
const FUZZY_STOP = new Set(['leonidas', 'leonides', 'leonidaa', 'gellhorns']);
/** hashtag suffixes allowed after a compact title prefix (#gtavionline) – prevents #gtavicecity / #gtavideos */
const EXTRA_SUFFIXES = ['online', 'rp', 'news', 'hype', 'memes', 'meme', 'clips', 'community', 'countdown', 'fans', 'fan', 'info', 'updates', 'official', 'reveal', 'release', 'beta', 'pc', 'ps5', 'xbox', 'leaks', 'leak', 'trailer', 'gameplay', 'ending', 'spoiler', 'spoilers', 'map', 'fr', 'qc', 'france', 'quebec'];

interface Indexed {
  tokens: string[];
  e: TermEntry;
  /** per-token letter bitmasks (fuzzy targets only) */
  masks?: number[];
}

/** 26 letter bits + 1 digit bit. Edit distance d changes at most 2d bits. */
function letterMask(s: string): number {
  let m = 0;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i) - 97;
    m |= k >= 0 && k < 26 ? 1 << k : 1 << 26;
  }
  return m;
}
function popcount(n: number): number {
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
const FUZZY_MISS_MAX = 8000;

interface Hit {
  e: TermEntry;
  w: number;
}

const STRONG_CATS: Category[] = ['title', 'character', 'pair', 'location', 'location_amb', 'franchise', 'cue', 'custom'];

export const NO_DETECTION: Detection = Object.freeze({
  blocked: false,
  score: 0,
  threshold: 0,
  spoiler: false,
  profileId: null,
  profileName: null,
  categories: [],
  key: 0,
}) as Detection;

export class Detector {
  readonly threshold: number;
  private readonly index = new Map<string, Indexed[]>();
  private readonly prefixes = new Map<string, Indexed[]>();
  private readonly fuzzyByLen = new Map<number, Indexed[]>();
  private readonly suffixes = new Set<string>(EXTRA_SUFFIXES);
  private readonly fuzzyFirst = new Set<string>();
  /** words known to have no fuzzy candidate (bounded cache) */
  private readonly fuzzyMiss = new Set<string>();
  private readonly profileNames = new Map<string, string>();
  private readonly cache = new Map<string, Detection>();
  private readonly opts: DetectorOptions;
  /** number of active (non-legacy) terms, for diagnostics */
  readonly termCount: number;

  constructor(dict: CompiledDictionary, opts: DetectorOptions) {
    this.opts = opts;
    this.threshold = Math.max(20, MODE_THRESHOLD[opts.mode] + SENSITIVITY_OFFSET[opts.sensitivity]);
    const langs = new Set(opts.languages);
    const terms: TermEntry[] = [];

    for (const p of dict.profiles) this.profileNames.set(p.id, p.name);
    for (const e of dict.terms) {
      if (e.p === '*') {
        if (e.lang && !langs.has(e.lang)) continue;
      } else if (!opts.builtinEnabled && e.p === 'gta6') continue;
      if (e.ext && !opts.extended) continue;
      terms.push(e);
    }
    terms.push(...compileUserTerms('gta6', opts.customKeywords));
    for (const p of opts.profiles) {
      if (!p.enabled) continue;
      const id = `custom:${p.id}`;
      this.profileNames.set(id, p.name);
      terms.push(
        ...compileGroup(id, { category: 'title', weight: 100, terms: p.titles, prefixMatch: true }),
        ...compileGroup(id, { category: 'custom', weight: 50, terms: p.terms }),
        ...compileGroup(id, { category: 'alias', weight: 15, requiresContext: true, terms: p.contextTerms }),
      );
    }

    const all = dedupe(terms);
    this.termCount = all.length;
    for (const e of all) {
      const tokens = e.t.split(' ');
      const item: Indexed = { tokens, e };
      push(this.index, tokens[0], item);
      if (e.prefix) push(this.prefixes, tokens[0][0], item);
      if (e.p === '*' && tokens.length === 1) this.suffixes.add(tokens[0]);
      if (
        opts.extended &&
        !e.ctx &&
        (e.c === 'title' || e.c === 'character' || e.c === 'location') &&
        tokens.some((t) => t.length >= 6)
      ) {
        item.masks = tokens.map(letterMask);
        push(this.fuzzyByLen, tokens[0].length, item);
        if (tokens.length > 1) this.fuzzyFirst.add(tokens[0]);
      }
    }
    for (const list of this.index.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);
  }

  evaluate(text: string): Detection {
    if (!text) return NO_DETECTION;
    const cacheable = text.length <= CACHE_KEY_MAX;
    if (cacheable) {
      const hit = this.cache.get(text);
      if (hit) {
        this.cache.delete(text);
        this.cache.set(text, hit);
        return hit;
      }
    }
    const res = this.evaluateNormalized(normalize(text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text));
    if (cacheable) {
      this.cache.set(text, res);
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    }
    return res;
  }

  evaluateNormalized(norm: string): Detection {
    if (!norm) return NO_DETECTION;
    const hits = this.match(norm.split(' '));
    if (!hits.length) return { ...NO_DETECTION, threshold: this.threshold };
    return this.score(hits);
  }

  /** Layer 1/2/4: walk tokens, longest match first, consume matched tokens. */
  private match(tokens: string[]): Hit[] {
    const hits: Hit[] = [];
    const n = tokens.length;
    let i = 0;
    while (i < n) {
      const tok = tokens[i];
      let len = 0;
      const cands = this.index.get(tok);
      const exact: Hit[] = [];
      if (cands) {
        for (const c of cands) {
          if (len && c.tokens.length < len) break;
          if (matchesAt(tokens, i, c.tokens)) {
            len = c.tokens.length;
            exact.push({ e: c.e, w: c.e.w });
          }
        }
      }
      // a weak single-word hit ("lucia") may be the start of a misspelled full name ("lucia caminoss")
      if (len === 1 && this.fuzzyFirst.has(tok) && exact.every((h) => h.e.ctx)) {
        const fz: Hit[] = [];
        const flen = this.fuzzyAt(tokens, i, fz);
        if (flen > 1) {
          exact.length = 0;
          exact.push(...fz);
          len = flen;
        }
      }
      for (const h of exact) hits.push(h);
      if (!len && tok.length >= 6) {
        const pre = this.prefixes.get(tok[0]);
        if (pre) {
          for (const p of pre) {
            if (tok.startsWith(p.tokens[0]) && this.suffixes.has(tok.slice(p.tokens[0].length))) {
              hits.push({ e: p.e, w: p.e.w });
              len = 1;
              break;
            }
          }
        }
      }
      if (!len && this.fuzzyByLen.size && (tok.length >= 6 || this.fuzzyFirst.has(tok)) && !FUZZY_STOP.has(tok)) {
        len = this.fuzzyAt(tokens, i, hits);
      }
      i += len || 1;
    }
    return hits;
  }

  private fuzzyAt(tokens: string[], i: number, hits: Hit[]): number {
    const first = tokens[i];
    if (this.fuzzyMiss.has(first)) return 0;
    const L = first.length;
    const masks: number[] = [];
    const maskAt = (k: number) => (masks[k] ??= letterMask(tokens[i + k]));
    let firstOk = false;
    for (let d = -2; d <= 2; d++) {
      const bucket = this.fuzzyByLen.get(L + d);
      if (!bucket) continue;
      for (const c of bucket) {
        if (i + c.tokens.length > tokens.length) {
          firstOk = true; // not enough words left – don't cache this word as a miss
          continue;
        }
        let fuzzyUsed = false;
        let ok = true;
        for (let k = 0; k < c.tokens.length; k++) {
          const a = tokens[i + k];
          const b = c.tokens[k];
          if (a === b) continue;
          const minLen = c.tokens.length === 1 ? 7 : 6;
          if (a.length < minLen || b.length < minLen || FUZZY_STOP.has(a)) {
            ok = false;
            break;
          }
          const max = b.length >= 10 ? 2 : 1;
          if (
            Math.abs(a.length - b.length) > max ||
            popcount(maskAt(k) ^ c.masks![k]) > 2 * max ||
            osa(a, b, max) > max
          ) {
            ok = false;
            break;
          }
          fuzzyUsed = true;
          if (k === 0) firstOk = true;
        }
        if (c.tokens[0] === first) firstOk = true;
        if (ok && fuzzyUsed) {
          hits.push({ e: c.e, w: Math.round(c.e.w * FUZZY_FACTOR) });
          return c.tokens.length;
        }
      }
    }
    if (!firstOk) {
      if (this.fuzzyMiss.size >= FUZZY_MISS_MAX) this.fuzzyMiss.clear();
      this.fuzzyMiss.add(first);
    }
    return 0;
  }

  /** Layer 3: contextual scoring per profile. */
  private score(hits: Hit[]): Detection {
    const shared: Hit[] = [];
    const byProfile = new Map<string, Hit[]>();
    for (const h of hits) {
      if (h.e.c === 'legacy') continue;
      if (h.e.p === '*') shared.push(h);
      else push(byProfile, h.e.p, h);
    }
    let best: Detection | null = null;
    for (const [pid, phits] of byProfile) {
      const d = this.scoreProfile(pid, phits, shared);
      if (!best || (d.blocked && !best.blocked) || (d.blocked === best.blocked && d.score > best.score)) best = d;
    }
    return best ?? { ...NO_DETECTION, threshold: this.threshold };
  }

  private scoreProfile(pid: string, phits: Hit[], shared: Hit[]): Detection {
    let direct = 0;
    const seen = new Set<string>();
    const cats = new Set<Category>();
    const strongCats = new Set<Category>();
    const aliasW: number[] = [];
    for (const h of phits) {
      const key = h.e.c + '|' + h.e.t;
      if (seen.has(key)) continue;
      seen.add(key);
      cats.add(h.e.c);
      if (h.e.ctx) aliasW.push(h.w);
      else {
        direct += h.w;
        if (STRONG_CATS.includes(h.e.c)) strongCats.add(h.e.c);
      }
    }
    let contextual = 0;
    let spoilerCount = 0;
    if (direct >= CONTEXT_MIN) {
      const spoilerW: number[] = [];
      const mediaW: number[] = [];
      const seenShared = new Set<string>();
      for (const h of shared) {
        if (seenShared.has(h.e.t)) continue;
        seenShared.add(h.e.t);
        cats.add(h.e.c);
        (h.e.c === 'spoiler' ? spoilerW : mediaW).push(h.w);
      }
      spoilerCount = spoilerW.length;
      contextual = top2(aliasW) + top2(spoilerW) + top2(mediaW);
    }
    const bonus = strongCats.size >= 2 ? DIVERSITY_BONUS : 0;
    const key = hashText([...seen, ...shared.map((h) => h.e.t)].sort().join('|'));
    const score = direct + contextual + bonus;
    const o = this.opts;
    const asContent = o.blockGameContent && score >= this.threshold;
    const asSpoiler = o.blockStorySpoilers && spoilerCount > 0 && direct >= CONTEXT_MIN && score >= this.threshold - SPOILER_RELIEF;
    return {
      blocked: asContent || asSpoiler,
      score,
      threshold: this.threshold,
      spoiler: spoilerCount > 0,
      profileId: pid,
      profileName: this.profileNames.get(pid) ?? 'GTA 6',
      categories: [...cats],
      key,
    };
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

function matchesAt(tokens: string[], i: number, phrase: string[]): boolean {
  if (i + phrase.length > tokens.length) return false;
  for (let k = 1; k < phrase.length; k++) if (tokens[i + k] !== phrase[k]) return false;
  return true;
}

function top2(ws: number[]): number {
  if (!ws.length) return 0;
  if (ws.length === 1) return ws[0];
  const s = [...ws].sort((a, b) => b - a);
  return s[0] + s[1];
}

/** Optimal-string-alignment distance with early exit above `max`. */
export function osa(a: string, b: string, max: number): number {
  const m = a.length;
  const n = b.length;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[n];
}

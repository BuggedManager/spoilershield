/**
 * Vocabulary expansion (Category G). Shared by the build-time dictionary
 * generator (scripts/build-dictionary.ts) and the runtime (user custom
 * keywords / custom game profiles), so both produce identical variants.
 */
import { normalize } from './normalize';

export type Category =
  | 'title' // exact game title, always strong
  | 'character' // distinctive full character name
  | 'pair' // "jason and lucia"
  | 'alias' // common first names / surnames – context only
  | 'location' // distinctive location
  | 'location_amb' // ambiguous location (vice city, ambrosia)
  | 'franchise' // "gta", "grand theft auto", "rockstar games"
  | 'cue' // indirect reference ("next gta") – extended detection only
  | 'spoiler' // story spoiler terminology – context only
  | 'media' // trailer / gameplay / map – context only
  | 'legacy' // older GTA titles – masks tokens so they don't add context
  | 'custom'; // user-provided

export interface TermEntry {
  /** canonical normalized phrase, tokens separated by single spaces */
  t: string;
  c: Category;
  w: number;
  /** profile id, or "*" for shared terms (spoiler/media) */
  p: string;
  /** only counts when other game context is present */
  ctx?: boolean;
  /** language code for shared terms */
  lang?: string;
  /** single-token compact form that may prefix a longer hashtag token (#gtavileaks) */
  prefix?: boolean;
  /** only active when extended detection is enabled */
  ext?: boolean;
}

export interface SeedGroup {
  category: Category;
  weight: number;
  terms: string[];
  requiresContext?: boolean;
  expandNumeral?: boolean;
  prefixMatch?: boolean;
  plural?: boolean;
  extended?: boolean;
  lang?: string;
}

export const DEFAULT_NUMERALS = ['6', 'vi', 'six'];
const MAX_JOIN_TOKENS = 5;

/**
 * Expand one human-written phrase into all canonical variants:
 *  - numeral slot {n} → 6 / vi / six
 *  - every join/split combination of its words (grand theft auto vi → grandtheftautovi, grandtheftauto vi …)
 *  - optional plural of the final word
 * Every variant is pushed back through normalize() so variants equal what page text normalizes to.
 */
export function expandPhrase(
  phrase: string,
  opts: { numerals?: string[]; plural?: boolean } = {},
): string[] {
  const bases = phrase.includes('{n}') ? (opts.numerals ?? DEFAULT_NUMERALS).map((n) => phrase.split('{n}').join(n)) : [phrase];
  const out = new Set<string>();
  for (const base of bases) {
    const canonical = normalize(base);
    if (!canonical) continue;
    const tokens = canonical.split(' ');
    for (const v of joinVariants(tokens)) {
      const n = normalize(v);
      if (n) out.add(n);
    }
    if (opts.plural) {
      const last = tokens[tokens.length - 1];
      if (last.length > 3 && !last.endsWith('s') && !/\d$/.test(last)) {
        out.add([...tokens.slice(0, -1), last + 's'].join(' '));
      }
    }
  }
  return [...out];
}

/** All 2^(n-1) ways to join adjacent tokens (bounded to MAX_JOIN_TOKENS). */
function joinVariants(tokens: string[]): string[] {
  if (tokens.length <= 1 || tokens.length > MAX_JOIN_TOKENS) return [tokens.join(' ')];
  const res: string[] = [];
  const gaps = tokens.length - 1;
  for (let mask = 0; mask < 1 << gaps; mask++) {
    let s = tokens[0];
    for (let i = 0; i < gaps; i++) s += (mask & (1 << i) ? '' : ' ') + tokens[i + 1];
    res.push(s);
  }
  return res;
}

export function compileGroup(profileId: string, g: SeedGroup, numerals?: string[]): TermEntry[] {
  const entries: TermEntry[] = [];
  for (const term of g.terms) {
    for (const t of expandPhrase(term, { numerals: g.expandNumeral ? numerals : undefined, plural: g.plural })) {
      const e: TermEntry = { t, c: g.category, w: g.weight, p: profileId };
      if (g.requiresContext) e.ctx = true;
      if (g.extended) e.ext = true;
      if (g.lang) e.lang = g.lang;
      if (g.prefixMatch && !t.includes(' ') && t.length >= 5) e.prefix = true;
      entries.push(e);
    }
  }
  return entries;
}

const CATEGORY_RANK: Record<Category, number> = {
  title: 10, custom: 9, character: 8, location: 7, pair: 6, cue: 5, location_amb: 4, franchise: 3,
  legacy: 2, spoiler: 1, media: 0, alias: 0,
};

/**
 * Deduplicate equivalent terms: same canonical text + profile (+lang for shared)
 * keeps the strongest entry (higher category rank, then weight).
 */
export function dedupe(entries: TermEntry[]): TermEntry[] {
  const best = new Map<string, TermEntry>();
  for (const e of entries) {
    const key = `${e.p}|${e.lang ?? ''}|${e.t}`;
    const prev = best.get(key);
    if (
      !prev ||
      CATEGORY_RANK[e.c] > CATEGORY_RANK[prev.c] ||
      (CATEGORY_RANK[e.c] === CATEGORY_RANK[prev.c] && e.w > prev.w)
    ) {
      best.set(key, e);
    }
  }
  return [...best.values()];
}

export type Strength = 'strong' | 'medium' | 'weak';
export const STRENGTH_WEIGHT: Record<Strength, number> = { strong: 100, medium: 50, weak: 15 };

/** Runtime: turn user keywords into entries for a profile. */
export function compileUserTerms(profileId: string, terms: { term: string; strength: Strength }[]): TermEntry[] {
  const out: TermEntry[] = [];
  for (const { term, strength } of terms) {
    if (!term || !term.trim()) continue;
    out.push(
      ...compileGroup(profileId, {
        category: strength === 'weak' ? 'alias' : 'custom',
        weight: STRENGTH_WEIGHT[strength] ?? 50,
        requiresContext: strength === 'weak',
        terms: [term.slice(0, 120)],
      }),
    );
  }
  return out;
}

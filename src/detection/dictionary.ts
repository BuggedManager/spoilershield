import type { SeedGroup, TermEntry } from './vocabulary';
import { compileGroup, dedupe } from './vocabulary';

export interface CompiledDictionary {
  version: string;
  profiles: { id: string; name: string }[];
  languages: { code: string; label: string }[];
  terms: TermEntry[];
  stats?: Record<string, number>;
}

export interface ProfileSeed {
  id: string;
  name: string;
  version: string;
  numerals?: string[];
  groups: SeedGroup[];
  legacy?: string[];
}

export interface LanguageSeed {
  lang: string;
  label: string;
  spoiler: string[];
  media: string[];
}

export const SPOILER_WEIGHT = 25;
export const MEDIA_WEIGHT = 15;

/** Pure function: seeds → compiled dictionary. Used by scripts/build-dictionary.ts. */
export function buildDictionary(profiles: ProfileSeed[], languages: LanguageSeed[]): CompiledDictionary {
  const terms: TermEntry[] = [];
  for (const p of profiles) {
    for (const g of p.groups) terms.push(...compileGroup(p.id, g, p.numerals));
    if (p.legacy?.length) {
      terms.push(...compileGroup(p.id, { category: 'legacy', weight: 0, terms: p.legacy }));
    }
  }
  for (const l of languages) {
    terms.push(
      ...compileGroup('*', { category: 'spoiler', weight: SPOILER_WEIGHT, requiresContext: true, lang: l.lang, terms: l.spoiler }),
      ...compileGroup('*', { category: 'media', weight: MEDIA_WEIGHT, requiresContext: true, lang: l.lang, terms: l.media }),
    );
  }
  const deduped = dedupe(terms).sort((a, b) => b.w - a.w || a.t.localeCompare(b.t));
  const stats: Record<string, number> = { total: deduped.length };
  for (const t of deduped) {
    const bucket = t.ctx ? 'contextOnly' : t.c === 'legacy' ? 'legacyMask' : t.w >= 60 ? 'high' : t.w >= 30 ? 'medium' : 'low';
    stats[bucket] = (stats[bucket] ?? 0) + 1;
  }
  return {
    version: profiles.map((p) => `${p.id}@${p.version}`).join(','),
    profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
    languages: languages.map((l) => ({ code: l.lang, label: l.label })),
    terms: deduped,
    stats,
  };
}

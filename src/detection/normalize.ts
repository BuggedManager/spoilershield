/**
 * Text normalization pipeline used by both the dictionary generator and the
 * runtime detector. Both sides MUST use the same function so that dictionary
 * terms and page text land in the same canonical token space.
 *
 * Output: lowercase ASCII tokens [a-z0-9]+ separated by single spaces.
 *
 * Steps (order matters):
 *  1. NFKC            – fullwidth, math alphanumerics, circled digits (⑥→6), Ⅵ→VI, superscripts
 *  2. strip invisibles – zero-width chars, soft hyphen, BOM, word joiner, variation selectors
 *  3. confusables      – Greek/Cyrillic look-alike letters → Latin (GΤA, GTΛ)
 *  4. camelCase split  – #GrandTheftAutoVI → Grand Theft Auto VI, GTAVIOnline → GTAVI Online
 *  5. strip diacritics – divulgâcheur → divulgacheur
 *  6. lowercase, non-alphanumerics → space
 *  7. merge runs of ≥3 single-character tokens – "G T A 6", "G.T.A.6" → gta6
 *  8. split letter/digit boundaries – gta6 → gta 6, gta6leaks → gta 6 leaks
 *
 * Deliberately NOT done (too aggressive, would create false positives):
 *  - joining arbitrary words together ("vikingta 6" must not become "gta 6")
 *  - leetspeak substitution (4→a, 3→e)
 */

const INVISIBLES = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

/** Look-alike characters that NFKC does not fold. Only letters are mapped. */
const CONFUSABLES: Record<string, string> = {
  // Greek capitals
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N',
  'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'Λ': 'A', 'Δ': 'A', 'Σ': 'E', 'Ϝ': 'F',
  // Greek small
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u',
  'ν': 'v', 'χ': 'x', 'γ': 'y', 'ω': 'w', 'λ': 'a',
  // Cyrillic capitals
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C',
  'Т': 'T', 'Х': 'X', 'У': 'Y', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'Ԁ': 'D', 'Ԍ': 'G', 'Ѵ': 'V',
  'Ӏ': 'I', 'Ԛ': 'Q', 'Ԝ': 'W', 'Б': 'B', 'Д': 'A', 'Л': 'A',
  // Cyrillic small
  'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c',
  'т': 't', 'х': 'x', 'у': 'y', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'ԁ': 'd', 'ԍ': 'g', 'ѵ': 'v',
  'ӏ': 'i', 'ԛ': 'q', 'ԝ': 'w',
  // Latin-ish symbols
  'ɢ': 'G', 'ʜ': 'H', 'ɪ': 'I', 'ʟ': 'L', 'ɴ': 'N', 'ʀ': 'R', 'ᴀ': 'A', 'ᴛ': 'T', 'ᴠ': 'V',
  'ᴜ': 'U', 'ᴅ': 'D', 'ᴇ': 'E', 'ᴏ': 'O', 'ꜱ': 'S', 'ᴄ': 'C', 'ᴋ': 'K', 'ᴍ': 'M', 'ᴘ': 'P',
  'ł': 'l', 'Ł': 'L', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D', 'ı': 'i', 'ß': 'ss', 'æ': 'ae',
  'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', '∀': 'A', '₲': 'G', '₮': 'T', '△': 'A',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

const COMBINING = /\p{M}+/gu;
const NON_ALNUM = /[^a-z0-9]+/g;

/** Full normalization → canonical token string ("gta 6 ending explained"). */
export function normalize(input: string): string {
  if (!input) return '';
  let s = input.normalize('NFKC');
  s = s.replace(INVISIBLES, '');
  s = s.replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c);
  // camelCase / PascalCase boundaries (must happen before lowercasing)
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  s = s.normalize('NFD').replace(COMBINING, '');
  s = s.toLowerCase().replace(NON_ALNUM, ' ');
  s = mergeSingleCharRuns(s);
  s = s.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2');
  return s.replace(/\s+/g, ' ').trim();
}

/** "g t a 6 ending" → "gta6 ending" (only runs of ≥3 single chars). */
function mergeSingleCharRuns(s: string): string {
  if (!/(?:^|\s)\S\s\S\s\S(?:\s|$)/.test(s)) return s; // fast path
  const tokens = s.split(' ');
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join(''));
    else out.push(...run);
    run = [];
  };
  for (const t of tokens) {
    if (t.length === 1) run.push(t);
    else {
      flush();
      if (t) out.push(t);
    }
  }
  flush();
  return out.join(' ');
}

export function tokenize(input: string): string[] {
  const n = normalize(input);
  return n ? n.split(' ') : [];
}

/** Cheap 32-bit FNV-1a hash used for text-change signatures and stat dedupe. */
export function hashText(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

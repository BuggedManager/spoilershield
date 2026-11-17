/**
 * Dictionary generation utility (Category G).
 *
 *   npm run dict                     – regenerate from seeds
 *   npm run dict -- --import extra.txt --profile gta6 --strength medium
 *                                    – merge extra keywords (one per line) into the seed first
 *
 * Seeds live in src/detection/data/*.json and contain ONLY verified, official
 * names + generic spoiler vocabulary. This script expands spelling / spacing /
 * numeral variants, groups them by confidence, deduplicates, and writes
 * src/detection/generated/dictionary.json which the extension bundles.
 * Detection logic never needs to change when the dictionary is updated.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDictionary, type LanguageSeed, type ProfileSeed } from '../src/detection/dictionary';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'src/detection/data');
const outDir = join(root, 'src/detection/generated');

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const files = readdirSync(dataDir);
const profiles: ProfileSeed[] = files
  .filter((f) => f.endsWith('.seed.json'))
  .map((f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8')));
const languages: LanguageSeed[] = files
  .filter((f) => /^terms\.[a-z]{2}\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8')));

const importFile = arg('import');
if (importFile) {
  const profileId = arg('profile') ?? 'gta6';
  const strength = (arg('strength') ?? 'medium') as 'strong' | 'medium' | 'weak';
  const weights = { strong: 100, medium: 50, weak: 10 };
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`Unknown profile ${profileId}`);
  const terms = readFileSync(importFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  profile.groups.push({
    category: strength === 'weak' ? 'alias' : strength === 'strong' ? 'title' : 'location',
    weight: weights[strength],
    requiresContext: strength === 'weak',
    terms,
  });
  console.log(`Imported ${terms.length} keywords into profile ${profileId} as ${strength}`);
}

const dict = buildDictionary(profiles, languages);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'dictionary.json'), JSON.stringify(dict));
console.log(`Dictionary ${dict.version}: ${dict.terms.length} canonical terms`, dict.stats);

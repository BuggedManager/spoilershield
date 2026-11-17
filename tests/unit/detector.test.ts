import { describe, expect, it } from 'vitest';
import { createDetector } from '../../src/detection';
import { normalize } from '../../src/detection/normalize';
import { expandPhrase } from '../../src/detection/vocabulary';
import { DEFAULT_SETTINGS, type Mode, type Settings } from '../../src/storage/settings';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });
const standard = createDetector(settings({ mode: 'standard' }));
const strict = createDetector(settings({ mode: 'strict' }));
const maximum = createDetector(settings({ mode: 'maximum' }));
const by: Record<Mode, typeof strict> = { standard, strict, maximum };

const blocked = (text: string, mode: Mode = 'standard') => by[mode].evaluate(text).blocked;

describe('normalize', () => {
  it.each([
    ['GTA 6', 'gta 6'],
    ['GTA6', 'gta 6'],
    ['#GTA6Online', 'gta 6 online'],
    ['GrandTheftAutoVI', 'grand theft auto vi'],
    ['G T A 6', 'gta 6'],
    ['G.T.A.6', 'gta 6'],
    ['G-T-A-VI', 'gta vi'],
    ['GTΛ VI', 'gta vi'],
    ['GΤA 6', 'gta 6'],
    ['GTA⑥', 'gta 6'],
    ['ＧＴＡ　６', 'gta 6'],
    ['G​T‍A 6', 'gta 6'],
    ['𝐆𝐓𝐀 𝟔', 'gta 6'],
    ['GTA Ⅵ', 'gta vi'],
    ['divulgâcheur', 'divulgacheur'],
    ["Dre'Quan", 'dre quan'],
    ['GTA: VI', 'gta vi'],
  ])('%s → %s', (input, out) => expect(normalize(input)).toBe(out));

  it('does not glue ordinary words together', () => {
    expect(normalize('Viking TA 6')).toBe('viking ta 6');
    expect(normalize('a b')).toBe('a b');
  });
});

describe('vocabulary expansion', () => {
  it('generates numeral, spacing and compact variants without duplicates', () => {
    const v = expandPhrase('grand theft auto {n}');
    expect(v).toContain('grand theft auto 6');
    expect(v).toContain('grand theft auto vi');
    expect(v).toContain('grandtheftautovi');
    expect(v).toContain('grandtheftauto six');
    expect(new Set(v).size).toBe(v.length);
  });
});

describe('Category A – titles (all modes)', () => {
  const titles = [
    'GTA 6', 'GTA VI', 'GTA6', 'GTAVI', 'GTA-VI', 'GTA: VI', 'Grand Theft Auto VI', 'Grand Theft Auto 6',
    'Grand Theft Auto Six', 'GrandTheftAutoVI', 'Grand Theft Auto 6 gameplay', 'GTA Six', 'GTA6Online',
    'GTA VI Online', 'GTA 6 RP', 'GTA 6 leaks', 'GTA 6 spoilers', 'GTA 6 ending', '#gta6', '#GTAVI',
    '#gtavileaks', 'gta six', 'r/GTA6', 'grandtheftautovi', 'Watch the new GTA 6 trailer here',
  ];
  it.each(titles)('blocks "%s" in standard', (t) => expect(blocked(t)).toBe(true));
});

describe('Category F – obfuscation', () => {
  it.each(['G T A 6', 'G.T.A.6', 'G-T-A-VI', 'GTΛ VI', 'GTA⑥', 'GTA SIX', 'GΤA 6', 'g​t​a 6', 'ＧＴＡ６', 'GTA 6️⃣'])(
    'blocks "%s"',
    (t) => expect(blocked(t)).toBe(true),
  );
});

describe('Category B – characters with context', () => {
  it('blocks distinctive full names', () => {
    expect(blocked('Jason Duval')).toBe(true);
    expect(blocked('Lucia Caminos is back')).toBe(true);
    expect(blocked('Boobie Ike interview')).toBe(true);
  });
  it('blocks first names only with game context', () => {
    expect(blocked('Jason GTA 6 gameplay')).toBe(true);
    expect(blocked('Lucia in the new Rockstar Games trailer', 'strict')).toBe(true);
  });
  it('does not block common first names alone', () => {
    for (const m of ['standard', 'strict', 'maximum'] as Mode[]) {
      expect(blocked('Jason bought a new keyboard', m)).toBe(false);
      expect(blocked('Lucia made pasta for dinner tonight', m)).toBe(false);
      expect(blocked('Jason and the Argonauts ending explained', m)).toBe(false);
    }
  });
  it('pair "Jason and Lucia" is blocked in strict', () => {
    expect(blocked('Jason and Lucia', 'strict')).toBe(true);
  });
});

describe('Category C – locations', () => {
  it('distinctive locations', () => {
    expect(blocked('Exploring Leonida', 'strict')).toBe(true);
    expect(blocked('Port Gellhorn at night', 'strict')).toBe(true);
    expect(blocked('Mount Kalaga National Park', 'strict')).toBe(true);
    expect(blocked('GTA Leonida map size')).toBe(true);
  });
  it('ambiguous locations need context', () => {
    expect(blocked('Ambrosia salad recipe', 'strict')).toBe(false);
    expect(blocked('Vice City', 'standard')).toBe(false);
    expect(blocked('Vice City trailer', 'strict')).toBe(true);
  });
  it('older GTA titles are not treated as GTA 6', () => {
    for (const m of ['standard', 'strict'] as Mode[]) {
      expect(blocked('GTA Vice City Definitive Edition review', m)).toBe(false);
      expect(blocked('GTA 5 ending explained', m)).toBe(false);
      expect(blocked('GTA San Andreas all missions', m)).toBe(false);
      expect(blocked('#gtavicecity', m)).toBe(false);
      expect(blocked('#gtavideos', m)).toBe(false);
    }
  });
  it('still catches GTA 6 when an older title is mentioned too', () => {
    expect(blocked('GTA 5 vs GTA 6 graphics comparison')).toBe(true);
  });
});

describe('Category D – spoiler terminology', () => {
  it('spoiler terms alone are harmless', () => {
    for (const m of ['standard', 'strict', 'maximum'] as Mode[]) {
      expect(blocked('The ending of this movie was a plot twist', m)).toBe(false);
      expect(blocked('Final boss guide for Elden Ring', m)).toBe(false);
      expect(blocked('All missions completed in Hitman', m)).toBe(false);
    }
  });
  it('flags spoilers with game context', () => {
    const d = standard.evaluate('GTA ending explained');
    expect(d.blocked).toBe(true);
    expect(d.spoiler).toBe(true);
    expect(standard.evaluate('Lucia Caminos betrayal final mission').spoiler).toBe(true);
  });
  it('spoiler-only mode lets plain news through but blocks story content', () => {
    const d = createDetector(settings({ mode: 'standard', blockGameContent: false, blockStorySpoilers: true }));
    expect(d.evaluate('GTA 6 release date confirmed').blocked).toBe(false);
    expect(d.evaluate('GTA 6 ending explained').blocked).toBe(true);
    expect(d.evaluate('GTA 6 secret ending leaked').blocked).toBe(true);
  });
});

describe('Category E – French / Québec', () => {
  it.each(['GTA 6 fin', 'GTA 6 histoire', 'GTA 6 divulgâcheur', 'GTA 6 révélation', 'GTA 6 dernière mission', 'GTA 6 fuite', 'GTA 6 bande-annonce', 'GTA 6 personnages', 'GTA 6 carte'])(
    '%s',
    (t) => expect(blocked(t)).toBe(true),
  );
  it('French spoiler words flag spoilers', () => {
    expect(standard.evaluate('GTA 6 : la fin expliquée').spoiler).toBe(true);
    expect(standard.evaluate('Le prochain GTA : divulgâcheur de la mission finale').blocked).toBe(true);
  });
  it('French spoiler words are ignored when French is disabled', () => {
    const en = createDetector(settings({ mode: 'standard', languages: ['en'], blockGameContent: false }));
    expect(en.evaluate('GTA 6 divulgâcheur').blocked).toBe(false);
  });
});

describe('Layer 4 – extended detection', () => {
  it('typo tolerant on distinctive names', () => {
    expect(blocked('Lucia Caminoss trailer', 'strict')).toBe(true);
    expect(blocked('Grand Theft Auto VI', 'strict')).toBe(true);
    expect(blocked('Leonidaa map', 'strict')).toBe(false); // stop-list guards near misses
    expect(blocked('Leonidas, king of Sparta', 'maximum')).toBe(false);
  });
  it('indirect references', () => {
    expect(blocked("Rockstar's next game trailer", 'strict')).toBe(true);
    const off = createDetector(settings({ mode: 'strict', extendedDetection: false }));
    expect(off.evaluate("Rockstar's next game").blocked).toBe(false);
  });
});

describe('false positives – ordinary content stays visible (strict)', () => {
  const benign = [
    'How to bake sourdough bread at home',
    'Jason Momoa new movie trailer',
    'Lucia Bosè biography',
    'Miami Vice remake announced',
    'Port of Hamburg container traffic',
    'Rock star guitar solo compilation',
    'Top 10 open world games of all time',
    'GPU benchmark: RTX 5090 vs RX 9070',
    'Leonardo DiCaprio interview',
    'Episode 6 ending explained (The Bear)',
    'Mount Everest expedition documentary',
    'Six ways to save money',
    'VI editor tips and tricks',
    'Gran Turismo 7 update 1.6',
    'Duval County schools reopen',
    'Grass rivers of the Everglades ecology',
    'Final Fantasy VI pixel remaster review',
    'Star Wars Episode VI ending',
    'Rocky VI trailer reaction',
    'The camino de Santiago caminos guide',
    'gt a6 audi review',
    'Viking TA 6 tactical',
  ];
  it.each(benign)('"%s"', (t) => expect(blocked(t, 'strict')).toBe(false));
});

describe('modes and sensitivity', () => {
  it('thresholds are ordered', () => {
    expect(standard.threshold).toBeGreaterThan(strict.threshold);
    expect(strict.threshold).toBeGreaterThan(maximum.threshold);
  });
  it('strict blocks more than standard', () => {
    expect(blocked('Leonida', 'standard')).toBe(false);
    expect(blocked('Leonida', 'strict')).toBe(true);
  });
  it('sensitivity shifts the threshold', () => {
    const low = createDetector(settings({ mode: 'standard', sensitivity: 'low' }));
    const high = createDetector(settings({ mode: 'standard', sensitivity: 'high' }));
    expect(low.threshold).toBeGreaterThan(high.threshold);
  });
});

describe('custom keywords and profiles', () => {
  it('custom strong keyword', () => {
    const d = createDetector(settings({ customKeywords: [{ term: 'Project Americas', strength: 'strong' }] }));
    expect(d.evaluate('New project americas footage').blocked).toBe(true);
  });
  it('custom game profile with its own name', () => {
    const d = createDetector(
      settings({
        profiles: [{ id: 'ds3', name: 'Death Stranding 3', enabled: true, titles: ['Death Stranding 3'], terms: ['Sam Porter'], contextTerms: [] }],
      }),
    );
    const r = d.evaluate('Death Stranding 3 ending explained');
    expect(r.blocked).toBe(true);
    expect(r.profileName).toBe('Death Stranding 3');
  });
  it('builtin profile can be disabled', () => {
    const d = createDetector(settings({ builtinProfileEnabled: false }));
    expect(d.evaluate('GTA 6').blocked).toBe(false);
  });
});

describe('performance', () => {
  it('evaluates a typical card quickly', () => {
    const texts = Array.from({ length: 2000 }, (_, i) => `Video ${i}: my ${i % 7 === 0 ? 'GTA 6' : 'cooking'} adventure part ${i} — 1.2M views • 3 days ago Channel name ${i}`);
    const fresh = createDetector(settings());
    const t0 = performance.now();
    for (const t of texts) fresh.evaluate(t);
    const per = (performance.now() - t0) / texts.length;
    console.log(`[bench] uncached evaluate: ${(per * 1000).toFixed(1)} µs per card`);
    expect(per).toBeLessThan(1); // < 1 ms per card
  });
});

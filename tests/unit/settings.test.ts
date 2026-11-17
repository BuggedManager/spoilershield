import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addToStats,
  decideForSite,
  DEFAULT_SETTINGS,
  hostInList,
  loadSettings,
  normalizeHost,
  sanitizeSettings,
  sanitizeStats,
  saveSettings,
  todayKey,
} from '../../src/storage/settings';
import { dhashFromRgba, hamming, matchesAny, sanitizeRefs } from '../../src/ai/dhash';
import { adapterFor } from '../../src/adapters';

// minimal chrome.storage.local mock
let store: Record<string, unknown> = {};
beforeEach(() => {
  store = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string | string[]) => {
          const keys = Array.isArray(k) ? k : [k];
          return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, structuredClone(store[x])]));
        },
        set: async (o: Record<string, unknown>) => Object.assign(store, structuredClone(o)),
      },
      onChanged: { addListener: () => {} },
    },
  });
});

describe('settings persistence', () => {
  it('protection is enabled by default after installation', async () => {
    const s = await loadSettings();
    expect(s.enabled).toBe(true);
    expect(s.mode).toBe('strict');
    expect(s.blockGameContent && s.blockStorySpoilers && s.blockImages).toBe(true);
    expect(s.imageDetection).toBe(false); // experimental feature off by default
  });

  it('saves and reloads', async () => {
    await saveSettings({ mode: 'maximum', customKeywords: [{ term: 'Leonida Man', strength: 'strong' }] });
    const s = await loadSettings();
    expect(s.mode).toBe('maximum');
    expect(s.customKeywords).toEqual([{ term: 'Leonida Man', strength: 'strong' }]);
    expect((store.settings as { schema: number }).schema).toBe(1);
  });

  it('import validation rejects junk and keeps safe values', () => {
    const s = sanitizeSettings({
      enabled: 'yes',
      mode: 'ultra',
      sensitivity: 'high',
      languages: ['fr', 'xx-evil', 3],
      allowlist: ['https://www.Reddit.com/r/x', '<script>', '*.example.org'],
      customKeywords: ['plain string', { term: 'x'.repeat(500), strength: 'nuclear' }, { nope: 1 }],
      profiles: [{ id: 'BAD ID!', name: '', titles: ['Game 2', 5], terms: 'not a list' }],
      sites: { youtube: false, evil: true },
    });
    expect(s.enabled).toBe(true);
    expect(s.mode).toBe(DEFAULT_SETTINGS.mode);
    expect(s.sensitivity).toBe('high');
    expect(s.languages).toEqual(['fr']);
    expect(s.allowlist).toEqual(['reddit.com', 'example.org']);
    expect(s.customKeywords[0]).toEqual({ term: 'plain string', strength: 'medium' });
    expect(s.customKeywords[1].term.length).toBe(120);
    expect(s.customKeywords[1].strength).toBe('medium');
    expect(s.customKeywords.length).toBe(2);
    expect(s.profiles[0]).toMatchObject({ id: 'profile-1', name: 'Custom profile 1', titles: ['Game 2'], terms: [] });
    expect(s.sites.youtube).toBe(false);
    expect('evil' in s.sites).toBe(false);
  });
});

describe('site decisions', () => {
  it('normalizes hosts', () => {
    expect(normalizeHost('https://WWW.YouTube.com/watch?v=1')).toBe('youtube.com');
    expect(normalizeHost('m.reddit.com:443')).toBe('m.reddit.com');
    expect(normalizeHost('javascript:alert(1)')).toBe('');
  });
  it('allowlist matches subdomains', () => {
    expect(hostInList('old.reddit.com', ['reddit.com'])).toBe(true);
    expect(hostInList('notreddit.com', ['reddit.com'])).toBe(false);
  });
  it('allowlist pauses, blocklist forces maximum, disabled wins', () => {
    const s = { ...DEFAULT_SETTINGS, allowlist: ['example.com'], blocklist: ['gtaforums.com'] };
    expect(decideForSite(s, 'www.example.com', 'other')).toMatchObject({ active: false, reason: 'allowlisted' });
    expect(decideForSite(s, 'gtaforums.com', 'other')).toMatchObject({ active: true, mode: 'maximum' });
    expect(decideForSite({ ...s, enabled: false }, 'gtaforums.com', 'other').active).toBe(false);
    expect(decideForSite({ ...s, sites: { ...s.sites, youtube: false } }, 'www.youtube.com', 'youtube').reason).toBe('site-off');
  });
  it('picks the right adapter', () => {
    expect(adapterFor('www.youtube.com').id).toBe('youtube');
    expect(adapterFor('m.youtube.com').id).toBe('youtube');
    expect(adapterFor('www.google.co.uk').id).toBe('google');
    expect(adapterFor('mail.google.com').id).toBe('other');
    expect(adapterFor('old.reddit.com').id).toBe('reddit');
    expect(adapterFor('x.com').id).toBe('twitter');
    expect(adapterFor('www.twitch.tv').id).toBe('twitch');
    expect(adapterFor('news.ycombinator.com').id).toBe('other');
  });
});

describe('statistics', () => {
  it('counts per local day and keeps 30 days without any URLs', () => {
    let s = sanitizeStats(undefined);
    for (let d = 0; d < 40; d++) s = addToStats(s, 2, new Date(2026, 9, d + 1));
    expect(s.total).toBe(80);
    expect(Object.keys(s.days).length).toBe(30);
    s = addToStats(s, 3);
    expect(s.days[todayKey()]).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(s)).not.toMatch(/http|\.com/);
  });
});

describe('image fingerprints', () => {
  const img = (f: (x: number, y: number) => number) => {
    const d: number[] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) {
      const v = f(x, y);
      d.push(v, v, v, 255);
    }
    return d;
  };
  it('similar images match, different images do not', () => {
    const a = dhashFromRgba(img((x, y) => x * 20 + y * 3));
    const aBrighter = dhashFromRgba(img((x, y) => Math.min(255, x * 20 + y * 3 + 30)));
    const b = dhashFromRgba(img((x, y) => (y % 2 ? x * 20 : 200 - x * 20)));
    expect(a).toHaveLength(16);
    expect(hamming(a, aBrighter)).toBe(0);
    expect(matchesAny(aBrighter, [a])).toBe(true);
    expect(hamming(a, b)).toBeGreaterThan(10);
  });
  it('sanitizes stored references', () => {
    expect(sanitizeRefs([{ hash: 'zz' }, { hash: '0123456789abcdef', name: 'Key art' }])).toEqual([
      { id: '0123456789abcdef', name: 'Key art', hash: '0123456789abcdef' },
    ]);
  });
});

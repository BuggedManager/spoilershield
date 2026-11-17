import type { Strength } from '../detection/vocabulary';

export type Mode = 'standard' | 'strict' | 'maximum';
export type Sensitivity = 'low' | 'medium' | 'high';
export type SiteId = 'youtube' | 'google' | 'reddit' | 'twitter' | 'facebook' | 'instagram' | 'twitch' | 'other';

export const SITE_IDS: SiteId[] = ['youtube', 'google', 'reddit', 'twitter', 'facebook', 'instagram', 'twitch', 'other'];
export const SITE_LABELS: Record<SiteId, string> = {
  youtube: 'YouTube',
  google: 'Google Search',
  reddit: 'Reddit',
  twitter: 'X / Twitter',
  facebook: 'Facebook',
  instagram: 'Instagram',
  twitch: 'Twitch',
  other: 'All other websites',
};

export interface CustomKeyword {
  term: string;
  strength: Strength;
}

export interface GameProfile {
  id: string;
  name: string;
  enabled: boolean;
  /** exact titles – always strong */
  titles: string[];
  /** distinctive names / places – medium */
  terms: string[];
  /** weak words that only count alongside other context */
  contextTerms: string[];
}

export interface Settings {
  schema: 1;
  enabled: boolean;
  mode: Mode;
  sensitivity: Sensitivity;
  blockGameContent: boolean;
  blockStorySpoilers: boolean;
  blockImages: boolean;
  protectTabTitle: boolean;
  languages: string[];
  extendedDetection: boolean;
  imageDetection: boolean;
  builtinProfileEnabled: boolean;
  sites: Record<SiteId, boolean>;
  /** hostnames where SpoilerShield is paused / disabled */
  allowlist: string[];
  /** hostnames that always get Maximum Protection */
  blocklist: string[];
  customKeywords: CustomKeyword[];
  profiles: GameProfile[];
}

export interface Stats {
  total: number;
  /** local-date (YYYY-MM-DD) → count; last 30 days kept. No URLs or hostnames are stored. */
  days: Record<string, number>;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  schema: 1,
  enabled: true,
  mode: 'strict',
  sensitivity: 'medium',
  blockGameContent: true,
  blockStorySpoilers: true,
  blockImages: true,
  protectTabTitle: true,
  languages: ['en', 'fr'],
  extendedDetection: true,
  imageDetection: false,
  builtinProfileEnabled: true,
  sites: { youtube: true, google: true, reddit: true, twitter: true, facebook: true, instagram: true, twitch: true, other: true },
  allowlist: [],
  blocklist: [],
  customKeywords: [],
  profiles: [],
}) as Settings;

const MODES: Mode[] = ['standard', 'strict', 'maximum'];
const SENS: Sensitivity[] = ['low', 'medium', 'high'];
const STRENGTHS: Strength[] = ['strong', 'medium', 'weak'];
const MAX_LIST = 500;

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const strList = (v: unknown, max = MAX_LIST, maxLen = 200): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((s) => s.trim().slice(0, maxLen)).filter(Boolean))].slice(0, max)
    : [];

export function normalizeHost(input: string): string {
  let s = input.trim().toLowerCase();
  if (!s) return '';
  try {
    if (s.includes('://')) s = new URL(s).hostname;
  } catch {
    /* fall through */
  }
  s = s.replace(/^\*\./, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
  return /^[a-z0-9.-]+$/.test(s) ? s : '';
}

/** Validates any (possibly user-imported) object into a safe Settings value. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const sitesRaw = (r.sites && typeof r.sites === 'object' ? r.sites : {}) as Record<string, unknown>;
  const sites = {} as Record<SiteId, boolean>;
  for (const id of SITE_IDS) sites[id] = bool(sitesRaw[id], d.sites[id]);
  const customKeywords: CustomKeyword[] = Array.isArray(r.customKeywords)
    ? r.customKeywords
        .map((k): CustomKeyword | null => {
          if (typeof k === 'string') return { term: k.trim().slice(0, 120), strength: 'medium' };
          if (k && typeof k === 'object' && typeof (k as CustomKeyword).term === 'string') {
            const s = (k as CustomKeyword).strength;
            return { term: (k as CustomKeyword).term.trim().slice(0, 120), strength: STRENGTHS.includes(s) ? s : 'medium' };
          }
          return null;
        })
        .filter((k): k is CustomKeyword => !!k && !!k.term)
        .slice(0, MAX_LIST)
    : [];
  const profiles: GameProfile[] = Array.isArray(r.profiles)
    ? r.profiles
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map((p, i) => ({
          id: typeof p.id === 'string' && /^[a-z0-9-]{1,40}$/.test(p.id) ? p.id : `profile-${i + 1}`,
          name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 60) : `Custom profile ${i + 1}`,
          enabled: bool(p.enabled, true),
          titles: strList(p.titles, 100, 120),
          terms: strList(p.terms, 200, 120),
          contextTerms: strList(p.contextTerms, 200, 120),
        }))
        .slice(0, 20)
    : [];
  const langs = strList(r.languages, 10, 5).filter((l) => /^[a-z]{2}$/.test(l));
  return {
    schema: 1,
    enabled: bool(r.enabled, d.enabled),
    mode: MODES.includes(r.mode as Mode) ? (r.mode as Mode) : d.mode,
    sensitivity: SENS.includes(r.sensitivity as Sensitivity) ? (r.sensitivity as Sensitivity) : d.sensitivity,
    blockGameContent: bool(r.blockGameContent, d.blockGameContent),
    blockStorySpoilers: bool(r.blockStorySpoilers, d.blockStorySpoilers),
    blockImages: bool(r.blockImages, d.blockImages),
    protectTabTitle: bool(r.protectTabTitle, d.protectTabTitle),
    languages: langs.length ? langs : [...d.languages],
    extendedDetection: bool(r.extendedDetection, d.extendedDetection),
    imageDetection: bool(r.imageDetection, d.imageDetection),
    builtinProfileEnabled: bool(r.builtinProfileEnabled, d.builtinProfileEnabled),
    sites,
    allowlist: strList(r.allowlist).map(normalizeHost).filter(Boolean),
    blocklist: strList(r.blocklist).map(normalizeHost).filter(Boolean),
    customKeywords,
    profiles,
  };
}

/** host matches entry if equal or a subdomain of it. */
export function hostInList(host: string, list: string[]): boolean {
  const h = normalizeHost(host);
  return list.some((e) => h === e || h.endsWith('.' + e));
}

export interface SiteDecision {
  active: boolean;
  mode: Mode;
  reason: 'active' | 'disabled' | 'allowlisted' | 'site-off' | 'blocklisted';
}

export function decideForSite(s: Settings, host: string, site: SiteId): SiteDecision {
  if (!s.enabled) return { active: false, mode: s.mode, reason: 'disabled' };
  if (hostInList(host, s.allowlist)) return { active: false, mode: s.mode, reason: 'allowlisted' };
  if (hostInList(host, s.blocklist)) return { active: true, mode: 'maximum', reason: 'blocklisted' };
  if (!s.sites[site]) return { active: false, mode: s.mode, reason: 'site-off' };
  return { active: true, mode: s.mode, reason: 'active' };
}

export function todayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function sanitizeStats(raw: unknown): Stats {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const days: Record<string, number> = {};
  if (r.days && typeof r.days === 'object') {
    for (const [k, v] of Object.entries(r.days as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'number' && v >= 0) days[k] = Math.floor(v);
    }
  }
  return { total: typeof r.total === 'number' && r.total >= 0 ? Math.floor(r.total) : 0, days };
}

export function addToStats(stats: Stats, n: number, now = new Date()): Stats {
  const key = todayKey(now);
  const days = { ...stats.days, [key]: (stats.days[key] ?? 0) + n };
  const keep = Object.keys(days).sort().slice(-30);
  const trimmed: Record<string, number> = {};
  for (const k of keep) trimmed[k] = days[k];
  return { total: stats.total + n, days: trimmed };
}

// ---- chrome.storage wrappers -------------------------------------------------

export const SETTINGS_KEY = 'settings';
export const STATS_KEY = 'stats';

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(r[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = sanitizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function loadStats(): Promise<Stats> {
  const r = await chrome.storage.local.get(STATS_KEY);
  return sanitizeStats(r[STATS_KEY]);
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) cb(sanitizeSettings(changes[SETTINGS_KEY].newValue));
  });
}

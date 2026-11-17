import { createDetector, DICTIONARY } from '../detection';
import type { Strength } from '../detection/vocabulary';
import { dhashFromRgba, HASH_H, HASH_W, IMAGE_REFS_KEY, sanitizeRefs, type ImageRef } from '../ai/dhash';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadStats,
  normalizeHost,
  sanitizeSettings,
  saveSettings,
  SETTINGS_KEY,
  SITE_IDS,
  SITE_LABELS,
  todayKey,
  type GameProfile,
  type Mode,
  type Sensitivity,
  type Settings,
} from '../storage/settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let S: Settings;

/** Tiny DOM builder – text is always set via textContent (no HTML injection). */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else if (k === 'value') (el as HTMLInputElement).value = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function save(patch: Partial<Settings>, msg = 'Saved – applied to open tabs') {
  S = await saveSettings(patch);
  renderAll();
  toast(msg);
}

function switchEl(checked: boolean, label: string, onChange: (v: boolean) => void) {
  const input = h('input', { type: 'checkbox', 'aria-label': label });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('span', { class: 'switch' }, input, h('span', { class: 'track' }));
}

function renderBindings() {
  for (const el of document.querySelectorAll<HTMLInputElement>('[data-bind]')) {
    el.checked = !!S[el.dataset.bind as keyof Settings];
  }
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) r.checked = r.value === S.mode;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-sens]')) b.setAttribute('aria-pressed', String(b.dataset.sens === S.sensitivity));
  ($('imageDetection') as HTMLInputElement).checked = S.imageDetection;
}

function renderSites() {
  const wrap = $('siteToggles');
  wrap.replaceChildren(
    ...SITE_IDS.map((id) =>
      h('label', { class: 'site-toggle' }, SITE_LABELS[id], switchEl(S.sites[id], `Protect ${SITE_LABELS[id]}`, (v) => save({ sites: { ...S.sites, [id]: v } }))),
    ),
  );
  for (const key of ['allowlist', 'blocklist'] as const) {
    $(key).replaceChildren(
      ...S[key].map((host) =>
        h('span', { class: 'chip' }, host, h('button', { type: 'button', 'aria-label': `Remove ${host}`, onclick: () => save({ [key]: S[key].filter((x) => x !== host) }) }, '×')),
      ),
    );
  }
}

function renderKeywords() {
  $('kwList').replaceChildren(
    ...S.customKeywords.map((k, i) => {
      const sel = h('select', { class: 'input', 'aria-label': `Strength for ${k.term}` },
        ...(['strong', 'medium', 'weak'] as Strength[]).map((s) => h('option', { value: s }, s[0].toUpperCase() + s.slice(1))));
      sel.value = k.strength;
      sel.addEventListener('change', () => {
        const next = [...S.customKeywords];
        next[i] = { ...k, strength: sel.value as Strength };
        save({ customKeywords: next });
      });
      return h('div', { class: 'trow' }, h('span', {}, k.term), sel,
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${k.term}`, onclick: () => save({ customKeywords: S.customKeywords.filter((_, j) => j !== i) }) }, '×'));
    }),
  );
}

function renderProfiles() {
  const lines = (a: string[]) => a.join('\n');
  const parse = (v: string) => v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  $('profileList').replaceChildren(
    ...S.profiles.map((p, i) => {
      const upd = (patch: Partial<GameProfile>) => {
        const next = [...S.profiles];
        next[i] = { ...p, ...patch };
        save({ profiles: next });
      };
      const name = h('input', { class: 'input', value: p.name, 'aria-label': 'Profile name', maxlength: '60' });
      name.addEventListener('change', () => upd({ name: name.value }));
      const area = (label: string, key: 'titles' | 'terms' | 'contextTerms', hint: string) => {
        const t = h('textarea', { class: 'input', placeholder: hint, 'aria-label': `${p.name} ${label}` });
        t.value = lines(p[key]);
        t.addEventListener('change', () => upd({ [key]: parse(t.value) }));
        return h('label', {}, label, t);
      };
      return h('div', { class: 'profile' },
        h('div', { class: 'profile-head' }, name, switchEl(p.enabled, `Enable ${p.name}`, (v) => upd({ enabled: v })),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${p.name}`, onclick: () => save({ profiles: S.profiles.filter((_, j) => j !== i) }, 'Profile deleted') }, '×')),
        h('div', { class: 'profile-fields' },
          area('Titles (always block)', 'titles', 'Game title\nAbbreviation'),
          area('Names & places (medium)', 'terms', 'Character name\nLocation'),
          area('Context words (weak)', 'contextTerms', 'Common first name')));
    }),
  );
}

function renderLangs() {
  $('langs').replaceChildren(
    ...DICTIONARY.languages.map((l) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = S.languages.includes(l.code);
      cb.addEventListener('change', () => {
        const next = cb.checked ? [...new Set([...S.languages, l.code])] : S.languages.filter((x) => x !== l.code);
        if (!next.length) {
          cb.checked = true;
          toast('Keep at least one language');
          return;
        }
        save({ languages: next });
      });
      return h('label', { class: 'lang' }, cb, l.label);
    }),
  );
}

async function renderRefs() {
  const refs = sanitizeRefs((await chrome.storage.local.get(IMAGE_REFS_KEY))[IMAGE_REFS_KEY]);
  $('refCount').textContent = refs.length ? `${refs.length} reference image${refs.length > 1 ? 's' : ''}` : 'No reference images yet – matching stays inactive.';
  $('refList').replaceChildren(
    ...refs.map((r) =>
      h('span', { class: 'chip' }, r.name, h('button', { type: 'button', 'aria-label': `Remove ${r.name}`, onclick: async () => {
        await chrome.storage.local.set({ [IMAGE_REFS_KEY]: refs.filter((x) => x.id !== r.id) });
        renderRefs();
      } }, '×')),
    ),
  );
  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('imgStatus').textContent = S.imageDetection
    ? granted
      ? refs.length ? 'Active.' : 'Enabled, waiting for reference images.'
      : 'Permission missing – toggle off and on again to grant it.'
    : '';
}

function runTest() {
  const text = ($('testInput') as HTMLTextAreaElement).value;
  const out = $('testOut');
  if (!text.trim()) {
    out.replaceChildren(h('span', { class: 'muted' }, 'Results appear here.'));
    return;
  }
  const t0 = performance.now();
  const d = createDetector(S).evaluate(text);
  const ms = performance.now() - t0;
  out.replaceChildren(
    h('span', { class: `verdict ${d.blocked ? 'block' : 'allow'}` }, d.blocked ? (d.spoiler ? 'Hidden – story spoiler' : 'Hidden') : 'Visible'),
    h('span', {}, `Score ${d.score} / threshold ${d.threshold}`),
    h('span', { class: 'muted' }, d.categories.length ? `Signals: ${d.categories.join(', ')}` : 'No signals'),
    h('span', { class: 'faint' }, `${ms.toFixed(2)} ms incl. setup`),
  );
}

async function renderStatsInfo() {
  const s = await loadStats();
  $('statsInfo').textContent = `${s.total.toLocaleString()} items hidden in total, ${(s.days[todayKey()] ?? 0).toLocaleString()} today. Only daily counts are stored.`;
}

function renderAll() {
  renderBindings();
  renderSites();
  renderKeywords();
  renderProfiles();
  renderLangs();
  runTest();
}

async function addRefFiles(files: FileList) {
  const refs = sanitizeRefs((await chrome.storage.local.get(IMAGE_REFS_KEY))[IMAGE_REFS_KEY]);
  let added = 0;
  for (const f of Array.from(files).slice(0, 50)) {
    try {
      const bmp = await createImageBitmap(f, { resizeWidth: HASH_W, resizeHeight: HASH_H, resizeQuality: 'medium' });
      const c = new OffscreenCanvas(HASH_W, HASH_H);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0, HASH_W, HASH_H);
      const hash = dhashFromRgba(ctx.getImageData(0, 0, HASH_W, HASH_H).data);
      if (!refs.some((r) => r.hash === hash)) {
        refs.push({ id: `${Date.now().toString(36)}${added}`, name: f.name.slice(0, 80), hash } satisfies ImageRef);
        added++;
      }
    } catch {
      /* unreadable image */
    }
  }
  await chrome.storage.local.set({ [IMAGE_REFS_KEY]: refs.slice(0, 300) });
  toast(`${added} reference image${added === 1 ? '' : 's'} added (only fingerprints are stored)`);
  renderRefs();
}

async function init() {
  S = await loadSettings();
  $('version').textContent = `v${chrome.runtime.getManifest().version} · dictionary ${DICTIONARY.version.split('@')[1] ?? ''}`;
  const st = DICTIONARY.stats ?? {};
  $('dictInfo').textContent = `${DICTIONARY.terms.length} generated terms (${st.high ?? 0} high-confidence, ${st.medium ?? 0} medium, ${st.contextOnly ?? 0} context-only, ${st.legacyMask ?? 0} older-GTA exclusions).`;
  renderAll();
  renderRefs();
  renderStatsInfo();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      S = sanitizeSettings(changes[SETTINGS_KEY].newValue);
      renderAll();
    }
  });

  for (const el of document.querySelectorAll<HTMLInputElement>('[data-bind]')) {
    el.addEventListener('change', () => save({ [el.dataset.bind as string]: el.checked } as Partial<Settings>));
  }
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    r.addEventListener('change', () => save({ mode: r.value as Mode }));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-sens]')) {
    b.addEventListener('click', () => save({ sensitivity: b.dataset.sens as Sensitivity }));
  }
  for (const f of document.querySelectorAll<HTMLFormElement>('.inline-add')) {
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = f.querySelector('input')!;
      const host = normalizeHost(input.value);
      const key = f.dataset.list as 'allowlist' | 'blocklist';
      if (!host) return toast('Enter a domain like example.com');
      input.value = '';
      if (!S[key].includes(host)) save({ [key]: [...S[key], host] });
    });
  }
  $('kwForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('kwInput') as HTMLInputElement;
    const term = input.value.trim();
    if (term.length < 2) return toast('Enter at least 2 characters');
    if (S.customKeywords.some((k) => k.term.toLowerCase() === term.toLowerCase())) return toast('Already added');
    input.value = '';
    save({ customKeywords: [...S.customKeywords, { term, strength: ($('kwStrength') as HTMLSelectElement).value as Strength }] });
  });
  $('kwBulkAdd').addEventListener('click', () => {
    const ta = $('kwBulk') as HTMLTextAreaElement;
    const existing = new Set(S.customKeywords.map((k) => k.term.toLowerCase()));
    const add = [...new Set(ta.value.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length >= 2 && !existing.has(s.toLowerCase())))];
    ta.value = '';
    save({ customKeywords: [...S.customKeywords, ...add.map((term) => ({ term, strength: 'medium' as Strength }))] }, `${add.length} keywords imported`);
  });
  $('addProfile').addEventListener('click', () =>
    save({ profiles: [...S.profiles, { id: `p${Date.now().toString(36)}`, name: 'New game', enabled: true, titles: [], terms: [], contextTerms: [] }] }, 'Profile added'),
  );
  ($('testInput') as HTMLTextAreaElement).addEventListener('input', runTest);

  $('imageDetection').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    if (input.checked) {
      const ok = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
      if (!ok) {
        input.checked = false;
        return toast('Permission not granted – image matching stays off');
      }
    }
    await save({ imageDetection: input.checked });
    renderRefs();
  });
  ($('refFiles') as HTMLInputElement).addEventListener('change', (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files?.length) addRefFiles(files);
    (e.target as HTMLInputElement).value = '';
  });

  $('export').addEventListener('click', async () => {
    const refs = (await chrome.storage.local.get(IMAGE_REFS_KEY))[IMAGE_REFS_KEY] ?? [];
    const blob = new Blob([JSON.stringify({ app: 'SpoilerShield', exported: new Date().toISOString(), settings: S, imageRefs: refs }, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `spoilershield-settings-${todayKey()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  ($('importFile') as HTMLInputElement).addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      if (f.size > 2_000_000) throw new Error('too large');
      const data = JSON.parse(await f.text());
      const next = sanitizeSettings(data?.settings ?? data);
      await chrome.storage.local.set({ [SETTINGS_KEY]: next, ...(data?.imageRefs ? { [IMAGE_REFS_KEY]: sanitizeRefs(data.imageRefs) } : {}) });
      S = next;
      renderAll();
      renderRefs();
      toast('Settings imported');
    } catch {
      toast('That file is not a valid SpoilerShield backup');
    }
  });
  $('resetStats').addEventListener('click', async () => {
    if (!confirm('Reset all statistics to zero?')) return;
    await chrome.runtime.sendMessage({ type: 'ss:resetStats' });
    renderStatsInfo();
    toast('Statistics reset');
  });
  $('resetSettings').addEventListener('click', async () => {
    if (!confirm('Restore default settings? Custom keywords, profiles and site lists will be removed.')) return;
    await chrome.storage.local.set({ [SETTINGS_KEY]: sanitizeSettings(DEFAULT_SETTINGS) });
    S = await loadSettings();
    renderAll();
    toast('Defaults restored');
  });

  // highlight current section in the sidebar
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.side nav a')];
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) links.forEach((l) => l.classList.toggle('active', l.hash === `#${en.target.id}`));
      }
    },
    { rootMargin: '-30% 0px -60% 0px' },
  );
  document.querySelectorAll('.panel').forEach((p) => io.observe(p));
}

init();

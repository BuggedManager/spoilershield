import type { PageStatus } from '../shared/messages';
import {
  hostInList,
  loadSettings,
  loadStats,
  normalizeHost,
  saveSettings,
  SETTINGS_KEY,
  STATS_KEY,
  sanitizeSettings,
  sanitizeStats,
  todayKey,
  type Mode,
  type Settings,
  type Stats,
} from '../storage/settings';
import type { Strength } from '../detection/vocabulary';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nf = new Intl.NumberFormat();

const MODE_DESC: Record<Mode, string> = {
  standard: 'Obvious GTA 6 references and high-confidence spoilers.',
  strict: 'All GTA 6 content. Recommended for zero exposure.',
  maximum: 'Hides uncertain items until checked. May hide safe content.',
};
const REASON: Record<PageStatus['reason'], string> = {
  active: 'Protected',
  blocklisted: 'Maximum (blocklist)',
  allowlisted: 'Paused here',
  'site-off': 'Off for this site',
  disabled: 'Protection off',
  loading: 'Starting…',
};

let settings: Settings;
let status: PageStatus | null = null;
let tabId: number | undefined;

async function getStatus(): Promise<PageStatus | null> {
  if (tabId === undefined) return null;
  try {
    return ((await chrome.tabs.sendMessage(tabId, { type: 'ss:status' })) as PageStatus) ?? null;
  } catch {
    return null;
  }
}

function render() {
  const app = $('app');
  const paused = !!status && !status.active && status.reason !== 'disabled';
  const state = !settings.enabled ? 'off' : paused ? 'paused' : 'active';
  app.dataset.state = state;
  ($('enabled') as HTMLInputElement).checked = settings.enabled;
  $('statusText').textContent = state === 'off' ? 'OFF' : paused ? 'PAUSED HERE' : 'ACTIVE';
  const langs = settings.languages.map((l) => (l === 'en' ? 'English' : l === 'fr' ? 'French' : l.toUpperCase())).join(' + ');
  const modeName = settings.mode[0].toUpperCase() + settings.mode.slice(1);
  $('statusSub').textContent = state === 'off' ? 'Nothing is being hidden' : `${modeName} mode · ${langs}`;

  for (const b of document.querySelectorAll<HTMLButtonElement>('.seg button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode));
  }
  $('modeDesc').textContent = MODE_DESC[settings.mode];
  for (const id of ['blockGameContent', 'blockStorySpoilers', 'blockImages'] as const) {
    ($(id) as HTMLInputElement).checked = settings[id];
  }
  const n = settings.customKeywords.length;
  $('kwCount').textContent = n ? `${n} custom keyword${n > 1 ? 's' : ''}` : '';

  // current site
  const badge = $('siteBadge');
  const pause = $('pauseSite') as HTMLButtonElement;
  const reveal = $('revealAll') as HTMLButtonElement;
  if (!status) {
    $('siteTitle').textContent = 'This page';
    badge.textContent = 'Not available';
    badge.className = 'badge off';
    $('pageBlocked').textContent = '0';
    pause.disabled = reveal.disabled = true;
    pause.title = 'Chrome pages, the Web Store and pages opened before install cannot be scanned. Reload the tab.';
    return;
  }
  $('siteTitle').textContent = `${status.host || 'local file'} · ${status.site}`;
  badge.textContent = REASON[status.reason];
  badge.className = 'badge' + (status.active ? '' : status.reason === 'disabled' ? ' off' : ' warn');
  $('pageBlocked').textContent = nf.format(status.blocked + status.revealed + (status.titleHidden ? 1 : 0));
  const isAllow = hostInList(status.host, settings.allowlist);
  pause.disabled = !settings.enabled || !status.host;
  pause.textContent = isAllow ? 'Resume here' : 'Pause on this site';
  reveal.disabled = !status.active || status.blocked + status.revealed === 0;
  reveal.textContent = status.revealed > 0 && status.blocked === 0 ? 'Hide all' : 'Reveal all';
}

function renderStats(s: Stats) {
  $('totalBlocked').textContent = nf.format(s.total);
  $('todayBlocked').textContent = nf.format(s.days[todayKey()] ?? 0);
}

async function update(patch: Partial<Settings>) {
  settings = await saveSettings(patch);
  render();
  setTimeout(async () => {
    status = await getStatus();
    render();
  }, 120);
}

async function init() {
  settings = await loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  status = await getStatus();
  render();
  renderStats(await loadStats());
  $('app').setAttribute('aria-busy', 'false');

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes[SETTINGS_KEY]) {
      settings = sanitizeSettings(changes[SETTINGS_KEY].newValue);
      render();
    }
    if (changes[STATS_KEY]) {
      renderStats(sanitizeStats(changes[STATS_KEY].newValue));
      status = await getStatus();
      render();
    }
  });

  ($('enabled') as HTMLInputElement).addEventListener('change', (e) => update({ enabled: (e.target as HTMLInputElement).checked }));
  for (const b of document.querySelectorAll<HTMLButtonElement>('.seg button')) {
    b.addEventListener('click', () => update({ mode: b.dataset.mode as Mode }));
  }
  for (const id of ['blockGameContent', 'blockStorySpoilers', 'blockImages'] as const) {
    $(id).addEventListener('change', (e) => update({ [id]: (e.target as HTMLInputElement).checked }));
  }

  $('pauseSite').addEventListener('click', () => {
    if (!status?.host) return;
    const host = normalizeHost(status.host);
    if (hostInList(host, settings.allowlist)) {
      update({ allowlist: settings.allowlist.filter((e) => !(host === e || host.endsWith('.' + e))) });
    } else update({ allowlist: [...settings.allowlist, host] });
  });

  $('revealAll').addEventListener('click', async () => {
    if (tabId === undefined || !status) return;
    const hide = status.revealed > 0 && status.blocked === 0;
    await chrome.tabs.sendMessage(tabId, { type: hide ? 'ss:hideAll' : 'ss:revealAll' }).catch(() => {});
    status = await getStatus();
    render();
  });

  $('kwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('kwInput') as HTMLInputElement;
    const term = input.value.trim();
    const msg = $('kwMsg');
    if (term.length < 2) {
      msg.textContent = 'Enter at least 2 characters.';
      msg.className = 'kw-msg small err';
      return;
    }
    if (settings.customKeywords.some((k) => k.term.toLowerCase() === term.toLowerCase())) {
      msg.textContent = 'Already in your list.';
      msg.className = 'kw-msg small err';
      return;
    }
    const strength = ($('kwStrength') as HTMLSelectElement).value as Strength;
    await update({ customKeywords: [...settings.customKeywords, { term, strength }] });
    input.value = '';
    msg.textContent = 'Keyword added – active on all open tabs.';
    msg.className = 'kw-msg small ok';
  });

  $('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

init();

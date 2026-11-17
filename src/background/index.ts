/**
 * Service worker: statistics + toolbar badge. Stores only counts per local
 * date – never URLs, hostnames, titles or page text.
 */
import type { Message } from '../shared/messages';
import { addToStats, loadStats, sanitizeSettings, SETTINGS_KEY, STATS_KEY, type Stats } from '../storage/settings';
import { imageHashFromUrl } from '../ai/hash-worker';

chrome.runtime.onInstalled.addListener(async () => {
  const r = await chrome.storage.local.get([SETTINGS_KEY, STATS_KEY]);
  await chrome.storage.local.set({
    [SETTINGS_KEY]: sanitizeSettings(r[SETTINGS_KEY]),
    ...(r[STATS_KEY] ? {} : { [STATS_KEY]: { total: 0, days: {} } satisfies Stats }),
  });
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' }).catch(() => {});
});

// Serialize stat writes so concurrent tabs never lose increments.
let chain: Promise<unknown> = Promise.resolve();
function addBlocked(n: number) {
  chain = chain
    .then(async () => {
      const s = await loadStats();
      await chrome.storage.local.set({ [STATS_KEY]: addToStats(s, n) });
    })
    .catch(() => {});
  return chain;
}

/** tabId → frameId → { pageId, total } (memory only) */
const tabCounts = new Map<number, Map<number, { pageId: string; total: number }>>();

function updateBadge(tabId: number) {
  const frames = tabCounts.get(tabId);
  let sum = 0;
  frames?.forEach((f) => (sum += f.total));
  const text = sum > 999 ? '999+' : sum > 0 ? String(sum) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg: Message & { url?: string }, sender, sendResponse) => {
  if (msg?.type === 'ss:blocked') {
    if (typeof msg.count === 'number' && msg.count > 0 && msg.count < 10000) addBlocked(msg.count);
    const tabId = sender.tab?.id;
    if (tabId !== undefined && tabId >= 0) {
      const frameId = sender.frameId ?? 0;
      let frames = tabCounts.get(tabId);
      if (!frames) tabCounts.set(tabId, (frames = new Map()));
      if (frameId === 0 && frames.get(0)?.pageId !== msg.pageId) frames.clear();
      frames.set(frameId, { pageId: msg.pageId, total: msg.pageTotal });
      updateBadge(tabId);
    }
    return false;
  }
  if (msg?.type === 'ss:resetStats') {
    chain = chain.then(() => chrome.storage.local.set({ [STATS_KEY]: { total: 0, days: {} } }));
    chain.then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  if ((msg as { type?: string })?.type === 'ss:imageHash' && typeof msg.url === 'string') {
    imageHashFromUrl(msg.url).then(
      (h) => sendResponse({ hash: h }),
      () => sendResponse({ hash: null }),
    );
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => tabCounts.delete(tabId));

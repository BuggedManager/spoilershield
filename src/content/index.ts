/**
 * Content script entry – runs at document_start in every frame.
 * Everything happens locally: no network requests, page text never leaves the tab.
 */
import { adapterFor } from '../adapters';
import { createDetector } from '../detection';
import type { Message, PageStatus } from '../shared/messages';
import { DEFAULT_SETTINGS, decideForSite, loadSettings, onSettingsChanged, type Settings, type SiteDecision } from '../storage/settings';
import { Scanner } from './scanner';
import { ImageGuard } from '../ai/image-guard';

const host = location.hostname;
const adapter = adapterFor(host);
const pageId = Math.random().toString(36).slice(2);
const isTop = window === window.top;

let pendingReport = 0;
let reportTimer: ReturnType<typeof setTimeout> | null = null;
function reportBlocked(n: number) {
  pendingReport += n;
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = null;
    const count = pendingReport;
    pendingReport = 0;
    const msg: Message = { type: 'ss:blocked', count, pageTotal: scanner.pageCount + (images?.pageCount ?? 0), pageId };
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      /* extension reloaded – ignore */
    }
  }, 700);
}

const getShadowRoot = (el: Element): ShadowRoot | null => {
  try {
    const fn = chrome.dom?.openOrClosedShadowRoot;
    if (fn) return (fn(el as HTMLElement) as ShadowRoot | null) ?? null;
  } catch {
    /* not a shadow host */
  }
  return (el as HTMLElement).shadowRoot ?? null;
};

const scanner = new Scanner({ doc: document, adapter, onBlocked: reportBlocked, getShadowRoot });
let images: ImageGuard | null = null;

// Preventive phase: start immediately with no detector. Cards stay hidden by CSS
// and inserted content is marked pending until settings arrive (a few ms).
scanner.setConfig({ detector: null, mode: DEFAULT_SETTINGS.mode, blockImages: true, protectTitle: true });
scanner.start();

let decision: SiteDecision | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let applied = false;

function apply(s: Settings) {
  applied = true;
  settings = s;
  decision = decideForSite(s, host, adapter.id);
  if (!decision.active) {
    scanner.stop();
    images?.stop();
    return;
  }
  const detector = createDetector(s, decision.mode);
  scanner.setConfig({ detector, mode: decision.mode, blockImages: s.blockImages, protectTitle: s.protectTabTitle && isTop });
  scanner.start();
  if (s.imageDetection && s.blockImages) {
    images ??= new ImageGuard(document, () => reportBlocked(1));
    images.start(decision.mode === 'maximum');
  } else images?.stop();
}

loadSettings()
  .then(apply)
  .catch(() => apply(DEFAULT_SETTINGS));
// Failsafe: never leave content hidden if storage is unavailable.
setTimeout(() => {
  if (!applied) apply(DEFAULT_SETTINGS);
}, 2500);
onSettingsChanged(apply);

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'ss:status': {
      if (!isTop) return false;
      const st = scanner.status();
      const res: PageStatus = {
        host,
        site: adapter.name,
        active: !!decision?.active,
        reason: decision?.reason ?? 'loading',
        mode: decision?.mode ?? settings.mode,
        blocked: st.blocked,
        revealed: st.revealed,
        pageCount: st.pageCount + (images?.pageCount ?? 0),
        titleHidden: st.titleHidden,
      };
      sendResponse(res);
      return false;
    }
    case 'ss:revealAll':
      scanner.revealAll();
      images?.revealAll();
      if (isTop) sendResponse(true);
      return false;
    case 'ss:hideAll':
      scanner.hideAll();
      if (isTop) sendResponse(true);
      return false;
  }
  return false;
});

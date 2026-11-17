/**
 * Real-browser integration tests: loads dist/ as an unpacked extension in
 * Playwright's Chromium and serves local HTML fixtures on the REAL hostnames
 * (www.youtube.com, www.google.com, www.reddit.com, news.example.com) via
 * request interception – no network traffic, the actual site adapters run.
 *
 *   npm run build && npm run test:browser
 */
import { chromium } from 'playwright-core';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'tests/results');
mkdirSync(out, { recursive: true });
const fixture = (n) => readFileSync(join(root, 'tests/fixtures', n), 'utf8');

const results = [];
let failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, info });
    console.log(`  ✓ ${name}${info ? `  (${typeof info === 'string' ? info : JSON.stringify(info)})` : ''}`);
  } catch (e) {
    failed++;
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) });
    console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`);
  }
}
function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const userDataDir = mkdtempSync(join(tmpdir(), 'ss-test-'));
// Prefer the installed (signed) Google Chrome and load the extension through the
// DevTools protocol (Chrome 137+ removed --load-extension). Fall back to
// Playwright's Chromium with --load-extension.
const useChrome = !process.argv.includes('--chromium');
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: useChrome ? 'chrome' : 'chromium',
  headless: !process.argv.includes('--headed'),
  viewport: { width: 1280, height: 900 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: useChrome ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
if (useChrome) {
  const bs = await ctx.browser().newBrowserCDPSession();
  const { id } = await bs.send('Extensions.loadUnpacked', { path: dist });
  console.log(`Chrome ${ctx.browser().version()} – loaded unpacked extension ${id}`);
}

const routes = {
  'https://www.youtube.com/': fixture('youtube.html'),
  'https://www.google.com/search?q=best+games+2026': fixture('google.html'),
  'https://www.reddit.com/r/all/': fixture('reddit.html'),
  'https://news.example.com/': fixture('generic.html'),
};
await ctx.route('**/*', (route) => {
  const url = route.request().url();
  if (routes[url]) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: routes[url] });
  if (url.startsWith('chrome-extension://')) return route.continue();
  return route.fulfill({ status: 204, body: '' }); // never touch the real network
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
const extId = sw.url().split('/')[2];
const storage = (fn, arg) => sw.evaluate(fn, arg);
console.log(`SpoilerShield loaded as ${extId}\n`);

const state = (page, sel) => page.$eval(sel, (el) => el.getAttribute('data-ss-state')).catch(() => 'missing');
const hasOverlay = (page, sel) =>
  page.$eval(sel, (el) => !!(el.querySelector(':scope > [data-ss-overlay]') || el.shadowRoot?.querySelector('[data-ss-overlay]')));

console.log('Extension');
await test('service worker starts and default settings are stored', async () => {
  await new Promise((r) => setTimeout(r, 300));
  const s = await storage(() => chrome.storage.local.get('settings'));
  eq(s.settings?.enabled, true, 'enabled');
  eq(s.settings?.mode, 'strict', 'mode');
});

console.log('\nYouTube (www.youtube.com)');
const yt = await ctx.newPage();
await yt.goto('https://www.youtube.com/');
await yt.waitForTimeout(150);
await test('server-rendered GTA 6 card is blocked as a whole, unrelated card visible', async () => {
  eq(await state(yt, '#ssr-bad'), 'blocked', '#ssr-bad');
  eq(await hasOverlay(yt, '#ssr-bad'), true, 'overlay');
  eq(await state(yt, '#ssr-good'), 'safe', '#ssr-good');
  const thumbVis = await yt.$eval('#ssr-bad .thumb', (el) => getComputedStyle(el).visibility);
  eq(thumbVis, 'hidden', 'thumbnail visibility');
});
await test('French spoiler title and obfuscated title are blocked', async () => {
  eq(await state(yt, '#ssr-fr'), 'blocked', 'french');
  eq(await state(yt, '#ssr-obf'), 'blocked', 'obfuscated');
});
await test('autocomplete suggestion hidden, unrelated suggestion visible', async () => {
  const s = await yt.$$eval('[role="option"]', (els) => els.map((e) => e.getAttribute('data-ss-state')));
  eq(s, ['blocked', 'safe'], 'options');
});
await test('dynamically inserted card is hidden before the first frame (no flash)', async () => {
  const r = await yt.evaluate(async () => {
    const c = window.makeCard('Lucia Caminos betrayal – final mission explained', 'Leaks');
    document.getElementById('contents').append(c);
    const sync = { state: c.getAttribute('data-ss-state'), vis: getComputedStyle(c.querySelector('.title')).visibility };
    await new Promise((r) => requestAnimationFrame(r));
    return { sync, frame: { state: c.getAttribute('data-ss-state'), vis: getComputedStyle(c.querySelector('.title')).visibility } };
  });
  // synchronously after insertion the card is already hidden by the preventive CSS
  eq(r.sync.vis, 'hidden', 'visibility immediately after insertion');
  eq(r.frame.state, 'blocked', 'state at first animation frame');
  eq(r.frame.vis, 'hidden', 'visibility at first animation frame');
  return r;
});
await test('tab title is hidden on spoiler pages', async () => {
  await yt.evaluate(() => (document.title = 'GTA 6 Ending Explained - YouTube'));
  await yt.waitForTimeout(50);
  eq(await yt.title(), '\u{1F6E1} Title hidden by SpoilerShield', 'title');
});
await test('Reveal and Hide again work with the keyboard', async () => {
  // Tab through the page until focus lands on an overlay button (closed shadow DOM → activeElement is the host)
  let host = null;
  for (let i = 0; i < 40 && !host; i++) {
    await yt.keyboard.press('Tab');
    host = await yt.evaluate(() => {
      const a = document.activeElement;
      if (!a?.hasAttribute?.('data-ss-overlay')) return null;
      a.parentElement.setAttribute('data-t', 'focused');
      return a.parentElement.tagName.toLowerCase();
    });
  }
  if (!host) throw new Error('overlay button not reachable with Tab');
  const sel = '[data-t="focused"]';
  await yt.keyboard.press('Enter');
  eq(await state(yt, sel), 'revealed', 'after Reveal');
  const vis = await yt.$eval(sel, (el) => getComputedStyle(el).visibility);
  eq(vis, 'visible', 'content visible after reveal');
  await yt.keyboard.press('Enter'); // focus moved to "Hide again"
  eq(await state(yt, sel), 'blocked', 'after Hide again');
  await yt.$eval(sel, (el) => el.removeAttribute('data-t'));
  return `first focusable overlay: <${host}>`;
});
await test('clicking the overlay never activates the link underneath', async () => {
  const before = yt.url();
  const box = await yt.$eval('#ssr-bad', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + 12, y: r.top + 12 };
  });
  await yt.mouse.click(box.x, box.y);
  await yt.waitForTimeout(100);
  eq(yt.url(), before, 'url');
});
await yt.screenshot({ path: join(out, 'youtube.png') });

await test('performance: 2000 cards via simulated infinite scroll', async () => {
  const r = await yt.evaluate(async () => {
    const grid = document.getElementById('contents');
    const frameTimes = [];
    let bad = [];
    const t0 = performance.now();
    for (let b = 0; b < 40; b++) {
      const f0 = performance.now();
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 50; i++) {
        const n = b * 50 + i;
        const isBad = n % 10 === 0;
        const c = window.makeCard(isBad ? `GTA 6 leaked gameplay part ${n}` : `Speedrun world record attempt ${n}`, `Channel ${n}`);
        if (isBad) bad.push(c);
        frag.append(c);
      }
      grid.append(frag);
      await Promise.resolve(); // MutationObserver delivery
      frameTimes.push(performance.now() - f0);
      await new Promise((r) => requestAnimationFrame(r));
      const leaked = bad.filter((c) => !['blocked', 'pending'].includes(c.getAttribute('data-ss-state')));
      if (leaked.length) return { error: `${leaked.length} GTA cards visible at a frame` };
    }
    await new Promise((r) => setTimeout(r, 300));
    const total = performance.now() - t0;
    frameTimes.sort((a, b) => a - b);
    return {
      cards: 2000,
      blocked: bad.filter((c) => c.getAttribute('data-ss-state') === 'blocked').length,
      expected: bad.length,
      safe: grid.querySelectorAll('[data-ss-state="safe"]').length,
      medianBatchMs: +frameTimes[20].toFixed(2),
      p95BatchMs: +frameTimes[38].toFixed(2),
      perCardUs: +((frameTimes.reduce((a, b) => a + b, 0) / 2000) * 1000).toFixed(1),
      totalMs: Math.round(total),
    };
  });
  if (r.error) throw new Error(r.error);
  eq(r.blocked, r.expected, 'all GTA cards blocked');
  return r;
});

await test('baseline: same insertion with protection disabled', async () => {
  await storage(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enabled: false } });
  });
  await yt.waitForTimeout(200);
  const r = await yt.evaluate(async () => {
    const grid = document.getElementById('contents');
    const times = [];
    for (let b = 0; b < 40; b++) {
      const f0 = performance.now();
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 50; i++) frag.append(window.makeCard(`Speedrun ${b}-${i}`, 'x'));
      grid.append(frag);
      await Promise.resolve();
      times.push(performance.now() - f0);
      await new Promise((r) => requestAnimationFrame(r));
    }
    times.sort((a, b) => a - b);
    return { medianBatchMs: +times[20].toFixed(2), overlaysLeft: document.querySelectorAll('[data-ss-overlay]').length };
  });
  eq(r.overlaysLeft, 0, 'overlays removed when disabled');
  await storage(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enabled: true } });
  });
  await yt.waitForTimeout(200);
  eq(await state(yt, '#ssr-bad'), 'blocked', 're-enabled without reload');
  return r;
});

console.log('\nGoogle Search (www.google.com)');
const g = await ctx.newPage();
await g.goto('https://www.google.com/search?q=best+games+2026');
await g.waitForTimeout(150);
await test('results, snippets, related searches and autocomplete', async () => {
  eq(await state(g, '#r1 .g'), 'blocked', 'official GTA VI result');
  eq(await state(g, '#r2 .g'), 'safe', 'unrelated result');
  eq(await state(g, '#r3 .g'), 'blocked', 'snippet with character + final mission');
  eq(await state(g, '#rel1'), 'blocked', 'related search');
  eq(await state(g, '#rel2'), 'safe', 'unrelated related search');
  const opts = await g.$$eval('[role="option"]', (els) => els.map((e) => e.getAttribute('data-ss-state')));
  eq(opts, ['blocked', 'safe'], 'autocomplete');
});
await g.screenshot({ path: join(out, 'google.png') });

console.log('\nReddit (www.reddit.com)');
const rd = await ctx.newPage();
await rd.goto('https://www.reddit.com/r/all/');
await rd.waitForTimeout(150);
await test('shadow-DOM posts: overlay rendered inside the shadow root', async () => {
  eq(await state(rd, '#post-bad'), 'blocked', 'post with characters');
  eq(await rd.$eval('#post-bad', (el) => !!el.shadowRoot.querySelector('[data-ss-overlay]')), true, 'overlay in shadow root');
  eq(await state(rd, '#post-sub'), 'blocked', 'post in r/GTA6');
  eq(await state(rd, '#post-good'), 'safe', 'unrelated post');
});
await test('only the spoiler comment is hidden, not its parent thread', async () => {
  eq(await state(rd, '#c1 > [slot="comment"]'), 'safe', 'parent comment');
  eq(await state(rd, '#c2 > [slot="comment"]'), 'blocked', 'hashtag spoiler reply');
});
await rd.screenshot({ path: join(out, 'reddit.png') });

console.log('\nGeneric website (news.example.com)');
const gn = await ctx.newPage();
await gn.goto('https://news.example.com/');
await gn.waitForTimeout(150);
await test('story cards with thumbnails, contextual first names, paragraphs, editor', async () => {
  eq(await state(gn, '#story-gta'), 'blocked', 'GTA VI story');
  eq(await state(gn, '#story-ok'), null, 'Zelda story');
  eq(await state(gn, '#story-char'), 'blocked', 'Jason Duval story');
  eq(await state(gn, '#story-name'), null, 'Jason keyboard story');
  eq(await state(gn, '#p1'), null, 'p1');
  eq(await state(gn, '#p2'), 'blocked', "p2 (Leonida / Rockstar's next game)");
  eq(await state(gn, '#p3'), null, 'p3');
  eq(await state(gn, '#editor'), null, 'contenteditable');
});
await gn.screenshot({ path: join(out, 'generic.png') });

console.log('\nSettings, popup and statistics');
await test('pause on a site via allowlist applies live; resume restores protection', async () => {
  await storage(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, allowlist: ['example.com'] } });
  });
  await gn.waitForTimeout(150);
  eq(await state(gn, '#story-gta'), null, 'paused');
  await storage(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, allowlist: [] } });
  });
  await gn.waitForTimeout(150);
  eq(await state(gn, '#story-gta'), 'blocked', 'resumed');
});
await test('mode switching: Standard shows a location-only mention, Strict hides it', async () => {
  const add = () => gn.evaluate(() => {
    let li = document.getElementById('story-loc');
    if (!li) {
      li = document.createElement('li');
      li.id = 'story-loc';
      li.innerHTML = '<a href="/travel"><h3>Sunset photos from Leonida</h3></a>';
      document.querySelector('ul.stories').append(li);
    }
  });
  await add();
  await gn.waitForTimeout(50);
  eq(await state(gn, '#story-loc'), 'blocked', 'strict');
  await storage(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, mode: 'standard' } });
  });
  await gn.waitForTimeout(150);
  eq(await state(gn, '#story-loc'), null, 'standard');
  await storage(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, mode: 'strict' } });
  });
  await gn.waitForTimeout(150);
  eq(await state(gn, '#story-loc'), 'blocked', 'strict again');
});
await test('custom keyword added at runtime blocks new content', async () => {
  await storage(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, customKeywords: [{ term: 'Project Americas', strength: 'strong' }] } });
  });
  await gn.waitForTimeout(150);
  await gn.evaluate(() => {
    const li = document.createElement('li');
    li.id = 'story-custom';
    li.innerHTML = '<h3>Remember the ProjectAmericas rumours?</h3>';
    document.querySelector('ul.stories').append(li);
  });
  await gn.waitForTimeout(50);
  eq(await state(gn, '#story-custom'), 'blocked', 'custom keyword (hashtag-style spelling)');
});
await test('statistics count real blocked items and the badge shows the page count', async () => {
  await gn.waitForTimeout(900); // stats are batched
  const { stats } = await storage(() => chrome.storage.local.get('stats'));
  if (!(stats?.total > 0)) throw new Error('no stats recorded');
  // the extension has no "tabs" permission, so it cannot see URLs - check every tab's badge
  const badges = await storage(async () => {
    const tabs = await chrome.tabs.query({});
    return Promise.all(tabs.map((t) => chrome.action.getBadgeText({ tabId: t.id })));
  });
  const numeric = badges.filter((b) => /^\d+$/.test(b));
  if (!numeric.length) throw new Error(`no numeric badge: ${JSON.stringify(badges)}`);
  return { total: stats.total, badges: numeric };
});

const popup = await ctx.newPage();
await popup.setViewportSize({ width: 360, height: 600 });
await test('popup renders status, stats, mode and toggles', async () => {
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForTimeout(250);
  eq(await popup.textContent('#statusText'), 'ACTIVE', 'status');
  const total = Number((await popup.textContent('#totalBlocked')).replace(/\D/g, ''));
  if (!(total > 0)) throw new Error('total not shown');
  eq(await popup.getAttribute('.seg button[data-mode="strict"]', 'aria-pressed'), 'true', 'strict pressed');
  const h = await popup.evaluate(() => document.documentElement.scrollHeight);
  if (h > 600) throw new Error(`popup is ${h}px tall – Chrome caps popups at 600px`);
  await popup.click('.seg button[data-mode="maximum"]');
  await popup.waitForTimeout(150);
  const { settings } = await storage(() => chrome.storage.local.get('settings'));
  eq(settings.mode, 'maximum', 'mode saved from popup');
  await popup.click('.seg button[data-mode="strict"]');
  await popup.fill('#kwInput', 'Leonida Man');
  await popup.click('#kwForm button[type="submit"]');
  await popup.waitForTimeout(150);
  const s2 = (await storage(() => chrome.storage.local.get('settings'))).settings;
  eq(s2.customKeywords.some((k) => k.term === 'Leonida Man'), true, 'keyword saved from popup');
  return { total };
});
await popup.screenshot({ path: join(out, 'popup.png') });

const opts = await ctx.newPage();
await test('settings page: test box, persistence after reload', async () => {
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.waitForTimeout(250);
  await opts.fill('#testInput', 'GTA 6 ending explained');
  eq(await opts.textContent('.verdict'), 'Hidden – story spoiler', 'verdict');
  await opts.fill('#testInput', 'Jason bought a new keyboard');
  eq(await opts.textContent('.verdict'), 'Visible', 'benign verdict');
  await opts.click('.mode input[value="standard"]', { force: true });
  await opts.waitForTimeout(150);
  await opts.reload();
  await opts.waitForTimeout(250);
  eq(await opts.isChecked('.mode input[value="standard"]'), true, 'mode persisted');
  await opts.click('.mode input[value="strict"]', { force: true });
});
await opts.setViewportSize({ width: 1280, height: 1600 });
await opts.screenshot({ path: join(out, 'options.png'), fullPage: false });

await ctx.close();
rmSync(userDataDir, { recursive: true, force: true });
writeFileSync(join(out, 'browser-results.json'), JSON.stringify({ date: new Date().toISOString(), chromium: true, results }, null, 2));
console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots + JSON in tests/results/`);
process.exit(failed ? 1 : 0);

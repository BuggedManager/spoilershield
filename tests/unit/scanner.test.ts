// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generic, google, reddit, youtube, type SiteAdapter } from '../../src/adapters';
import { REPLACED_TITLE, Scanner, STATE_ATTR } from '../../src/content/scanner';
import { createDetector } from '../../src/detection';
import { OVERLAY_ATTR } from '../../src/overlays/overlay';
import { DEFAULT_SETTINGS, type Mode } from '../../src/storage/settings';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const frames = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 20));
};

let scanner: Scanner;
let blockedEvents = 0;

function setup(adapter: SiteAdapter, mode: Mode = 'strict', extra: Partial<ConstructorParameters<typeof Scanner>[0]> = {}) {
  document.head.innerHTML = '<title>Test page</title>';
  document.body.innerHTML = '';
  blockedEvents = 0;
  scanner = new Scanner({
    doc: document,
    adapter,
    onBlocked: (n) => (blockedEvents += n),
    raf: (cb) => setTimeout(cb, 10),
    ...extra,
  });
  scanner.setConfig({ detector: createDetector({ ...DEFAULT_SETTINGS, mode }), mode, blockImages: true, protectTitle: true });
  scanner.start();
}

const state = (el: Element | null) => el?.getAttribute(STATE_ATTR) ?? null;
const hasOverlay = (el: Element) => !!el.querySelector(`[${OVERLAY_ATTR}]`) || !!el.shadowRoot?.querySelector(`[${OVERLAY_ATTR}]`);

function ytCard(title: string, channel = 'Some Channel') {
  const c = document.createElement('ytd-rich-item-renderer');
  c.innerHTML = `<div id="content"><ytd-thumbnail><a id="thumbnail" href="/watch?v=abc"><img src="https://i.ytimg.com/vi/abc/hqdefault.jpg"></a></ytd-thumbnail>
    <div id="details"><a id="video-title-link" title="${title}" aria-label="${title} by ${channel}"><yt-formatted-string id="video-title">${title}</yt-formatted-string></a>
    <ytd-channel-name>${channel}</ytd-channel-name><span>1.2M views</span></div></div>`;
  return c;
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-ss-guard');
});
afterEach(() => scanner?.stop());

describe('YouTube-style cards', () => {
  it('injects preventive CSS that hides cards until evaluated', () => {
    setup(youtube);
    const css = document.querySelector('style[data-ss-style]')?.textContent ?? '';
    expect(css).toContain('ytd-rich-item-renderer');
    expect(css).toMatch(/:not\(\[data-ss-state\]\) \{ visibility: hidden !important; \}/);
    expect(document.documentElement.getAttribute('data-ss-guard')).toBe('on');
  });

  it('blocks the whole card (title + thumbnail) and leaves unrelated cards visible', async () => {
    setup(youtube);
    const grid = document.createElement('div');
    const bad = ytCard('GTA 6 Trailer 3 breakdown – every detail');
    const good = ytCard('Easy 15 minute pasta recipe');
    grid.append(bad, good);
    document.body.append(grid);
    await tick();
    expect(state(bad)).toBe('blocked');
    expect(hasOverlay(bad)).toBe(true);
    expect(state(good)).toBe('safe');
    expect(hasOverlay(good)).toBe(false);
    expect(blockedEvents).toBe(1);
  });

  it('evaluates synchronously inside the MutationObserver callback (before paint)', async () => {
    setup(youtube);
    const card = ytCard('Grand Theft Auto VI ending explained');
    document.body.append(card);
    // microtask checkpoint == MutationObserver delivery; no timers / frames needed
    await Promise.resolve();
    expect(state(card)).toBe('blocked');
  });

  it('reveal and hide again', async () => {
    setup(youtube);
    const card = ytCard('GTA VI leaked gameplay');
    document.body.append(card);
    await tick();
    scanner.reveal(card, false);
    expect(state(card)).toBe('revealed');
    expect(hasOverlay(card)).toBe(true); // "Hide again" pill remains
    scanner.hideAgain(card, false);
    expect(state(card)).toBe('blocked');
  });

  it('a revealed card stays revealed while unchanged, but re-blocks if recycled with new content', async () => {
    setup(youtube);
    const card = ytCard('GTA 6 map leak');
    document.body.append(card);
    await tick();
    scanner.reveal(card, false);
    card.querySelector('span')!.textContent = '1.3M views';
    await tick();
    expect(state(card)).toBe('revealed');
    card.querySelector('#video-title')!.textContent = 'Lucia Caminos final mission';
    await tick();
    expect(state(card)).toBe('blocked');
  });

  it('recycled card: safe → spoiler → safe', async () => {
    setup(youtube);
    const card = ytCard('Woodworking for beginners');
    document.body.append(card);
    await tick();
    expect(state(card)).toBe('safe');
    const a = card.querySelector('#video-title-link')!;
    a.setAttribute('title', 'GTA 6 secret ending');
    card.querySelector('#video-title')!.textContent = 'GTA 6 secret ending';
    await tick();
    expect(state(card)).toBe('blocked');
    a.setAttribute('title', 'Gardening tips');
    a.setAttribute('aria-label', 'Gardening tips');
    card.querySelector('#video-title')!.textContent = 'Gardening tips';
    await tick();
    expect(state(card)).toBe('safe');
    expect(hasOverlay(card)).toBe(false);
  });

  it('skeleton cards stay hidden until their text arrives', async () => {
    setup(youtube);
    const card = document.createElement('ytd-rich-item-renderer');
    document.body.append(card);
    await tick();
    expect(state(card)).toBe('pending');
    card.innerHTML = '<a id="video-title-link">GTA 6 gameplay reveal</a>';
    await tick();
    expect(state(card)).toBe('blocked');
  });

  it('re-attaches the overlay if the site removes it', async () => {
    setup(youtube);
    const card = ytCard('GTA 6 trailer');
    document.body.append(card);
    await tick();
    card.querySelector(`[${OVERLAY_ATTR}]`)!.remove();
    await tick();
    expect(hasOverlay(card)).toBe(true);
  });

  it('protects the tab title and the video player', async () => {
    setup(youtube);
    const player = document.createElement('div');
    player.id = 'movie_player';
    document.body.append(player);
    await tick();
    document.title = 'GTA 6 Ending Explained - YouTube';
    await tick();
    expect(document.title).toBe(REPLACED_TITLE);
    expect(state(player)).toBe('blocked');
  });
});

describe('rapid scrolling / DOM churn', () => {
  it('handles 1500 inserted cards in bursts, never leaving GTA cards visible', async () => {
    setup(youtube, 'strict', { budgetMs: 4 });
    const grid = document.createElement('div');
    document.body.append(grid);
    const bad: Element[] = [];
    const t0 = performance.now();
    for (let burst = 0; burst < 15; burst++) {
      for (let i = 0; i < 100; i++) {
        const n = burst * 100 + i;
        const isBad = n % 10 === 0;
        const c = ytCard(isBad ? `GTA 6 news #${n}` : `Minecraft build #${n}`);
        if (isBad) bad.push(c);
        grid.append(c);
      }
      await Promise.resolve();
      // invariant at every microtask checkpoint: no unevaluated GTA card is visible
      for (const c of bad) expect(['blocked', 'pending', null]).toContain(state(c));
      for (const c of bad) if (state(c) === null) throw new Error('card shown without evaluation');
    }
    await frames(20);
    const ms = performance.now() - t0;
    expect(bad.every((c) => state(c) === 'blocked')).toBe(true);
    expect(grid.querySelectorAll('[data-ss-state="safe"]').length).toBe(1350);
    console.log(`[bench] 1500 cards processed in ${ms.toFixed(0)} ms (jsdom); max flush ${scanner.metrics.maxFlushMs.toFixed(1)} ms; pending marked ${scanner.metrics.pendingMarked}`);
  }, 30000);
});

describe('Reddit-style posts (shadow DOM)', () => {
  it('blocks a shreddit-post using its post-title attribute and places the overlay in the shadow root', async () => {
    setup(reddit);
    const post = document.createElement('shreddit-post');
    post.attachShadow({ mode: 'open' }).innerHTML = '<slot name="title"></slot><slot></slot>';
    post.setAttribute('post-title', 'Jason Duval dies in the last mission?!');
    post.setAttribute('subreddit-prefixed-name', 'r/gaming');
    post.innerHTML = '<a slot="title" href="/r/gaming/comments/1/x/">Spoiler discussion</a><div>Body text</div>';
    const ok = document.createElement('shreddit-post');
    ok.setAttribute('post-title', 'My cat learned to open doors');
    document.body.append(post, ok);
    await tick();
    expect(state(post)).toBe('blocked');
    expect(post.shadowRoot!.querySelector(`[${OVERLAY_ATTR}]`)).not.toBeNull();
    expect(state(ok)).toBe('safe');
  });

  it('blocks only the matching comment body, not the whole thread', async () => {
    setup(reddit);
    const outer = document.createElement('shreddit-comment');
    outer.innerHTML = '<div slot="comment"><p>Has anyone tried the new keyboard?</p></div>';
    const inner = document.createElement('shreddit-comment');
    inner.innerHTML = '<div slot="comment"><p>Off topic but the GTA 6 ending leaked</p></div>';
    outer.append(inner);
    document.body.append(outer);
    await tick();
    expect(state(outer.querySelector(':scope > [slot="comment"]'))).toBe('safe');
    expect(state(inner.querySelector(':scope > [slot="comment"]'))).toBe('blocked');
  });
});

describe('Google-style results', () => {
  it('hides matching results including snippets', async () => {
    setup(google);
    document.body.innerHTML = `<div id="rso">
      <div class="MjjYud"><div class="g"><a href="https://www.rockstargames.com/VI"><h3>Grand Theft Auto VI - Rockstar Games</h3></a><div class="VwiC3b">Official site</div></div></div>
      <div class="MjjYud"><div class="g"><a href="https://example.com/bread"><h3>Sourdough bread guide</h3></a><div class="VwiC3b">Flour, water, salt.</div></div></div>
    </div>`;
    await tick();
    const [a, b] = [...document.querySelectorAll('div.g')];
    expect(state(a)).toBe('blocked');
    expect(state(b)).toBe('safe');
  });

  it('hides autocomplete suggestions (role=option)', async () => {
    setup(google);
    document.body.innerHTML = `<ul role="listbox"><li role="presentation"><div role="option">gta 6 ending</div></li><li role="presentation"><div role="option">gta 5 cheats</div></li></ul>`;
    await tick();
    const opts = [...document.querySelectorAll('[role="option"]')];
    expect(state(opts[0])).toBe('blocked');
    expect(state(opts[1])).toBe('safe');
  });
});

describe('generic websites', () => {
  it('blocks the smallest container (list item with thumbnail) and leaves the rest', async () => {
    setup(generic);
    document.body.innerHTML = `<main><h1>Gaming news</h1><ul>
      <li><a href="/a"><img src="/img/thumb1.jpg" alt=""><h3>GTA 6 delayed again? What we know</h3></a></li>
      <li><a href="/b"><img src="/img/thumb2.jpg" alt=""><h3>Nintendo Direct recap</h3></a></li></ul>
      <p>Regular paragraph about hardware.</p></main>`;
    await tick();
    const lis = document.querySelectorAll('li');
    expect(state(lis[0])).toBe('blocked');
    expect(state(lis[1])).toBe(null);
    expect(state(document.querySelector('p'))).toBe(null);
    expect(state(document.querySelector('main'))).toBe(null);
  });

  it('blocks just the paragraph inside a long article', async () => {
    setup(generic);
    const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40);
    document.body.innerHTML = `<div class="content"><p>${filler}</p><p>Meanwhile, Lucia Caminos was spotted in the final cutscene.</p><p>${filler}</p></div>`;
    await tick();
    const ps = document.querySelectorAll('p');
    expect(state(ps[0])).toBe(null);
    expect(state(ps[1])).toBe('blocked');
    expect(state(ps[2])).toBe(null);
  });

  it('detects text added later to existing elements', async () => {
    setup(generic);
    document.body.innerHTML = '<div><h2 id="h">Loading…</h2></div>';
    await tick();
    document.getElementById('h')!.textContent = 'GTA VI review roundup';
    await tick();
    expect(state(document.getElementById('h'))).toBe('blocked');
  });

  it('detects images by alt text', async () => {
    setup(generic);
    document.body.innerHTML = '<figure><img src="/a.jpg" alt="Jason and Lucia in Vice City"><figcaption>Photo</figcaption></figure><p>unrelated</p>';
    await tick();
    expect(state(document.querySelector('figure'))).toBe('blocked');
  });

  it('never hides text the user is typing (contenteditable)', async () => {
    setup(generic);
    document.body.innerHTML = '<div contenteditable="true">I can not wait for GTA 6</div>';
    await tick();
    expect(state(document.querySelector('[contenteditable]'))).toBe(null);
  });

  it('ignores script contents', async () => {
    setup(generic);
    document.body.innerHTML = '<div id="x"><script>var t = "GTA 6 ending";</script><span>Hello world</span></div>';
    await tick();
    expect(document.querySelectorAll('[data-ss-state="blocked"]').length).toBe(0);
  });

  it('does not rescan its own overlays', async () => {
    setup(generic);
    document.body.innerHTML = '<ul><li>GTA 6 trailer</li></ul>';
    await tick();
    const before = scanner.metrics.evaluations;
    await frames(3);
    expect(scanner.metrics.evaluations).toBe(before);
  });
});

describe('modes and lifecycle', () => {
  it('mode switching changes what is blocked without reload', async () => {
    setup(generic, 'standard');
    document.body.innerHTML = '<ul><li>New photos from Leonida</li></ul>';
    await tick();
    const li = document.querySelector('li')!;
    expect(state(li)).toBe(null);
    scanner.setConfig({ detector: createDetector({ ...DEFAULT_SETTINGS, mode: 'strict' }), mode: 'strict', blockImages: true, protectTitle: true });
    expect(state(li)).toBe('blocked');
    scanner.setConfig({ detector: createDetector({ ...DEFAULT_SETTINGS, mode: 'standard' }), mode: 'standard', blockImages: true, protectTitle: true });
    expect(state(li)).toBe(null);
  });

  it('maximum mode adds generic preventive hiding', () => {
    setup(generic, 'maximum');
    expect(document.documentElement.getAttribute('data-ss-guard')).toBe('max');
  });

  it('stop() removes every overlay, attribute and the style', async () => {
    setup(youtube);
    document.body.append(ytCard('GTA 6 trailer'), ytCard('Cats'));
    document.title = 'GTA 6 - YouTube';
    await tick();
    scanner.stop();
    expect(document.querySelectorAll(`[${STATE_ATTR}],[${OVERLAY_ATTR}],style[data-ss-style]`).length).toBe(0);
    expect(document.documentElement.hasAttribute('data-ss-guard')).toBe(false);
    expect(document.title).toBe('GTA 6 - YouTube');
  });

  it('marks content pending while settings are still loading', async () => {
    document.body.innerHTML = '';
    scanner = new Scanner({ doc: document, adapter: generic, raf: (cb) => setTimeout(cb, 10) });
    scanner.setConfig({ detector: null, mode: 'strict', blockImages: true, protectTitle: true });
    scanner.start();
    const div = document.createElement('div');
    div.textContent = 'GTA 6 ending';
    document.body.append(div);
    await tick();
    expect(state(document.body) === 'pending' || state(div) === 'pending').toBe(true);
    scanner.setConfig({ detector: createDetector(DEFAULT_SETTINGS), mode: 'strict', blockImages: true, protectTitle: true });
    expect(state(document.body)).toBe(null);
    expect(state(div)).toBe('blocked');
  });
});

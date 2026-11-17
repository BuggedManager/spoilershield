# SpoilerShield — GTA 6 spoiler protection for Chrome

SpoilerShield is a Manifest V3 Chrome extension. It hides Grand Theft Auto VI content and story spoilers on YouTube, Google Search, Reddit, X/Twitter, Facebook, Instagram, Twitch and ordinary websites, and it tries to do so before the content reaches the screen. Hidden items are covered by an opaque overlay with **Reveal** and **Hide again** buttons. Everything runs locally: no accounts, no analytics, and nothing about you or your browsing is sent anywhere.

## Download

Get **SpoilerShield-1.0.0.zip** from the [latest release](https://github.com/BuggedManager/spoilershield/releases/latest). Unzip it, keep the folder somewhere permanent, and follow `Install-Guide.pdf` inside: in `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `extension` folder.

---

## 1. Install from source (Load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`dist`** folder in this project.
4. Pin SpoilerShield from the puzzle-piece menu so the shield icon stays visible.
5. **Reload any tabs that were already open.** Chrome only injects content scripts into pages loaded after installation.

Protection is on by default in **Strict** mode.

`spoilershield-1.0.0.zip` contains the same build, packaged for the Chrome Web Store.

### Build from source

Requirements: Node 18+.

```bash
npm install
npm run build        # regenerates the dictionary, bundles TypeScript → dist/ + zip
npm test             # unit + DOM tests (Vitest)
npm run test:browser # real Chrome integration tests (see §8)
npm run bench        # detection micro-benchmarks
```

## 2. Updating

* **From source:** pull or edit the code, run `npm run build`, then click the ↻ reload icon on the SpoilerShield card in `chrome://extensions`, and reload open tabs. Settings and statistics are kept.
* **Dictionary only:** edit `src/detection/data/*.json`, then `npm run build`. Detection code does not need to change (see §5).
* **Bump the version** in `package.json`. The build stamps it into the manifest.

## 3. Using it

**Popup** (toolbar icon):
* Master on/off switch and **Protection Status**.
* **Total blocked**, **Blocked today** and **On this page** counters. These come from real detection events only.
* The current website's status, plus **Reveal all** and **Pause on this site**.
* Mode selector: **Standard / Strict / Maximum**.
* Toggles for GTA 6 content, story spoilers, and images & thumbnails.
* A quick **Add custom keyword** box, and **Open settings**.

**Settings page:**
* Per-site toggles for the specialised adapters and for all other websites.
* **Allowlist**: protection paused. **Blocklist**: always Maximum Protection.
* Custom keywords (Strong / Medium / Weak), with bulk import.
* **Custom game profiles**, so you can protect yourself from other games too.
* Sensitivity, languages (English, French incl. Québec), extended detection, tab-title protection.
* Experimental local image matching.
* A **Test detection** box that shows the verdict, score and signals for any text.
* Export / import settings (JSON), reset statistics, restore defaults.

All changes apply to open tabs immediately. No reload is needed.

### Protection modes

| Mode | Threshold | What it does |
|---|---|---|
| Standard | 60 | Obvious GTA 6 references and high-confidence spoilers. Fewest false positives. |
| **Strict** (default, recommended) | 40 | Everything recognised as GTA 6, including harmless news, promotional material and gameplay. |
| Maximum Protection | 30 | Also keeps articles, posts, list items and figures hidden on every site until they have been evaluated, and keeps empty card skeletons hidden longer. **This may briefly hide safe content or cause layout shifts.** |

Sensitivity shifts the threshold by +20 (low), 0 (medium) or −15 (high). Content with story-spoiler words gets a further 20-point allowance when "Block potential story spoilers" is on. If you turn off "Block GTA 6 content" but leave spoiler blocking on, general GTA 6 news shows and story spoilers stay hidden.

## 4. How the protection works

```
document_start ──► <style> injected: adapter "cards" hidden until evaluated
                   (html[data-ss-guard] card:not([data-ss-state]) {visibility:hidden})
DOM insertions ──► MutationObserver (microtask, runs before paint)
                   └─ evaluate synchronously within a 12 ms budget
                      └─ leftovers → data-ss-state="pending" (hidden) → next animation frames
evaluate ───────► card text + title / aria-label / alt / link path (nested cards excluded)
                   └─ Detector (normalize → token index → context scoring)
                      ├─ safe    → data-ss-state="safe"   (card becomes visible)
                      └─ blocked → data-ss-state="blocked" + opaque overlay
```

* **Preventive hiding.** On supported sites, every card (video tile, search result, post, comment, autocomplete row, …) is invisible from the moment it is parsed until it has been checked. A real-Chrome test confirms that a GTA 6 card inserted by a page script is `visibility: hidden` immediately and is blocked by the first animation frame.
* **Whole-card blocking.** On YouTube the whole video card (thumbnail, title, channel) is covered, never just the title. Media inside blocked items is paused. A blocked player stays paused even if the page tries to autoplay it.
* **Overlays** live in a closed shadow root with fully opaque backgrounds. They never contain the hidden text. They have keyboard-accessible buttons with ARIA labels, and they resize to compact single-line layouts for small items. Clicks on an overlay never reach links underneath. If a site removes an overlay, it is re-attached.
* **Dynamic pages.** Changed text, recycled cards (YouTube reuses card elements) and late-loading content are re-evaluated. A card you revealed stays revealed while it shows the same item. If it is recycled into a different spoiler, it is hidden again.
* **Tab titles.** A page title like "GTA 6 ending explained – YouTube" is replaced with "🛡 Title hidden by SpoilerShield".
* **Generic sites.** The detector finds the smallest sensible container: a list item or card with its thumbnail, a single paragraph inside an article, or a heading. It skips scripts, styles and anything you are typing (`contenteditable`, inputs).
* **Shadow DOM.** Overlays are placed inside open or closed shadow roots when needed (for example Reddit's `shreddit-post`).

### Site adapters (`src/adapters/index.ts`)

| Site | Covered |
|---|---|
| YouTube | home / search / channel / playlist cards, new `yt-lockup-view-model`, Shorts shelves and player, sidebar, comments, community posts, notifications, live chat, end-screen and autoplay "up next", watch-page metadata, the video player, search suggestions; hover previews suppressed over hidden cards |
| Google | results, snippets, People also ask, news, images, videos, knowledge-panel text, related searches, autocomplete |
| Reddit | posts (via the `post-title` attribute and subreddit name), comment bodies (individually, not the whole thread), subreddit headers, search results, trending, old.reddit |
| X / Twitter | posts and replies, trends, user cells, search typeahead, link cards, DMs, notifications |
| Facebook / Instagram / Twitch | feed posts and comments, grid posts and hashtag results, directory cards, chat, side nav, stream title and player |
| Everything else | generic detector, plus `[role=option]` autocomplete on every site |

## 5. Detection engine

Source: `src/detection/`.

1. **Exact matching.** A token index gives O(words) lookup, the longest phrase wins, and matched words are consumed.
2. **Normalized matching.** NFKC; zero-width and invisible characters removed; Greek and Cyrillic look-alikes folded (`GΤA`, `GTΛ`); camelCase and hashtag splitting (`#GrandTheftAutoVI`, `GTA6Online`); diacritics stripped; runs of spaced single letters merged (`G T A 6`, `G.T.A.6`); letter/digit splitting (`gta6leaks`); circled and fullwidth digits (`GTA⑥`, `ＧＴＡ６`). Ordinary words are never glued together, so `Viking TA 6` does not become `gta 6`.
3. **Contextual scoring.** Title 100, distinctive full character name 65, distinctive location 50–55, ambiguous location 20–35 (`Vice City`, `Ambrosia`), franchise 20–25 (`GTA`, `Rockstar Games`). Context-only words count only when at least 20 points of direct game evidence exist: first names 10 (`Jason`, `Lucia`), spoiler terms 25, media terms 15 (top two of each). A +15 bonus applies when two or more distinct evidence types appear. Older titles (`GTA 5`, `GTA Vice City`, `San Andreas`, `GTA Online`, …) are masked so they add no context. Hashtag prefixes only match with known suffixes, so `#gtavileaks` matches but `#gtavicecity` and `#gtavideos` do not.
4. **Extended detection** (optional, on by default; not an ML model). Typo-tolerant matching of distinctive names (`Lucia Caminoss`), with a stop list (`Leonidas` is not `Leonida`). Indirect references (`Rockstar's next game`, `le prochain GTA`).

**Dictionary (Category G).** `src/detection/data/` holds the seeds:
* `gta6.seed.json`: officially announced names only, with sources.
* `terms.en.json`: English spoiler and media vocabulary.
* `terms.fr.json`: French and Québec vocabulary.

`npm run dict` (part of `build`) expands numeral / spacing / compact variants, groups the terms by confidence, deduplicates them and writes `src/detection/generated/dictionary.json`. That produces 637 canonical terms: 41 high-confidence, 117 medium, 333 context-only and 136 older-GTA exclusions. To add a language, drop in `terms.xx.json`. To import a keyword list:

```bash
npm run dict -- --import my-terms.txt --profile gta6 --strength medium
```

User keywords and custom profiles go through the same expansion at runtime.

**Verified vocabulary.** Characters come from the official Rockstar reveal (May 2025): Jason Duval, Lucia Caminos, Cal Hampton, Boobie Ike, Dre'Quan Priest, Real Dimez (Bae-Luxe, Roxy), Raul Bautista, Brian Heder. Places: Vice City, Leonida, Leonida Keys, Grassrivers, Port Gellhorn, Ambrosia, Mount Kalaga National Park. No leaked or story content was researched or included.

## 6. Privacy and permissions

| Permission | Why |
|---|---|
| `storage` | Saves settings and daily counters in `chrome.storage.local`. |
| Content script on `<all_urls>` | Spoilers can appear on any site. The script reads the page only to decide what to hide. |
| Optional `<all_urls>` host permission | **Requested only if you enable local image matching.** It lets the background worker re-read on-screen images from their original host (normally from cache) to fingerprint them. |

The extension does **not** use `tabs`, `history`, `webRequest`, `scripting` or remote code. It has no analytics, ads or accounts, uses no `eval` (the build fails if it finds `eval` or `new Function`), and injects no unsafe HTML: dynamic text is always set with `textContent`. Its CSP is `script-src 'self'; object-src 'none'; base-uri 'none'`. Statistics store only a count per local date (last 30 days), with no URLs, titles or hostnames. The toolbar badge count is kept in memory only.

## 7. Limitations (please read)

No browser extension can guarantee that every spoiler is hidden before display. Known gaps:

* **Pixels, not text.** Content in videos, canvas or WebGL, images without descriptive text, and audio cannot be read. Thumbnails are hidden only together with matching text in the same card, or by alt text or file names.
* **Pages SpoilerShield can't run on:** pages that were already open when the extension was installed (reload them), browser pages (`chrome://`, the Web Store, the PDF viewer), and frames Chrome does not inject into.
* **Shadow DOM.** Shadow roots (open or closed) of custom elements are observed when their host element is processed. A shadow root attached *after* that point, or one inside an element without a hyphenated tag name, may be missed.
* **Website changes.** Adapter selectors were written against each site's markup at the time of development and will need maintenance. The generic detector is a fallback, but it may hide a smaller or larger area than ideal.
* **Language.** Detection is keyword-and-context based. Paraphrases with no names or titles ("the new Rockstar game's last scene"), other languages, and heavy obfuscation (leetspeak, images of text) can slip through. Harmless content mentioning e.g. "Vice City" or "Rockstar Games" with spoiler words may be hidden.
* **Timing.** Preventive hiding covers adapter cards and (in Maximum mode) generic articles and posts. On other elements of generic sites, evaluation runs in the MutationObserver microtask before paint, but a slow device or a huge synchronous insertion can still show content briefly before it is marked pending.
* **Badge counts** reset when the service worker restarts. Daily statistics are not affected.

## 8. Tests and measured results

Results from 2026-11-17 on Windows 11, Node 24 and Chrome 157:

**Unit + DOM tests (Vitest, jsdom): 142 / 142 passed.**
* Detection: exact titles (25 variants), obfuscation (10), characters with and without context, locations, older-GTA exclusions, spoiler terms, French and Québec terms, extended detection, 22 false-positive sentences, modes and sensitivity, custom keywords and profiles.
* Scanner: preventive CSS, whole-card blocking, synchronous pre-paint evaluation, Reveal / Hide again, recycled cards, skeleton cards, overlay re-attachment, title and player protection, 1,500-card churn, Reddit shadow DOM, comment-level blocking, Google results and autocomplete, generic list items and paragraphs, late text, alt text, `contenteditable`, script contents, no self-rescanning, live mode switching, stop/cleanup, pending-until-settings.
* Settings: persistence, import validation, allow/blocklists, adapter routing, statistics, image fingerprints.

**Real-browser integration (`npm run test:browser`): 20 / 20 passed.** The test loads the built extension into the installed Google Chrome via the DevTools protocol (`Extensions.loadUnpacked`) and serves local HTML fixtures on the real hostnames (`www.youtube.com`, `www.google.com`, `www.reddit.com`, `news.example.com`) through request interception. It covers the actual adapters, the service worker, storage, the badge, the popup (verified to fit Chrome's 600 px popup limit), the settings page, keyboard Reveal / Hide again, link-click suppression, tab-title replacement, live allowlist/mode/keyword changes and statistics. Screenshots are in `tests/results/`.

Pass `--chromium` to use Playwright's Chromium with `--load-extension` instead. On this machine that unsigned binary could not be launched, so the installed Chrome was used.

**Benchmarks:**

| Measurement | Result |
|---|---|
| Build detector (637 terms + fuzzy index) | 1.1 ms per frame/page |
| Evaluate 100-char card (uncached) | 4–5 µs |
| Evaluate 2 KB text block of all-new words | 36 µs |
| Evaluate 20 KB page section | 0.23 ms |
| Real Chrome, 2,000 YouTube-style cards inserted in 40 scroll batches | **~89 µs per card** including DOM work (median 4.4 ms per 50-card batch vs 0.4 ms with protection off; p95 6.1 ms); every GTA card hidden at every frame |

**Not verified:** behaviour on the live youtube.com, google.com, reddit.com, x.com, facebook.com, instagram.com and twitch.tv sites, whose real markup differs from the fixtures. The image matcher's end-to-end flow (permission grant → background fetch → match) was not exercised by automated tests; its hashing is unit-tested.

## 9. Feature status

**Implemented and tested:**
* MV3 extension, on by default, `document_start` preventive CSS, MutationObserver with a time-budgeted queue, rAF continuation and pending state.
* Detection layers 1–3 and Layer 4 (extended detection) with the generated dictionary, English + French, and obfuscation handling.
* YouTube, Google and Reddit adapters (fixture-tested). X, Facebook, Instagram and Twitch adapters (selectors written; not fixture-tested). Generic detector.
* Opaque, accessible overlays with Reveal / Hide again and Reveal all / Hide all. Tab-title and media protection.
* Popup and settings page. Allow/blocklist, custom keywords, custom game profiles, sensitivity, languages, export/import, reset.
* Real statistics (total, today, this page, badge).

**Experimental:**
* Local image matching (Layer 5). Perceptual-hash (dHash) matching against reference images you add, limited to visible images, ≤4 concurrent, ≤120 per minute, cached per URL. Off by default; does nothing without references or permission. It recognises re-posts of your reference images. It **cannot** recognise arbitrary GTA 6 screenshots.

**Not implemented:**
* A machine-learning text or image classifier. Layer 4 is deterministic typo and indirect-reference matching, not a semantic model.
* Automatic injection into tabs that were open before installation (this would need the `scripting` permission).
* Languages beyond English and French.

## 10. Project structure

```
spoilershield/
├─ public/            manifest.json, popup/options HTML+CSS, icons
├─ src/
│  ├─ detection/      normalize, vocabulary (variant generation), dictionary builder, engine, data/ seeds, generated/
│  ├─ content/        index.ts (entry, document_start), scanner.ts (queue, observers, overlays)
│  ├─ adapters/       per-site card selectors, page units, extra CSS
│  ├─ overlays/       shadow-DOM overlay
│  ├─ background/     service worker: stats, badge, image hashing
│  ├─ popup/, settings/   UI logic (plain TypeScript, no framework – fast popup, tiny bundle)
│  ├─ storage/        settings schema, validation, site decisions, stats
│  ├─ ai/             optional local image matcher (dHash)
│  └─ shared/         message types
├─ scripts/           build.mjs (esbuild), build-dictionary.ts, browser-test.mjs, bench.ts, make-icons.mjs, zip.mjs
├─ tests/unit/        Vitest suites;  tests/fixtures/ HTML fixtures;  tests/results/ screenshots + JSON
└─ dist/              ← Load unpacked
```

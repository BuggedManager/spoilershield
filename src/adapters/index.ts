/**
 * Website adapters. Each adapter lists "cards" – the smallest element that
 * contains a whole item (title + thumbnail + metadata). Cards are hidden by
 * CSS until evaluated (preventive hiding) and are blocked as one unit, so a
 * thumbnail is never left visible next to a hidden title.
 *
 * Selectors are best-effort against each site's markup at the time of writing.
 * Sites change markup frequently; anything not matched here is still covered by
 * the generic DOM detector (src/content/scanner.ts → genericScan).
 */
import type { SiteId } from '../storage/settings';

export interface PageUnit {
  /** element to cover (e.g. the video player) */
  selector: string;
  /** text that describes what the element is showing */
  text: (doc: Document, pageTitle: string) => string;
}

export interface SiteAdapter {
  id: SiteId;
  name: string;
  matches: (host: string) => boolean;
  cards: string[];
  pageUnits?: PageUnit[];
  /** attribute text not covered by generic extraction */
  extraText?: (el: Element) => string;
  /** extra page CSS */
  css?: string;
  /** SPA navigation events that should trigger a page-unit re-check */
  navEvents?: string[];
}

const txt = (doc: Document, sel: string) => (doc.querySelector(sel)?.textContent ?? '').slice(0, 2000);
const attrs = (el: Element, names: string[]) => names.map((n) => el.getAttribute(n) ?? '').join(' \n ');

/** Autocomplete / suggestion rows on any site. */
export const GLOBAL_CARDS = ['[role="option"]'];
/** Additional cards hidden-until-evaluated in Maximum Protection on every site. */
export const MAXIMUM_CARDS = ['article', '[role="article"]', 'figure', '[role="listitem"]'];

const host = (h: string, ...domains: string[]) => domains.some((d) => h === d || h.endsWith('.' + d));

export const youtube: SiteAdapter = {
  id: 'youtube',
  name: 'YouTube',
  matches: (h) => host(h, 'youtube.com', 'youtube-nocookie.com'),
  cards: [
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer', 'ytd-grid-video-renderer',
    'yt-lockup-view-model', 'ytd-playlist-video-renderer', 'ytd-playlist-panel-video-renderer',
    'ytd-reel-item-renderer', 'ytm-shorts-lockup-view-model', 'ytm-shorts-lockup-view-model-v2',
    'ytd-reel-video-renderer', 'ytd-radio-renderer', 'ytd-playlist-renderer', 'ytd-channel-renderer',
    'ytd-compact-radio-renderer', 'ytd-compact-playlist-renderer', 'ytd-movie-renderer',
    'ytd-universal-watch-card-renderer', 'ytd-horizontal-card-renderer', 'ytd-backstage-post-thread-renderer',
    'ytd-post-renderer', 'ytd-comment-view-model', 'ytd-comment-renderer', 'ytd-watch-metadata',
    'ytd-notification-renderer', 'ytd-ad-slot-renderer', 'yt-page-header-view-model', 'ytd-hashtag-header-renderer',
    'yt-live-chat-text-message-renderer', 'yt-live-chat-paid-message-renderer',
    '.ytp-videowall-still', '.ytp-ce-element', '.ytp-autonav-endscreen-upnext-container', '.ytp-modern-videowall-still',
    '.ytSearchboxComponentSuggestion', '.sbsb_c', 'ytd-video-description-infocards-section-renderer',
  ],
  pageUnits: [
    {
      selector: '#movie_player',
      text: (doc, title) =>
        `${title}\n${txt(doc, 'ytd-watch-metadata #title')}\n${txt(doc, '.ytp-title-link')}\n${txt(doc, '.ytp-title-text')}`,
    },
  ],
  extraText: (el) => attrs(el, ['aria-label', 'title']),
  css: `
html[data-ss-hover] #video-preview, html[data-ss-hover] ytd-video-preview { display: none !important; }
`,
  navEvents: ['yt-navigate-finish', 'yt-page-data-updated'],
};

export const google: SiteAdapter = {
  id: 'google',
  name: 'Google Search',
  matches: (h) => /(^|\.)google\.[a-z.]+$/.test(h) && !/^(mail|docs|drive|calendar|meet|accounts)\./.test(h),
  cards: [
    '.MjjYud', 'div.g', '.related-question-pair', 'g-inner-card', '.WlydOe', '.SoaBEf', '.ivg-i', '.isv-r',
    '.eA0Zlc', '.H8Rx8c', '.xpdopen', '.kno-rdesc', '#rhs [data-attrid]', 'a.k8XOCe', '.s75CSd', '.b2Rnsc',
    '.sbct', 'video-voyager', '.RzdJxc', 'div[data-lpage]', '.PmEWq', '.y8xXlf', '.ULSxyf .wDYxhc',
    'c-wiz article',
  ],
};

export const reddit: SiteAdapter = {
  id: 'reddit',
  name: 'Reddit',
  matches: (h) => host(h, 'reddit.com'),
  cards: [
    'shreddit-post', 'shreddit-comment > [slot="comment"]', '[data-testid="search-post-unit"]',
    '[data-testid="search-post-with-content-preview"]', '[data-testid="search-trending-row"]',
    'shreddit-subreddit-header', 'search-telemetry-tracker[view-events*="search/view/post"]',
    'reddit-recent-pages li', 'recent-posts article', 'faceplate-tracker[noun="trending_search"]',
    'community-highlight-card', 'shreddit-gallery-carousel',
    // old.reddit.com
    '.thing.link', '.thing.comment .usertext-body', '.search-result',
  ],
  extraText: (el) => attrs(el, ['post-title', 'subreddit-prefixed-name', 'content-href', 'aria-label', 'prefixed-name']),
};

export const twitter: SiteAdapter = {
  id: 'twitter',
  name: 'X / Twitter',
  matches: (h) => host(h, 'x.com', 'twitter.com'),
  cards: [
    'article[data-testid="tweet"]', 'article[data-testid="notification"]', '[data-testid="trend"]',
    '[data-testid="UserCell"]', '[data-testid="typeaheadResult"]', '[data-testid="TypeaheadUser"]',
    '[data-testid="card.wrapper"]', '[data-testid="conversation"]', '[data-testid="messageEntry"]',
    '[data-testid="eventHero"]', '[data-testid="news_sidebar"] [role="link"]',
  ],
};

export const facebook: SiteAdapter = {
  id: 'facebook',
  name: 'Facebook',
  matches: (h) => host(h, 'facebook.com', 'fb.com'),
  cards: ['[role="article"]', 'div[aria-posinset]', '[data-pagelet^="FeedUnit"]', '[data-pagelet^="Reels"] a'],
};

export const instagram: SiteAdapter = {
  id: 'instagram',
  name: 'Instagram',
  matches: (h) => host(h, 'instagram.com'),
  cards: ['article', 'a[href*="/p/"]', 'a[href*="/reel/"]', 'a[href*="/explore/tags/"]', '[role="dialog"] ul li'],
};

export const twitch: SiteAdapter = {
  id: 'twitch',
  name: 'Twitch',
  matches: (h) => host(h, 'twitch.tv'),
  cards: [
    'article', '.side-nav-card', '.chat-line__message', '[data-a-target="chat-line-message"]', '.vod-message',
    '[data-a-target="search-result-live-channel"]', '[data-a-target="search-result-video"]',
    '[data-a-target="tw-box-art-card-link"]', '.tw-tower > div', '.channel-info-content',
    '[data-a-target="search-result-category"]',
  ],
  pageUnits: [
    {
      selector: '.video-player',
      text: (doc, title) =>
        `${title}\n${txt(doc, '[data-a-target="stream-title"]')}\n${txt(doc, '[data-a-target="stream-game-link"]')}`,
    },
  ],
};

export const generic: SiteAdapter = {
  id: 'other',
  name: 'Generic website',
  matches: () => true,
  cards: [],
};

export const ADAPTERS: SiteAdapter[] = [youtube, google, reddit, twitter, facebook, instagram, twitch];

export function adapterFor(hostname: string): SiteAdapter {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  return ADAPTERS.find((a) => a.matches(h)) ?? generic;
}

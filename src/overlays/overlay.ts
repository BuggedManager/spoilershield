/**
 * Opaque spoiler overlay. Rendered inside a closed shadow root so page CSS
 * cannot alter it and page scripts / our own scanner cannot read its text.
 * Never contains any of the hidden content.
 */

export const OVERLAY_ATTR = 'data-ss-overlay';

export interface OverlayOptions {
  /** e.g. "GTA 6" (profile name, never the matched text) */
  label: string;
  spoiler: boolean;
  onReveal: () => void;
  onHide: () => void;
  onHover?: (hovering: boolean) => void;
}

export interface OverlayHandle {
  host: HTMLElement;
  setMode(mode: 'blocked' | 'revealed'): void;
  update(label: string, spoiler: boolean): void;
  focus(): void;
  remove(): void;
}

const SHIELD_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs><path fill="url(#g)" d="M12 1.8 3.5 5v6.2c0 5.3 3.6 10 8.5 11.2 4.9-1.2 8.5-5.9 8.5-11.2V5z"/><path fill="#14131b" d="M12 5.2 6.6 7.3v4c0 3.6 2.3 6.8 5.4 7.8 3.1-1 5.4-4.2 5.4-7.8v-4z"/><path fill="url(#g)" d="m10.9 14.6-2.6-2.6 1.2-1.2 1.4 1.4 3.6-3.6 1.2 1.2z"/></svg>';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: #15141c;
  background-image: radial-gradient(120% 90% at 0% 0%, rgba(139,92,246,.22), transparent 55%),
                    radial-gradient(110% 90% at 100% 100%, rgba(56,189,248,.16), transparent 55%);
  color: #f4f3ff; font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  border: 1px solid rgba(167,139,250,.35); border-radius: inherit; overflow: hidden;
  padding: 10px; text-align: center; cursor: default; user-select: none; -webkit-user-select: none;
}
.full { display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: 360px; }
.compact { display: none; align-items: center; gap: 8px; width: 100%; justify-content: center; min-width: 0; }
.brand { display: flex; align-items: center; gap: 6px; font-size: 10.5px; letter-spacing: .14em; font-weight: 700; color: #c4b5fd; }
.brand svg, .compact svg { width: 18px; height: 18px; flex: none; }
.title { font-size: 15px; font-weight: 700; color: #fff; }
.desc { font-size: 12px; color: #b9b6cc; }
.ctitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; min-width: 0; }
button {
  all: unset; box-sizing: border-box; cursor: pointer; font: 600 12.5px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #fff; padding: 8px 14px; border-radius: 999px; white-space: nowrap;
  background: linear-gradient(135deg, #7c3aed, #2563eb); box-shadow: 0 2px 10px rgba(124,58,237,.35);
  transition: transform .12s ease, filter .12s ease;
}
button:hover { filter: brightness(1.12); }
button:active { transform: scale(.97); }
button:focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; }
.compact button { padding: 5px 10px; font-size: 11.5px; }
.pill {
  display: none; align-items: center; gap: 6px; padding: 5px 10px 5px 8px; font-size: 11.5px;
  background: rgba(21,20,28,.92); border: 1px solid rgba(167,139,250,.5); box-shadow: 0 4px 14px rgba(0,0,0,.35);
}
.pill svg { width: 14px; height: 14px; }
@container ss (max-height: 109px) or (max-width: 219px) {
  .full { display: none; }
  .compact { display: flex; }
}
@container ss (max-width: 120px) { .ctitle { display: none; } }
@container ss (max-height: 26px) { .wrap { padding: 0 6px; } .compact svg { display: none; } .compact button { padding: 2px 8px; } }
:host([data-mode="revealed"]) .wrap { display: none; }
:host([data-mode="revealed"]) .pill { display: inline-flex; }
@media (prefers-reduced-motion: no-preference) {
  :host([data-mode="blocked"]) .wrap { animation: ssin .16s ease-out; }
  @keyframes ssin { from { opacity: .85; } to { opacity: 1; } }
}
`;

const MARKUP = `
<div class="wrap" part="wrap">
  <div class="full">
    <div class="brand">${SHIELD_SVG}<span>SPOILERSHIELD</span></div>
    <div class="title" id="t"></div>
    <div class="desc">This content has been hidden to protect you from spoilers.</div>
    <button type="button" class="reveal" data-act="reveal">Reveal content</button>
  </div>
  <div class="compact">${SHIELD_SVG}<span class="ctitle" id="ct"></span><button type="button" class="reveal" data-act="reveal">Reveal</button></div>
</div>
<button type="button" class="pill" data-act="hide">${SHIELD_SVG}<span>Hide again</span></button>
`;

const BLOCKED_STYLE: Record<string, string> = {
  position: 'absolute', inset: '0', 'z-index': '2147483646', display: 'block', visibility: 'visible',
  opacity: '1', 'pointer-events': 'auto', margin: '0', padding: '0', border: '0', width: 'auto', height: 'auto',
  'min-width': '0', 'min-height': '0', 'max-width': 'none', 'max-height': 'none', transform: 'none', filter: 'none',
  'container-type': 'size', 'container-name': 'ss', 'border-radius': 'inherit', contain: 'layout style paint',
  top: '0', left: '0', right: '0', bottom: '0', float: 'none', 'clip-path': 'none',
};
const REVEALED_STYLE: Record<string, string> = {
  ...BLOCKED_STYLE, inset: 'auto', top: '6px', right: '6px', left: 'auto', bottom: 'auto',
  'container-type': 'normal', contain: 'none',
};

const STOP_EVENTS = [
  'click', 'auxclick', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend',
  'contextmenu', 'keydown', 'keyup', 'keypress', 'submit', 'dragstart',
];

let sharedSheet: CSSStyleSheet | null | undefined;
function sheetFor(): CSSStyleSheet | null {
  if (sharedSheet === undefined) {
    try {
      sharedSheet = new CSSStyleSheet();
      sharedSheet.replaceSync(CSS);
    } catch {
      sharedSheet = null; // e.g. jsdom - fall back to a <style> element
    }
  }
  return sharedSheet;
}

export function createOverlay(doc: Document, opts: OverlayOptions): OverlayHandle {
  const host = doc.createElement('div');
  host.setAttribute(OVERLAY_ATTR, '');
  host.setAttribute('data-mode', 'blocked');
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = sheetFor();
  if (sheet && 'adoptedStyleSheets' in root) root.adoptedStyleSheets = [sheet];
  else {
    const style = doc.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
  }
  const tpl = doc.createElement('template');
  tpl.innerHTML = MARKUP; // constant markup only – dynamic text is set via textContent below
  root.appendChild(tpl.content.cloneNode(true));

  const titleEl = root.getElementById('t') as HTMLElement;
  const ctitleEl = root.getElementById('ct') as HTMLElement;
  const wrap = root.querySelector('.wrap') as HTMLElement;
  wrap.setAttribute('role', 'group');
  const revealBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-act="reveal"]')];
  const hideBtn = root.querySelector<HTMLButtonElement>('[data-act="hide"]')!;
  let mode: 'blocked' | 'revealed' = 'blocked';

  const update = (label: string, spoiler: boolean) => {
    const kind = spoiler ? 'Spoiler' : 'Content';
    titleEl.textContent = `Potential ${label} ${kind} Detected`;
    ctitleEl.textContent = `Potential ${label} ${spoiler ? 'spoiler' : 'content'} hidden`;
    wrap.setAttribute('aria-label', `SpoilerShield: potential ${label} ${spoiler ? 'spoiler' : 'content'} hidden`);
    for (const b of revealBtns) b.setAttribute('aria-label', `Reveal hidden ${label} content`);
    hideBtn.setAttribute('aria-label', `Hide this ${label} content again`);
  };
  update(opts.label, opts.spoiler);

  const applyStyle = (s: Record<string, string>) => {
    for (const [k, v] of Object.entries(s)) host.style.setProperty(k, v, 'important');
  };
  host.style.setProperty('all', 'initial', 'important');
  applyStyle(BLOCKED_STYLE);

  for (const ev of STOP_EVENTS) {
    host.addEventListener(ev, (e) => {
      e.stopPropagation();
      if (ev === 'click' || ev === 'auxclick' || ev === 'submit' || ev === 'dragstart') e.preventDefault();
    });
  }
  root.addEventListener('click', (e) => {
    const act = (e.target as Element | null)?.closest?.('[data-act]')?.getAttribute('data-act');
    if (act === 'reveal') opts.onReveal();
    else if (act === 'hide') opts.onHide();
  });
  if (opts.onHover) {
    host.addEventListener('mouseenter', () => opts.onHover?.(true));
    host.addEventListener('mouseleave', () => opts.onHover?.(false));
  }

  return {
    host,
    setMode(m) {
      if (m === mode) return;
      mode = m;
      host.setAttribute('data-mode', m);
      applyStyle(m === 'blocked' ? BLOCKED_STYLE : REVEALED_STYLE);
    },
    update,
    focus() {
      (mode === 'blocked' ? revealBtns.find((b) => b.offsetParent !== null) ?? revealBtns[0] : hideBtn).focus();
    },
    remove() {
      host.remove();
    },
  };
}

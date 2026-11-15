// @ts-check
/* global document, fetch */
// DOM and network helpers of the catalog client. Every piece of server data becomes DOM through
// createElement and text nodes; nothing is ever assigned as HTML. Links are set only after
// checking for an absolute http(s) or mailto URL (the server checks too), and point to other
// origins with rel="noopener noreferrer nofollow".

export const BASE = '/-/web';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** @param {string} id */
export function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

/**
 * Creates an element with text-only children; `attrs` never carries event handlers or HTML.
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {Array<Node | string | null | undefined>} [children]
 */
export function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (/^on/i.test(k) || k === 'href' || k === 'src') throw new Error(`unsafe attribute ${k}`);
    node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * An SVG element. Colors and dashes come from the stylesheet classes (the CSP forbids inline
 * styles); `attrs` carries only numbers, ids and class names computed by the client.
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {Array<Node | string | null | undefined>} [children]
 */
export function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (/^on/i.test(k) || k === 'href' || k === 'src') throw new Error(`unsafe attribute ${k}`);
    node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** Own line icons (24 px grid, drawn for this catalog; no icon font, no images). */
const ICONS = /** @type {const} */ ({
  dashboard: ['M4 4h7v9H4z', 'M13 4h7v5h-7z', 'M13 11h7v9h-7z', 'M4 15h7v5H4z'],
  search: ['M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13z', 'M15.5 15.5L20 20'],
  chart: ['M4 4v16h16', 'M7.5 15l3.5-4.5l3 2.5l4.5-6.5'],
  user: ['M12 4a4 4 0 1 0 0 8a4 4 0 0 0 0-8z', 'M4.5 20c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5'],
  pause: ['M8 5v14', 'M16 5v14'],
  play: ['M8 5l11 7l-11 7z'],
  refresh: ['M19 12a7 7 0 1 1-2.2-5.1', 'M19 4.5v4h-4'],
});

/** @param {keyof typeof ICONS} name */
export function icon(name) {
  return svg(
    'svg',
    { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    ICONS[name].map((d) => svg('path', { d })),
  );
}

/** @param {string} value @param {boolean} [mail] */
export function safeUrl(value, mail = false) {
  try {
    const url = new URL(value);
    const ok =
      url.protocol === 'https:' || url.protocol === 'http:' || (mail && url.protocol === 'mailto:');
    return ok && url.username === '' && url.password === '' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A link to another site, or plain text when the URL is not acceptable.
 * @param {string} url
 * @param {Array<Node | string>} children
 */
export function externalLink(url, children) {
  const href = safeUrl(url, true);
  if (href === null) return h('span', {}, children);
  const a = h('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }, children);
  a.setAttribute('href', href);
  return a;
}

/**
 * A link inside the catalog (handled by the router).
 * @param {string} path
 * @param {Array<Node | string>} children
 * @param {Record<string, string>} [attrs]
 */
export function internalLink(path, children, attrs = {}) {
  const a = h('a', { 'data-route': '', ...attrs }, children);
  a.setAttribute('href', `${BASE}${path}`);
  return a;
}

/** @param {string} message */
export function announce(message) {
  byId('status').textContent = message;
}

/**
 * A tonal status label (always with text, never color alone).
 * @param {'success' | 'warning' | 'error' | 'busy' | 'paused'} status
 * @param {string} text
 * @param {string} [title]
 */
export function statusLabel(status, text, title) {
  return h('span', { class: `status ${status}`, ...(title !== undefined ? { title } : {}) }, [
    text,
  ]);
}

export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @template T
 * @param {string} path
 * @returns {Promise<T>}
 */
export async function api(path) {
  const res = await fetch(`${BASE}/api/${path}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    /** @type {unknown} */
    let body = null;
    try {
      body = await readJson(res);
    } catch {
      // keep the status text
    }
    const error =
      typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
    throw new HttpError(res.status, typeof error === 'string' ? error : res.statusText);
  }
  return /** @type {T} */ (await readJson(res));
}

/**
 * @param {Response} res
 * @returns {Promise<unknown>}
 */
function readJson(res) {
  return res.json();
}

// @ts-check
/* global document, window, location, history, navigator, fetch */
// Read-only package catalog (C5). Plain ES module, no dependencies, no build step. Every piece
// of server data becomes DOM through createElement and text nodes; nothing is ever assigned
// as HTML. Links are set only after checking for an absolute http(s) or mailto URL (the
// server checks too), and point to other origins with rel="noopener noreferrer nofollow".

/**
 * @typedef {string | MdElement} MdNode
 * @typedef {{ t: 'h', l: number, c: MdNode[] }
 *   | { t: 'p' | 'em' | 'strong' | 'del' | 'quote', c: MdNode[] }
 *   | { t: 'code', code: string }
 *   | { t: 'pre', code: string, lang?: string }
 *   | { t: 'a', href: string, c: MdNode[] }
 *   | { t: 'img', src: string, alt: string }
 *   | { t: 'ul', items: MdNode[][] }
 *   | { t: 'ol', start: number, items: MdNode[][] }
 *   | { t: 'hr' } | { t: 'br' }
 *   | { t: 'table', head: MdNode[][], rows: MdNode[][][] }} MdElement
 * @typedef {{ version: string, published?: string, deprecated?: string,
 *   blocked?: { reason: string, allowedAfter?: string } }} CatalogVersion
 * @typedef {CatalogVersion & { publisher?: string, license?: string,
 *   dependencies: Array<{ kind: string, entries: Array<{ name: string, range: string }> }>,
 *   download?: { url: string, integrity?: string } }} VersionDetail
 * @typedef {{ name: string, description?: string, license?: string, keywords: string[],
 *   maintainers: string[], links: { homepage?: string, repository?: string, bugs?: string },
 *   distTags: Array<{ tag: string, version: string }>, versions: CatalogVersion[],
 *   versionCount: number, selected: VersionDetail | null,
 *   install: Array<{ label: string, command: string }> }} CatalogPackage
 * @typedef {{ total: number, results: Array<{ name: string, version: string,
 *   description?: string, date?: string }> }} SearchResult
 * @typedef {{ user: string | null, authRequired: boolean, loginAvailable: boolean,
 *   images: boolean, stats: boolean }} Session
 * @typedef {{ t: number, requests: number, classes: Record<string, number>,
 *   hitRatio: number | null, upstreamRequests: number, upstreamErrors: number, blocked: number,
 *   latency: { p50: number, p95: number, p99: number } | null }} StatsBucket
 * @typedef {{ range: string, from: number, to: number, step: number, pods: string[],
 *   truncated: boolean, totals: StatsBucket, series: StatsBucket[],
 *   perPod: Record<string, Array<{ t: number, rss: number, heap: number }>> }} StatsResponse
 */

const BASE = '/-/web';

/** @param {string} id */
function byId(id) {
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
function h(tag, attrs = {}, children = []) {
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

/** @param {string} value @param {boolean} [mail] */
function safeUrl(value, mail = false) {
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
function externalLink(url, children) {
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
 */
function internalLink(path, children) {
  const a = h('a', { 'data-route': '' }, children);
  a.setAttribute('href', `${BASE}${path}`);
  return a;
}

/** @param {string | undefined} iso */
function formatDate(iso) {
  if (iso === undefined) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

/** @param {string} message */
function announce(message) {
  byId('status').textContent = message;
}

class HttpError extends Error {
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
async function api(path) {
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

// ---- README ------------------------------------------------------------------------------

/**
 * @param {MdNode[]} nodes
 * @param {boolean} images
 * @returns {Node[]}
 */
function renderMarkdown(nodes, images) {
  return nodes.map((n) => renderNode(n, images));
}

/**
 * @param {MdNode} node
 * @param {boolean} images
 * @returns {Node}
 */
function renderNode(node, images) {
  if (typeof node === 'string') return document.createTextNode(node);
  /** @param {MdNode[]} c */
  const kids = (c) => renderMarkdown(c, images);
  switch (node.t) {
    case 'h':
      // The package name is the page's h1: README headings start one level lower.
      return h(`h${String(Math.min(6, Math.max(2, node.l + 1)))}`, {}, kids(node.c));
    case 'p':
      return h('p', {}, kids(node.c));
    case 'em':
      return h('em', {}, kids(node.c));
    case 'strong':
      return h('strong', {}, kids(node.c));
    case 'del':
      return h('del', {}, kids(node.c));
    case 'quote':
      return h('blockquote', {}, kids(node.c));
    case 'code':
      return h('code', {}, [node.code]);
    case 'pre':
      return h('pre', {}, [h('code', {}, [node.code])]);
    case 'a':
      return externalLink(node.href, kids(node.c));
    case 'img': {
      const src = images ? safeUrl(node.src) : null;
      if (src === null || !src.startsWith('https:')) return document.createTextNode(node.alt);
      const img = h('img', { alt: node.alt, loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.setAttribute('src', src);
      return img;
    }
    case 'ul':
      return h(
        'ul',
        {},
        node.items.map((item) => listItem(item, images)),
      );
    case 'ol':
      return h(
        'ol',
        { start: String(node.start) },
        node.items.map((item) => listItem(item, images)),
      );
    case 'hr':
      return h('hr');
    case 'br':
      return h('br');
    case 'table':
      return h('table', {}, [
        h('thead', {}, [
          h(
            'tr',
            {},
            node.head.map((c) => h('th', { scope: 'col' }, kids(c))),
          ),
        ]),
        h(
          'tbody',
          {},
          node.rows.map((row) =>
            h(
              'tr',
              {},
              row.map((c) => h('td', {}, kids(c))),
            ),
          ),
        ),
      ]);
    default:
      return document.createTextNode('');
  }
}

/** A tight list item: a single paragraph renders without the <p>. */
/** @param {MdNode[]} item @param {boolean} images */
function listItem(item, images) {
  const only = item.length === 1 ? item[0] : undefined;
  if (only !== undefined && typeof only !== 'string' && only.t === 'p') {
    return h('li', {}, renderMarkdown(only.c, images));
  }
  return h('li', {}, renderMarkdown(item, images));
}

// ---- Pages -------------------------------------------------------------------------------

/** @type {Session} */
let session = {
  user: null,
  authRequired: false,
  loginAvailable: false,
  images: false,
  stats: false,
};

/** @param {Array<Node | null>} nodes @param {string} title */
function show(nodes, title) {
  const main = byId('main');
  main.replaceChildren(...nodes.filter((n) => n !== null));
  document.title = `${title} - Package catalog`;
  main.focus();
  announce(title);
}

function renderAccount() {
  const nav = byId('account');
  const statsLink = session.stats ? [internalLink('/stats', ['Statistics'])] : [];
  if (session.user !== null) {
    const form = h('form', { method: 'post', action: `${BASE}/logout` }, [
      h('button', { type: 'submit', class: 'secondary' }, ['Sign out']),
    ]);
    nav.replaceChildren(
      ...statsLink,
      h('span', { class: 'muted' }, [`Signed in as ${session.user}`]),
      form,
    );
  } else if (session.loginAvailable) {
    nav.replaceChildren(...statsLink, internalLink('/login', ['Sign in']));
  } else {
    nav.replaceChildren(...statsLink);
  }
}

/** @param {unknown} err */
function showError(err) {
  if (err instanceof HttpError && err.status === 401 && session.loginAvailable) {
    void navigate(`${BASE}/login`, true);
    return;
  }
  const message =
    err instanceof HttpError && err.status === 404
      ? 'Not found.'
      : err instanceof HttpError && err.status === 403
        ? 'You do not have access to this.'
        : err instanceof HttpError && err.status === 401
          ? 'Sign-in required.'
          : 'Something went wrong. Try again later.';
  show([h('h1', {}, ['Error']), h('p', { class: 'error' }, [message])], 'Error');
}

function homePage() {
  show(
    [
      h('h1', {}, ['Package catalog']),
      h('p', { class: 'muted' }, [
        'Search the packages this registry serves: its own and the ones it caches. Versions the registry policy holds back are shown with the reason.',
      ]),
    ],
    'Home',
  );
  byId('q').focus();
}

/** @param {URLSearchParams} params */
async function searchPage(params) {
  const text = (params.get('q') ?? '').trim();
  const input = /** @type {HTMLInputElement} */ (byId('q'));
  input.value = text;
  if (text === '') {
    homePage();
    return;
  }
  /** @type {SearchResult} */
  const found = await api(`search?${new URLSearchParams({ text, size: '50' }).toString()}`);
  const items = found.results.map((r) =>
    h('li', {}, [
      h('div', {}, [
        internalLink(`/package/${r.name}`, [h('span', { class: 'name' }, [r.name])]),
        ' ',
        h('span', { class: 'muted' }, [r.version]),
      ]),
      r.description !== undefined ? h('div', {}, [r.description]) : null,
      r.date !== undefined
        ? h('div', { class: 'muted' }, [`Published ${formatDate(r.date)}`])
        : null,
    ]),
  );
  show(
    [
      h('h1', {}, [`Results for "${text}"`]),
      h('p', { class: 'muted' }, [`${String(found.total)} packages`]),
      items.length > 0 ? h('ul', { class: 'results' }, items) : h('p', {}, ['Nothing found.']),
    ],
    `Search: ${text}`,
  );
}

/** @param {string} name @param {string | null} version */
async function packagePage(name, version) {
  const query = version !== null ? `?${new URLSearchParams({ version }).toString()}` : '';
  /** @type {CatalogPackage} */
  const pkg = await api(`package/${encodeURIComponent(name)}${query}`);
  /** @type {{ nodes: MdNode[], truncated: boolean }} */
  let readme = { nodes: [], truncated: false };
  try {
    readme = await api(`readme/${encodeURIComponent(name)}`);
  } catch {
    // the package page works without its README
  }
  const sel = pkg.selected;

  const notices = [];
  if (sel?.blocked) {
    const after =
      sel.blocked.allowedAfter !== undefined
        ? ` Allowed after ${new Date(sel.blocked.allowedAfter).toLocaleString()}.`
        : '';
    notices.push(
      h('p', { class: 'notice blocked', role: 'note' }, [
        `Version ${sel.version} is blocked by the registry policy: ${sel.blocked.reason}.${after}`,
      ]),
    );
  }
  if (sel?.deprecated !== undefined) {
    notices.push(
      h('p', { class: 'notice deprecated', role: 'note' }, [
        `Version ${sel.version} is deprecated: ${sel.deprecated}`,
      ]),
    );
  }

  const readmeSection = h('section', { class: 'readme', 'aria-labelledby': 'readme-title' }, [
    h('h2', { id: 'readme-title', class: 'visually-hidden' }, ['Readme']),
    ...(readme.nodes.length > 0
      ? renderMarkdown(readme.nodes, session.images)
      : [h('p', { class: 'muted' }, ['This package has no README.'])]),
    readme.truncated ? h('p', { class: 'muted' }, ['The README was shortened.']) : null,
  ]);

  const versionRows = pkg.versions.map((v) =>
    h('tr', {}, [
      h('td', {}, [
        internalLink(`/package/${pkg.name}?version=${encodeURIComponent(v.version)}`, [v.version]),
      ]),
      h('td', {}, [formatDate(v.published)]),
      h('td', {}, [
        v.blocked
          ? h('span', { class: 'badge blocked', title: v.blocked.reason }, ['blocked'])
          : '',
      ]),
    ]),
  );
  const versionsSection = h('section', { 'aria-labelledby': 'versions-title' }, [
    h('h2', { id: 'versions-title' }, [`Versions (${String(pkg.versionCount)})`]),
    h('table', {}, [
      h('thead', {}, [
        h('tr', {}, [
          h('th', { scope: 'col' }, ['Version']),
          h('th', { scope: 'col' }, ['Published']),
          h('th', { scope: 'col' }, ['Status']),
        ]),
      ]),
      h('tbody', {}, versionRows),
    ]),
    pkg.versionCount > pkg.versions.length
      ? h('p', { class: 'muted' }, [`Showing the newest ${String(pkg.versions.length)}.`])
      : null,
  ]);

  const dependencySection =
    sel && sel.dependencies.length > 0
      ? h('section', { 'aria-labelledby': 'deps-title' }, [
          h('h2', { id: 'deps-title' }, [`Dependencies of ${sel.version}`]),
          ...sel.dependencies.flatMap((group) => [
            h('h3', {}, [group.kind]),
            h(
              'ul',
              {},
              group.entries.map((d) =>
                h('li', {}, [
                  internalLink(`/package/${d.name}`, [d.name]),
                  ' ',
                  h('code', {}, [d.range]),
                ]),
              ),
            ),
          ]),
        ])
      : null;

  /** @type {Array<Node | null>} */
  const aside = [];
  if (pkg.install.length > 0) {
    aside.push(
      h('section', {}, [
        h('h2', {}, ['Install']),
        ...pkg.install.map((cmd) => {
          const button = h(
            'button',
            { type: 'button', class: 'secondary', 'aria-label': `Copy ${cmd.label} command` },
            ['Copy'],
          );
          button.addEventListener('click', () => {
            void navigator.clipboard.writeText(cmd.command).then(() => {
              announce('Copied');
            });
          });
          return h('div', { class: 'install' }, [h('code', {}, [cmd.command]), button]);
        }),
      ]),
    );
  }
  const facts = [];
  if (sel)
    facts.push(
      h('li', {}, [
        `Version ${sel.version}`,
        sel.published ? `, ${formatDate(sel.published)}` : '',
      ]),
    );
  if (pkg.license !== undefined) facts.push(h('li', {}, [`License: ${pkg.license}`]));
  if (sel?.publisher !== undefined) facts.push(h('li', {}, [`Published by ${sel.publisher}`]));
  if (pkg.maintainers.length > 0)
    facts.push(h('li', {}, [`Maintainers: ${pkg.maintainers.join(', ')}`]));
  if (sel?.download) {
    facts.push(h('li', {}, [externalLink(sel.download.url, ['Download tarball'])]));
  }
  aside.push(h('section', {}, [h('h2', {}, ['Details']), h('ul', {}, facts)]));
  const links = [];
  if (pkg.links.homepage !== undefined)
    links.push(h('li', {}, [externalLink(pkg.links.homepage, ['Homepage'])]));
  if (pkg.links.repository !== undefined)
    links.push(h('li', {}, [externalLink(pkg.links.repository, ['Repository'])]));
  if (pkg.links.bugs !== undefined)
    links.push(h('li', {}, [externalLink(pkg.links.bugs, ['Issues'])]));
  if (links.length > 0) aside.push(h('section', {}, [h('h2', {}, ['Links']), h('ul', {}, links)]));
  if (pkg.distTags.length > 0) {
    aside.push(
      h('section', {}, [
        h('h2', {}, ['Tags']),
        h(
          'ul',
          {},
          pkg.distTags.map((t) =>
            h('li', {}, [
              `${t.tag}: `,
              internalLink(`/package/${pkg.name}?version=${encodeURIComponent(t.version)}`, [
                t.version,
              ]),
            ]),
          ),
        ),
      ]),
    );
  }
  if (pkg.keywords.length > 0) {
    aside.push(
      h('section', {}, [h('h2', {}, ['Keywords']), h('p', {}, [pkg.keywords.join(', ')])]),
    );
  }

  show(
    [
      h('h1', {}, [pkg.name]),
      pkg.description !== undefined ? h('p', {}, [pkg.description]) : null,
      sel === null
        ? h('p', { class: 'error' }, [`Version ${version ?? ''} does not exist.`])
        : null,
      ...notices,
      h('div', { class: 'package' }, [
        h('div', {}, [readmeSection, versionsSection, dependencySection]),
        h('aside', { class: 'meta', 'aria-label': 'Package details' }, aside),
      ]),
    ],
    pkg.name,
  );
}

/** @param {URLSearchParams} params */
function loginPage(params) {
  if (!session.loginAvailable) {
    show(
      [h('h1', {}, ['Sign in']), h('p', {}, ['Sign-in is not available on this registry.'])],
      'Sign in',
    );
    return;
  }
  const failed = params.get('failed') !== null;
  const form = h('form', { class: 'login', method: 'post', action: `${BASE}/login` }, [
    h('label', { for: 'login-name' }, ['User name']),
    h('input', {
      id: 'login-name',
      name: 'name',
      autocomplete: 'username',
      required: '',
      maxlength: '256',
    }),
    h('label', { for: 'login-password' }, ['Password']),
    h('input', {
      id: 'login-password',
      name: 'password',
      type: 'password',
      autocomplete: 'current-password',
      required: '',
      maxlength: '1024',
    }),
    h('button', { type: 'submit' }, ['Sign in']),
  ]);
  show(
    [
      h('h1', {}, ['Sign in']),
      failed
        ? h('p', { class: 'error', role: 'alert' }, [
            'Sign-in failed. Check your user name and password.',
          ])
        : null,
      form,
    ],
    'Sign in',
  );
  byId('login-name').focus();
}

// ---- Statistics --------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const STATS_RANGES = ['1h', '24h', '7d', '30d', '90d', '1y'];
const CHART_W = 640;
const CHART_H = 220;
const PAD = { left: 52, right: 12, top: 10, bottom: 28 };
const SERIES_CLASSES = 8;

/**
 * An SVG element. Colors and dashes come from the stylesheet classes (the CSP forbids inline
 * styles); `attrs` carries only numbers, ids and class names computed here.
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {Array<Node | string>} [children]
 */
function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (/^on/i.test(k) || k === 'href' || k === 'src') throw new Error(`unsafe attribute ${k}`);
    node.setAttribute(k, v);
  }
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

/** @param {number} max */
function niceMax(max) {
  if (!(max > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= max) return m * exp;
  return 10 * exp;
}

/**
 * @param {number} value
 * @param {string} unit
 */
function formatValue(value, unit) {
  if (unit === '%') return `${(value * 100).toFixed(value >= 0.995 ? 0 : 1)}%`;
  if (unit === 'ms') return `${String(Math.round(value * 1000))} ms`;
  if (unit === 'MiB') return `${(value / 1048576).toFixed(value < 10485760 ? 1 : 0)} MiB`;
  if (unit === '/s') return `${value >= 10 ? String(Math.round(value)) : value.toFixed(2)}/s`;
  return String(Math.round(value * 100) / 100);
}

/** @param {number} sec @param {string} range */
function formatTime(sec, range) {
  const d = new Date(sec * 1000);
  return range === '1h' || range === '24h'
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * @typedef {{ label: string, points: Array<{ t: number, v: number }> }} ChartSeries
 * @typedef {{ id: string, title: string, unit: string, series: ChartSeries[] }} ChartSpec
 */

/**
 * One line chart with a legend and a table fallback.
 * @param {ChartSpec} spec
 * @param {StatsResponse} data
 */
function chart(spec, data) {
  const nonEmpty = spec.series.filter((s) => s.points.length > 0);
  const figure = h('figure', { class: 'chart' });
  figure.append(h('h2', { id: `${spec.id}-title` }, [spec.title]));
  if (nonEmpty.length === 0) {
    figure.append(h('p', { class: 'muted' }, ['No data in this range.']));
    return figure;
  }
  const plotW = CHART_W - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const max =
    spec.unit === '%'
      ? 1
      : niceMax(Math.max(...nonEmpty.flatMap((s) => s.points.map((p) => p.v)), 0));
  const span = Math.max(1, data.to - data.from);
  /** @param {number} t */
  const x = (t) => PAD.left + (Math.min(Math.max(t - data.from, 0), span) / span) * plotW;
  /** @param {number} v */
  const y = (v) => PAD.top + plotH - (Math.min(Math.max(v, 0), max) / max) * plotH;
  const summary = nonEmpty
    .map((s) => {
      const values = s.points.map((p) => p.v);
      const last = values[values.length - 1] ?? 0;
      return `${s.label}: latest ${formatValue(last, spec.unit)}, highest ${formatValue(Math.max(...values), spec.unit)}`;
    })
    .join('. ');
  const root = svg('svg', {
    viewBox: `0 0 ${String(CHART_W)} ${String(CHART_H)}`,
    role: 'img',
    'aria-labelledby': `${spec.id}-title ${spec.id}-desc`,
    class: 'plot',
  });
  root.append(svg('title', {}, [spec.title]), svg('desc', { id: `${spec.id}-desc` }, [summary]));
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    root.append(
      svg('line', {
        class: 'grid',
        x1: String(PAD.left),
        x2: String(CHART_W - PAD.right),
        y1: y(v).toFixed(1),
        y2: y(v).toFixed(1),
      }),
      svg('text', { class: 'tick end', x: String(PAD.left - 6), y: (y(v) + 4).toFixed(1) }, [
        formatValue(v, spec.unit),
      ]),
    );
  }
  root.append(
    svg('text', { class: 'tick', x: String(PAD.left), y: String(CHART_H - 8) }, [
      formatTime(data.from, data.range),
    ]),
    svg('text', { class: 'tick end', x: String(CHART_W - PAD.right), y: String(CHART_H - 8) }, [
      formatTime(data.to, data.range),
    ]),
  );
  nonEmpty.forEach((s, i) => {
    const cls = `s${String(i % SERIES_CLASSES)}`;
    let d = '';
    let prev = -Infinity;
    for (const p of s.points) {
      d += `${p.t - prev > data.step * 2.5 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)} `;
      prev = p.t;
    }
    root.append(svg('path', { class: `line ${cls}`, d: d.trim().replace(/^L/, 'M') }));
    if (s.points.length <= 40) {
      for (const p of s.points) {
        root.append(
          svg('circle', {
            class: `dot ${cls}`,
            cx: x(p.t).toFixed(1),
            cy: y(p.v).toFixed(1),
            r: '2.5',
          }),
        );
      }
    }
  });
  figure.append(root);
  figure.append(
    h(
      'ul',
      { class: 'legend' },
      nonEmpty.map((s, i) =>
        h('li', {}, [
          h('span', { class: `swatch s${String(i % SERIES_CLASSES)}`, 'aria-hidden': 'true' }),
          s.label,
        ]),
      ),
    ),
  );
  const details = h('details', { class: 'chart-table' }, [h('summary', {}, ['Show as table'])]);
  let built = false;
  details.addEventListener('toggle', () => {
    if (!(details instanceof HTMLDetailsElement) || !details.open || built) return;
    built = true;
    details.append(dataTable(spec, nonEmpty));
  });
  figure.append(details);
  return figure;
}

/**
 * @param {ChartSpec} spec
 * @param {ChartSeries[]} series
 */
function dataTable(spec, series) {
  /** @type {Map<number, Map<number, number>>} */
  const rows = new Map();
  series.forEach((s, i) => {
    for (const p of s.points) {
      /** @type {Map<number, number>} */
      const row = rows.get(p.t) ?? new Map();
      row.set(i, p.v);
      rows.set(p.t, row);
    }
  });
  const times = [...rows.keys()].sort((a, b) => b - a);
  const table = h('table', {}, [
    h('caption', { class: 'visually-hidden' }, [spec.title]),
    h('thead', {}, [
      h('tr', {}, [
        h('th', { scope: 'col' }, ['Time']),
        ...series.map((s) => h('th', { scope: 'col' }, [s.label])),
      ]),
    ]),
    h(
      'tbody',
      {},
      times.map((t) =>
        h('tr', {}, [
          h('th', { scope: 'row' }, [new Date(t * 1000).toLocaleString()]),
          ...series.map((_, i) => {
            const v = rows.get(t)?.get(i);
            return h('td', {}, [v === undefined ? '' : formatValue(v, spec.unit)]);
          }),
        ]),
      ),
    ),
  ]);
  return h('div', { class: 'table-scroll', tabindex: '0' }, [table]);
}

/** @param {string} range */
async function statsPage(range) {
  const chosen = STATS_RANGES.includes(range) ? range : '24h';
  /** @type {StatsResponse} */
  const data = await api(`stats?${new URLSearchParams({ range: chosen }).toString()}`);
  const step = data.step;
  const stepLabel = step >= 3600 ? `${String(step / 3600)} h` : `${String(step / 60)} min`;
  /** @param {(b: StatsBucket) => number | null} f */
  const line = (f) =>
    data.series.flatMap((b) => {
      const v = f(b);
      return v === null ? [] : [{ t: b.t, v }];
    });
  const rangeNav = h(
    'nav',
    { 'aria-label': 'Time range', class: 'range-nav' },
    STATS_RANGES.map((r) => {
      const a = internalLink(`/stats?range=${r}`, [r]);
      if (r === chosen) a.setAttribute('aria-current', 'page');
      return a;
    }),
  );
  const pods = Object.entries(data.perPod).slice(0, SERIES_CLASSES);
  const t = data.totals;
  const hit = t.hitRatio === null ? 'no cache traffic' : formatValue(t.hitRatio, '%');
  show(
    [
      h('h1', {}, ['Statistics']),
      h('p', { class: 'muted' }, [
        `Last ${chosen}, ${String(data.pods.length)} ${data.pods.length === 1 ? 'pod' : 'pods'}. ` +
          `${String(t.requests)} requests, hit ratio ${hit}, ${String(t.upstreamRequests)} upstream fetches, ${String(t.blocked)} blocked versions.`,
      ]),
      rangeNav,
      data.truncated
        ? h('p', { class: 'notice deprecated' }, [
            'Part of this range was left out to bound the work.',
          ])
        : null,
      chart(
        {
          id: 'c-rate',
          title: 'Requests per second',
          unit: '/s',
          series: [
            { label: 'All requests', points: line((b) => b.requests / step) },
            { label: 'Server errors (5xx)', points: line((b) => (b.classes['5xx'] ?? 0) / step) },
          ],
        },
        data,
      ),
      chart(
        {
          id: 'c-hit',
          title: 'Cache hit ratio',
          unit: '%',
          series: [{ label: 'Hit ratio', points: line((b) => b.hitRatio) }],
        },
        data,
      ),
      chart(
        {
          id: 'c-upstream',
          title: `Upstream fetches and errors per ${stepLabel}`,
          unit: '',
          series: [
            { label: 'Fetches', points: line((b) => b.upstreamRequests) },
            { label: 'Errors', points: line((b) => b.upstreamErrors) },
          ],
        },
        data,
      ),
      chart(
        {
          id: 'c-blocked',
          title: `Blocked versions per ${stepLabel}`,
          unit: '',
          series: [{ label: 'Blocked', points: line((b) => b.blocked) }],
        },
        data,
      ),
      chart(
        {
          id: 'c-latency',
          title: 'Request latency p95 (worst pod and route)',
          unit: 'ms',
          series: [{ label: 'p95', points: line((b) => b.latency?.p95 ?? null) }],
        },
        data,
      ),
      chart(
        {
          id: 'c-memory',
          title: 'Memory per pod (resident set)',
          unit: 'MiB',
          series: pods.map(([name, points]) => ({
            label: name,
            points: points.map((p) => ({ t: p.t, v: p.rss })),
          })),
        },
        data,
      ),
    ],
    'Statistics',
  );
}

/**
 * @param {string} href
 * @param {boolean} [replace]
 */
async function navigate(href, replace = false) {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  await route();
}

async function route() {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  try {
    if (path === `${BASE}/search`) await searchPage(params);
    else if (path === `${BASE}/login`) loginPage(params);
    else if (path === `${BASE}/stats`) await statsPage(params.get('range') ?? '24h');
    else if (path.startsWith(`${BASE}/package/`)) {
      const name = decodeURIComponent(path.slice(`${BASE}/package/`.length));
      await packagePage(name, params.get('version'));
    } else homePage();
  } catch (err) {
    showError(err);
  }
}

async function start() {
  try {
    session = await api('session');
  } catch {
    // keep the anonymous defaults
  }
  renderAccount();
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('a[data-route]') : null;
    if (!(target instanceof HTMLAnchorElement) || event.metaKey || event.ctrlKey || event.shiftKey)
      return;
    event.preventDefault();
    void navigate(target.href);
  });
  const searchForm = document.querySelector('form.search');
  searchForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = /** @type {HTMLInputElement} */ (byId('q')).value;
    void navigate(`${BASE}/search?${new URLSearchParams({ q }).toString()}`);
  });
  window.addEventListener('popstate', () => {
    void route();
  });
  await route();
}

void start();

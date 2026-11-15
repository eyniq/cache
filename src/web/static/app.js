// @ts-check
/* global document, window, location, history, navigator */
// Read-only package catalog (C5). Plain ES modules, no dependencies, no build step: this one
// holds the shell (navigation, account, router) and the catalog pages (search, package,
// sign-in); dom.js the DOM helpers, dashboard.js the dashboard and the statistics page,
// charts.js the SVG charts and metrics.js their logic. Every piece of server data becomes DOM
// through createElement and text nodes; nothing is ever assigned as HTML.
import {
  BASE,
  HttpError,
  announce,
  api,
  byId,
  externalLink,
  h,
  icon,
  internalLink,
  safeUrl,
  statusLabel,
} from './dom.js';
import { homePage, statsPage, stopLive } from './dashboard.js';
import { formatAge, formatBytes, formatCount } from './metrics.js';

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
 *   download?: { url: string, integrity?: string },
 *   size?: { unpackedBytes?: number, files?: number } }} VersionDetail
 * @typedef {{ name: string, description?: string, license?: string, keywords: string[],
 *   maintainers: string[], links: { homepage?: string, repository?: string, bugs?: string },
 *   distTags: Array<{ tag: string, version: string }>, versions: CatalogVersion[],
 *   versionCount: number, selected: VersionDetail | null,
 *   install: Array<{ label: string, command: string }> }} CatalogPackage
 * @typedef {{ total: number, results: Array<{ name: string, version: string,
 *   description?: string, date?: string, heldBack?: boolean }> }} SearchResult
 * @typedef {{ user: string | null, authRequired: boolean, loginAvailable: boolean,
 *   images: boolean, stats: boolean }} Session
 */

/** @param {string | undefined} iso */
function formatDate(iso) {
  if (iso === undefined) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "3 d ago" for a past moment, "in 2 d" for a coming one; '' when unknown. */
/** @param {string | undefined} iso */
function relative(iso) {
  if (iso === undefined) return '';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const seconds = (Date.now() - ms) / 1000;
  if (seconds >= 0) return formatAge(seconds);
  const ahead = formatAge(-seconds);
  return ahead === 'just now' ? 'in a moment' : `in ${ahead.replace(' ago', '')}`;
}

/** A date with its age as a <time> element. @param {string | undefined} iso */
function dated(iso) {
  if (iso === undefined || formatDate(iso) === '') return null;
  return h('time', { datetime: iso, title: new Date(iso).toLocaleString() }, [
    `${formatDate(iso)} (${relative(iso)})`,
  ]);
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

// ---- Shell -------------------------------------------------------------------------------

/** @type {Session} */
let session = {
  user: null,
  authRequired: false,
  loginAvailable: false,
  images: false,
  stats: false,
};

/** Counts navigations, so a page that finishes loading late does not replace a newer one. */
let visit = 0;

/**
 * @param {Array<Node | null>} nodes
 * @param {string} title
 * @param {boolean} [home] the search-first home has its own search; the app bar's is hidden
 */
function show(nodes, title, home = false) {
  const main = byId('main');
  main.replaceChildren(...nodes.filter((n) => n !== null));
  document.body.classList.toggle('home', home);
  document.title = `${title} - Eyniq Cache`;
  // A new page starts at the top; focusing must not scroll it under the sticky app bar.
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
  announce(title);
}

/** A short confirmation in the floating layer (also announced). @param {string} message */
function toast(message) {
  const node = byId('toast');
  node.textContent = message;
  node.setAttribute('data-open', '');
  announce(message);
  window.setTimeout(() => {
    node.removeAttribute('data-open');
  }, 2000);
}

/** The main navigation: a rail next to the page, a floating bar on phones (same links). */
function renderNav() {
  const path = location.pathname;
  /** @type {Array<{ path: string, label: string, name: 'dashboard' | 'search' | 'chart' | 'user', on: boolean }>} */
  const items = [
    {
      path: '/',
      label: session.stats ? 'Dashboard' : 'Home',
      name: 'dashboard',
      on: path === `${BASE}/` || path === BASE,
    },
    {
      path: '/search',
      label: 'Packages',
      name: 'search',
      on: path === `${BASE}/search` || path.startsWith(`${BASE}/package/`),
    },
  ];
  if (session.stats) {
    items.push({
      path: '/stats',
      label: 'Statistics',
      name: 'chart',
      on: path === `${BASE}/stats`,
    });
  }
  if (session.user === null && session.loginAvailable) {
    items.push({ path: '/login', label: 'Sign in', name: 'user', on: path === `${BASE}/login` });
  }
  byId('nav').replaceChildren(
    h(
      'ul',
      {},
      items.map((item) => {
        const a = internalLink(item.path, [
          h('span', { class: 'indicator' }, [icon(item.name)]),
          h('span', { class: 'nav-label' }, [item.label]),
        ]);
        if (item.on) a.setAttribute('aria-current', 'page');
        return h('li', {}, [a]);
      }),
    ),
  );
}

function renderAccount() {
  const nav = byId('account');
  if (session.user !== null) {
    const form = h('form', { method: 'post', action: `${BASE}/logout` }, [
      h('button', { type: 'submit', class: 'secondary' }, ['Sign out']),
    ]);
    nav.replaceChildren(
      h('span', { class: 'muted who' }, ['Signed in as ', h('strong', {}, [session.user])]),
      form,
    );
  } else if (session.loginAvailable) {
    const a = internalLink('/login', ['Sign in']);
    a.classList.add('button');
    nav.replaceChildren(a);
  } else {
    nav.replaceChildren();
  }
}

/** @param {unknown} err */
function showError(err) {
  if (err instanceof HttpError && err.status === 401 && session.loginAvailable) {
    void navigate(`${BASE}/login`, true);
    return;
  }
  const [title, message] =
    err instanceof HttpError && err.status === 404
      ? ['Not found', 'This page or package does not exist on this registry.']
      : err instanceof HttpError && err.status === 403
        ? ['No access', 'You do not have access to this.']
        : err instanceof HttpError && err.status === 401
          ? ['Sign-in required', 'This registry needs a sign-in, and none is available here.']
          : ['Something went wrong', 'Try again later.'];
  show(
    [
      h('section', { class: 'card empty-state' }, [
        h('h1', {}, [title]),
        h('p', { class: 'error' }, [message]),
        h('p', {}, [internalLink('/', ['Back to the start page'])]),
      ]),
    ],
    'Error',
  );
}

/** @param {string} id */
function searchForm(id) {
  return h(
    'form',
    { class: 'search hero-search', role: 'search', action: `${BASE}/search`, method: 'get' },
    [
      h('label', { class: 'visually-hidden', for: id }, ['Search packages']),
      h('input', {
        id,
        name: 'q',
        type: 'search',
        placeholder: 'Search packages',
        maxlength: '512',
        autocomplete: 'off',
      }),
      h('button', { type: 'submit' }, ['Search']),
    ],
  );
}

/** The search-first start page: used without statistics, and when they cannot be shown. */
function searchHome() {
  show(
    [
      h('section', { class: 'hero' }, [
        h('h1', {}, ['Package catalog']),
        h('p', { class: 'muted' }, [
          'Search the packages this registry serves: its own and the ones it caches. Versions the registry policy holds back are shown with the reason.',
        ]),
        searchForm('q-home'),
      ]),
    ],
    'Home',
    true,
  );
  byId('q-home').focus();
}

/** @param {string} title */
function skeleton(title) {
  return [
    h('div', { 'aria-busy': 'true' }, [
      h('h1', {}, [title]),
      h('p', { class: 'visually-hidden' }, ['Loading']),
      h('div', { class: 'skeleton lines', 'aria-hidden': 'true' }, [
        h('div', { class: 'card' }),
        h('div', { class: 'card' }),
        h('div', { class: 'card' }),
      ]),
    ]),
  ];
}

// ---- Search ------------------------------------------------------------------------------

/** @param {URLSearchParams} params @param {() => boolean} current */
async function searchPage(params, current) {
  const text = (params.get('q') ?? '').trim();
  const input = /** @type {HTMLInputElement} */ (byId('q'));
  input.value = text;
  if (text === '') {
    searchHome();
    return;
  }
  show(skeleton(`Results for "${text}"`), `Search: ${text}`);
  /** @type {SearchResult} */
  const found = await api(`search?${new URLSearchParams({ text, size: '50' }).toString()}`);
  if (!current()) return;
  const items = found.results.map((r) =>
    h('li', { class: 'card result' }, [
      h('div', { class: 'result-head' }, [
        internalLink(`/package/${r.name}`, [h('span', { class: 'name' }, [r.name])]),
        h('span', { class: 'chip mono', title: 'Newest version this registry serves' }, [
          r.version,
        ]),
        r.heldBack === true
          ? statusLabel(
              'warning',
              'Versions held back',
              'The registry policy blocks one or more versions of this package; its page lists them with the reason',
            )
          : null,
      ]),
      r.description !== undefined
        ? h('p', { class: 'result-text' }, [r.description])
        : h('p', { class: 'result-text muted' }, ['No description.']),
      r.date !== undefined
        ? h('p', { class: 'muted result-meta' }, ['Published ', dated(r.date)])
        : null,
    ]),
  );
  const shown = found.results.length;
  show(
    [
      h('header', { class: 'page-head' }, [
        h('div', { class: 'page-title' }, [h('h1', {}, [`Results for "${text}"`])]),
        h('p', { class: 'muted page-sub' }, [
          found.total > shown
            ? `Showing ${String(shown)} of ${formatCount(found.total)} packages.`
            : `${formatCount(found.total)} ${found.total === 1 ? 'package' : 'packages'}.`,
          found.results.some((r) => r.heldBack === true)
            ? ' "Versions held back" is only known for packages this registry has in memory.'
            : '',
        ]),
      ]),
      items.length > 0
        ? h('ul', { class: 'results' }, items)
        : h('section', { class: 'card empty-state' }, [
            h('h2', {}, ['Nothing found']),
            h('p', { class: 'muted' }, [
              'No package matches this search. Check the spelling or try fewer words.',
            ]),
          ]),
    ],
    `Search: ${text}`,
  );
}

// ---- Package -----------------------------------------------------------------------------

const TIMELINE_FIRST = 25;

/** @param {NonNullable<CatalogVersion['blocked']>} blocked */
function blockedLabel(blocked) {
  const after =
    blocked.allowedAfter !== undefined
      ? `Allowed ${relative(blocked.allowedAfter)} (${new Date(blocked.allowedAfter).toLocaleString()})`
      : 'No date at which it becomes allowed';
  return statusLabel(
    'error',
    `Blocked: ${blocked.reason.replace(/^blocked by (the )?/i, '').slice(0, 48)}`,
    `${blocked.reason}. ${after}`,
  );
}

/**
 * @param {CatalogPackage} pkg
 * @param {CatalogVersion} v
 * @param {Map<string, string[]>} tagsOf
 */
function timelineItem(pkg, v, tagsOf) {
  const selected = pkg.selected?.version === v.version;
  const link = internalLink(`/package/${pkg.name}?version=${encodeURIComponent(v.version)}`, [
    v.version,
  ]);
  link.classList.add('mono');
  if (selected) link.setAttribute('aria-current', 'true');
  const state = v.blocked ? 'blocked' : selected ? 'selected' : 'allowed';
  return h('li', { class: `tl-item ${state}` }, [
    h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
    h('div', { class: 'tl-main' }, [
      link,
      ...(tagsOf.get(v.version) ?? []).map((tag) => h('span', { class: 'chip tag' }, [tag])),
      selected ? h('span', { class: 'chip' }, ['shown']) : null,
      v.blocked ? blockedLabel(v.blocked) : null,
    ]),
    h('div', { class: 'tl-when muted' }, [
      dated(v.published) ?? 'No publish date',
      v.blocked?.allowedAfter !== undefined ? `, allowed ${relative(v.blocked.allowedAfter)}` : '',
    ]),
  ]);
}

/** @param {CatalogPackage} pkg */
function versionsSection(pkg) {
  /** @type {Map<string, string[]>} */
  const tagsOf = new Map();
  for (const t of pkg.distTags) tagsOf.set(t.version, [...(tagsOf.get(t.version) ?? []), t.tag]);
  const blockedCount = pkg.versions.filter((v) => v.blocked).length;
  const list = h(
    'ol',
    { class: 'timeline', id: 'versions-list' },
    pkg.versions.slice(0, TIMELINE_FIRST).map((v) => timelineItem(pkg, v, tagsOf)),
  );
  const rest = pkg.versions.slice(TIMELINE_FIRST);
  /** @type {HTMLElement | null} */
  let more = null;
  if (rest.length > 0) {
    const button = h(
      'button',
      { type: 'button', class: 'secondary', 'aria-controls': 'versions-list' },
      [`Show ${String(rest.length)} older versions`],
    );
    button.addEventListener('click', () => {
      list.append(...rest.map((v) => timelineItem(pkg, v, tagsOf)));
      button.remove();
      announce(`${String(rest.length)} older versions added`);
    });
    more = button;
  }
  return h('section', { class: 'card', 'aria-labelledby': 'versions-title' }, [
    h('div', { class: 'panel-head' }, [
      h('h2', { id: 'versions-title' }, ['Versions']),
      h('span', { class: 'panel-figure' }, [
        `${formatCount(pkg.versionCount)} in total`,
        blockedCount > 0 ? `, ${formatCount(blockedCount)} blocked` : '',
      ]),
    ]),
    list,
    more,
    pkg.versionCount > pkg.versions.length
      ? h('p', { class: 'muted' }, [`Only the newest ${String(pkg.versions.length)} are listed.`])
      : null,
  ]);
}

/** @param {VersionDetail} sel */
function dependenciesSection(sel) {
  const total = sel.dependencies.reduce((n, g) => n + g.entries.length, 0);
  if (total === 0) {
    return h('section', { class: 'card', 'aria-labelledby': 'deps-title' }, [
      h('h2', { id: 'deps-title' }, ['Dependencies']),
      h('p', { class: 'muted' }, [`Version ${sel.version} has no dependencies.`]),
    ]);
  }
  /** @type {Record<string, string>} */
  const names = {
    dependencies: 'Runtime',
    peerDependencies: 'Peer',
    optionalDependencies: 'Optional',
    devDependencies: 'Development',
  };
  return h('section', { class: 'card', 'aria-labelledby': 'deps-title' }, [
    h('div', { class: 'panel-head' }, [
      h('h2', { id: 'deps-title' }, [`Dependencies of ${sel.version}`]),
      h('span', { class: 'panel-figure' }, [`${formatCount(total)} in total`]),
    ]),
    ...sel.dependencies.flatMap((group) => [
      h('h3', { class: 'dep-kind' }, [
        names[group.kind] ?? group.kind,
        ' ',
        h('span', { class: 'count' }, [String(group.entries.length)]),
      ]),
      h(
        'ul',
        { class: 'deps' },
        group.entries.map((d) =>
          h('li', {}, [internalLink(`/package/${d.name}`, [d.name]), h('code', {}, [d.range])]),
        ),
      ),
    ]),
  ]);
}

/** @param {CatalogPackage} pkg */
function installSection(pkg) {
  if (pkg.install.length === 0) return null;
  return h('section', { class: 'card', 'aria-labelledby': 'install-title' }, [
    h('h2', { id: 'install-title' }, ['Install']),
    ...pkg.install.map((cmd) => {
      const button = h(
        'button',
        { type: 'button', class: 'secondary', 'aria-label': `Copy the ${cmd.label} command` },
        ['Copy'],
      );
      button.addEventListener('click', () => {
        void navigator.clipboard.writeText(cmd.command).then(
          () => {
            toast(`Copied the ${cmd.label} command`);
          },
          () => {
            toast('Copying is not available here');
          },
        );
      });
      return h('div', { class: 'install' }, [h('code', {}, [cmd.command]), button]);
    }),
  ]);
}

/** @param {CatalogPackage} pkg */
function detailsSection(pkg) {
  const sel = pkg.selected;
  /** @type {Array<[string, Node | string | null]>} */
  const rows = [];
  if (sel) {
    rows.push(['Version', sel.version]);
    rows.push(['Published', dated(sel.published)]);
    if (sel.publisher !== undefined) rows.push(['Published by', sel.publisher]);
  }
  const license = sel?.license ?? pkg.license;
  if (license !== undefined) rows.push(['License', license]);
  if (sel?.size?.unpackedBytes !== undefined) {
    rows.push(['Unpacked size', formatBytes(sel.size.unpackedBytes)]);
  }
  if (sel?.size?.files !== undefined) rows.push(['Files', formatCount(sel.size.files)]);
  if (sel) {
    rows.push([
      'Dependencies',
      formatCount(
        sel.dependencies
          .filter((g) => g.kind !== 'devDependencies')
          .reduce((n, g) => n + g.entries.length, 0),
      ),
    ]);
  }
  rows.push(['Versions', formatCount(pkg.versionCount)]);
  if (sel?.download) {
    rows.push(['Tarball', externalLink(sel.download.url, ['Download'])]);
    if (sel.download.integrity !== undefined) {
      rows.push(['Integrity', h('code', { class: 'integrity' }, [sel.download.integrity])]);
    }
  }
  return h('section', { class: 'card', 'aria-labelledby': 'details-title' }, [
    h('h2', { id: 'details-title' }, ['Details']),
    h(
      'dl',
      { class: 'detail-list' },
      rows
        .filter((r) => r[1] !== null)
        .map(([label, value]) => h('div', {}, [h('dt', {}, [label]), h('dd', {}, [value])])),
    ),
  ]);
}

/** @param {string} name @param {string | null} version @param {() => boolean} current */
async function packagePage(name, version, current) {
  show(skeleton(name), name);
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
  if (!current()) return;
  const sel = pkg.selected;

  const notices = [];
  if (sel?.blocked) {
    const after =
      sel.blocked.allowedAfter !== undefined
        ? ` It becomes allowed ${relative(sel.blocked.allowedAfter)}, on ${new Date(sel.blocked.allowedAfter).toLocaleString()}.`
        : '';
    notices.push(
      h('p', { class: 'notice blocked', role: 'note' }, [
        h('strong', {}, [`Version ${sel.version} is blocked by the registry policy. `]),
        `Reason: ${sel.blocked.reason}.${after} It cannot be installed or downloaded from this registry.`,
      ]),
    );
  }
  if (sel?.deprecated !== undefined) {
    notices.push(
      h('p', { class: 'notice deprecated', role: 'note' }, [
        h('strong', {}, [`Version ${sel.version} is deprecated. `]),
        sel.deprecated,
      ]),
    );
  }

  const blockedCount = pkg.versions.filter((v) => v.blocked).length;
  const head = h('header', { class: 'pkg-head' }, [
    h('h1', { class: 'pkg-name' }, [pkg.name]),
    h('div', { class: 'pkg-labels' }, [
      sel ? h('span', { class: 'chip mono' }, [sel.version]) : null,
      ...pkg.distTags.map((t) => {
        const a = internalLink(`/package/${pkg.name}?version=${encodeURIComponent(t.version)}`, [
          h('span', { class: 'tag-name' }, [t.tag]),
          ` ${t.version}`,
        ]);
        a.classList.add('chip', 'tag');
        return a;
      }),
      (sel?.license ?? pkg.license) !== undefined
        ? h('span', { class: 'chip' }, [sel?.license ?? pkg.license ?? ''])
        : null,
      sel?.blocked
        ? statusLabel('error', 'Blocked')
        : sel?.deprecated !== undefined
          ? statusLabel('warning', 'Deprecated')
          : sel
            ? statusLabel('success', 'Installable')
            : null,
      blockedCount > 0
        ? statusLabel(
            'warning',
            `${formatCount(blockedCount)} ${blockedCount === 1 ? 'version' : 'versions'} held back`,
            'Blocked by the registry policy; see Versions below',
          )
        : null,
    ]),
    pkg.description !== undefined ? h('p', { class: 'pkg-desc' }, [pkg.description]) : null,
  ]);

  const readmeSection = h('section', { class: 'card readme', 'aria-labelledby': 'readme-title' }, [
    h('h2', { id: 'readme-title', class: 'visually-hidden' }, ['Readme']),
    ...(readme.nodes.length > 0
      ? renderMarkdown(readme.nodes, session.images)
      : [h('p', { class: 'muted' }, ['This package has no README.'])]),
    readme.truncated ? h('p', { class: 'muted' }, ['The README was shortened.']) : null,
  ]);

  /** @type {Array<Node | null>} */
  const aside = [installSection(pkg), detailsSection(pkg)];
  const links = [];
  if (pkg.links.homepage !== undefined)
    links.push(h('li', {}, [externalLink(pkg.links.homepage, ['Homepage'])]));
  if (pkg.links.repository !== undefined)
    links.push(h('li', {}, [externalLink(pkg.links.repository, ['Repository'])]));
  if (pkg.links.bugs !== undefined)
    links.push(h('li', {}, [externalLink(pkg.links.bugs, ['Issues'])]));
  if (links.length > 0) {
    aside.push(
      h('section', { class: 'card', 'aria-labelledby': 'links-title' }, [
        h('h2', { id: 'links-title' }, ['Links']),
        h('ul', { class: 'plain' }, links),
      ]),
    );
  }
  if (pkg.maintainers.length > 0) {
    aside.push(
      h('section', { class: 'card', 'aria-labelledby': 'maint-title' }, [
        h('h2', { id: 'maint-title' }, [`Maintainers (${String(pkg.maintainers.length)})`]),
        h(
          'ul',
          { class: 'chips' },
          pkg.maintainers.map((m) => h('li', { class: 'chip' }, [m])),
        ),
      ]),
    );
  }
  if (pkg.keywords.length > 0) {
    aside.push(
      h('section', { class: 'card', 'aria-labelledby': 'kw-title' }, [
        h('h2', { id: 'kw-title' }, ['Keywords']),
        h(
          'ul',
          { class: 'chips' },
          pkg.keywords.map((k) => {
            const a = internalLink(`/search?${new URLSearchParams({ q: k }).toString()}`, [k]);
            a.classList.add('chip');
            return h('li', {}, [a]);
          }),
        ),
      ]),
    );
  }

  show(
    [
      head,
      sel === null
        ? h('p', { class: 'error' }, [`Version ${version ?? ''} does not exist.`])
        : null,
      ...notices,
      h('div', { class: 'package' }, [
        h('div', { class: 'pkg-main' }, [
          readmeSection,
          versionsSection(pkg),
          sel ? dependenciesSection(sel) : null,
        ]),
        h('aside', { class: 'meta', 'aria-label': 'Package details' }, aside),
      ]),
    ],
    pkg.name,
  );
}

// ---- Sign-in -----------------------------------------------------------------------------

/** @param {URLSearchParams} params */
function loginPage(params) {
  const lockup = h('div', { class: 'login-brand', 'aria-hidden': 'true' }, [
    h('span', { class: 'tile' }),
  ]);
  if (!session.loginAvailable) {
    show(
      [
        h('section', { class: 'card login' }, [
          lockup,
          h('h1', {}, ['Sign in']),
          h('p', {}, ['Sign-in is not available on this registry.']),
          h('p', { class: 'muted' }, [
            session.authRequired
              ? 'It accepts registry tokens only; the catalog cannot be opened in a browser.'
              : 'It is open to read: no account is needed to browse the catalog.',
          ]),
          h('p', {}, [internalLink('/', ['Back to the start page'])]),
        ]),
      ],
      'Sign in',
    );
    return;
  }
  const failed = params.get('failed') !== null;
  const form = h('form', { method: 'post', action: `${BASE}/login` }, [
    h('label', { for: 'login-name' }, ['User name']),
    h('input', {
      id: 'login-name',
      name: 'name',
      autocomplete: 'username',
      autocapitalize: 'none',
      spellcheck: 'false',
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
      h('section', { class: 'card login' }, [
        lockup,
        h('h1', {}, ['Sign in']),
        h('p', { class: 'muted' }, [
          'Use your registry account. The sign-in opens this catalog only; npm keeps using its token.',
        ]),
        failed
          ? h('p', { class: 'error', role: 'alert' }, [
              'Sign-in failed. Check your user name and password.',
            ])
          : null,
        form,
      ]),
    ],
    'Sign in',
  );
  byId('login-name').focus();
}

// ---- Router ------------------------------------------------------------------------------

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
  const mine = ++visit;
  const current = () => mine === visit;
  stopLive();
  renderNav();
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  const ui = { show, searchHome, fail: showError, current };
  try {
    if (path === `${BASE}/search`) await searchPage(params, current);
    else if (path === `${BASE}/login`) loginPage(params);
    else if (path === `${BASE}/stats`) await statsPage(params.get('range') ?? '24h', ui);
    else if (path.startsWith(`${BASE}/package/`)) {
      const name = decodeURIComponent(path.slice(`${BASE}/package/`.length));
      await packagePage(name, params.get('version'), current);
    } else await homePage(params.get('range'), session.stats, ui);
  } catch (err) {
    if (current()) showError(err);
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
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('form.search')) return;
    event.preventDefault();
    const field = form.elements.namedItem('q');
    const q = field instanceof HTMLInputElement ? field.value : '';
    void navigate(`${BASE}/search?${new URLSearchParams({ q }).toString()}`);
  });
  window.addEventListener('popstate', () => {
    void route();
  });
  await route();
}

void start();

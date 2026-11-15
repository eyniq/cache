// The catalog start page is the dashboard only when statistics can be shown; otherwise (stats
// off, not authorized, busy or failing) it is the search-first home. The client is plain ES
// modules, so they run here against a tiny fake DOM, a fake fetch and captured timers.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const appUrl = pathToFileURL(
  join(import.meta.dirname, '..', '..', 'src', 'web', 'static', 'app.js'),
).href;

class FakeNode {
  tagName = '';
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  text = '';
  classes = new Set<string>();
  focused = 0;
  classList = {
    add: (...c: string[]) => {
      for (const x of c) this.classes.add(x);
    },
    toggle: (c: string, on: boolean) => (on ? this.classes.add(c) : this.classes.delete(c)),
  };
  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
    if (k === 'class') for (const c of v.split(/\s+/)) if (c) this.classes.add(c);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  append(...nodes: Array<FakeNode | string>) {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const t = new FakeNode();
        t.text = n;
        this.children.push(t);
      } else this.children.push(n);
    }
  }
  replaceChildren(...nodes: FakeNode[]) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {}
  addEventListener() {}
  focus() {
    this.focused++;
  }
  contains(): boolean {
    return false;
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  find(pred: (n: FakeNode) => boolean): FakeNode | null {
    if (pred(this)) return this;
    for (const c of this.children) {
      const f = c.find(pred);
      if (f) return f;
    }
    return null;
  }
  all(pred: (n: FakeNode) => boolean, out: FakeNode[] = []): FakeNode[] {
    if (pred(this)) out.push(this);
    for (const c of this.children) c.all(pred, out);
    return out;
  }
}

/** A class no fake node is an instance of (the client's instanceof checks fail cleanly). */
const Never = function Never() {} as unknown as new () => object;

const bucket = (t: number, over: Record<string, unknown> = {}) => ({
  t,
  requests: 120,
  classes: { '2xx': 118, '5xx': 2 },
  routes: { metadata: 100, artifact: 20 },
  cache: { hit: 80, revalidated: 10, miss: 10 },
  hitRatio: 0.9,
  coalesced: 0,
  upstreamRequests: 12,
  upstreamErrors: 1,
  blocked: 3,
  bytes: 4096,
  evictions: 0,
  gauges: {
    lruBytes: { avg: 1000, max: 2000 },
    workerQueue: { avg: 0, max: 1 },
    rss: { avg: 5e7, max: 6e7 },
    heap: { avg: 2e7, max: 3e7 },
    loopP50: { avg: 0.001, max: 0.002 },
    loopP99: { avg: 0.01, max: 0.02 },
    writeQueue: { avg: 0, max: 0 },
    writesInFlight: { avg: 0, max: 0 },
  },
  latency: { p50: 0.01, p95: 0.2, p99: 0.4 },
  writes: { ok: 30, failed: 0, dropped: 0, retries: 0 },
  writeLatency: { p50: 0.001, p95: 0.004, p99: 0.01 },
  ...over,
});

function statsBody(range: string, requests = 240) {
  const to = 100_000;
  const length = range === '24h' ? 86_400 : 7 * 86_400;
  const step = range === '24h' ? 300 : 3600;
  const from = to - length;
  // 24h: two recent buckets. 7d: also two buckets in the day before the last one.
  const times = range === '24h' ? [to - 600, to - 300] : [from + 3600, to - 2 * 86_400 + 7200];
  return {
    range,
    from,
    to,
    step,
    pods: ['pod-a', 'pod-old'],
    truncated: false,
    skipped: 0,
    totals: { ...bucket(from), requests },
    routeStats: {
      metadata: {
        requests: 200,
        clientErrors: 4,
        serverErrors: 2,
        latency: { p50: 0.01, p95: 0.2, p99: 0.4 },
      },
      artifact: { requests: 40, clientErrors: 0, serverErrors: 0, latency: null },
    },
    series: times.map((t) => bucket(t, range === '24h' ? {} : { requests: 60, blocked: 1 })),
    perPod: {
      'pod-a': [{ t: to - 300, rss: 5e7, heap: 2e7 }],
      'pod-old': [{ t: to - 40_000, rss: 4e7, heap: 2e7 }],
    },
  };
}

interface Loaded {
  body: FakeNode;
  main: FakeNode;
  nav: FakeNode;
  fetched: string[];
  timers: Array<() => void>;
  doc: { hidden: boolean };
  answers: { stats?: number; compare?: number; requests?: number };
}

async function load(opts: {
  stats: boolean;
  statsStatus?: number;
  compareStatus?: number;
}): Promise<Loaded> {
  const body = new FakeNode();
  const byId = new Map<string, FakeNode>();
  for (const id of ['main', 'status', 'account', 'q', 'nav', 'toast']) {
    const n = new FakeNode();
    n.attrs.set('id', id);
    byId.set(id, n);
  }
  const main = byId.get('main')!;
  const fetched: string[] = [];
  const timers: Array<() => void> = [];
  const answers: Loaded['answers'] = {
    ...(opts.statsStatus !== undefined ? { stats: opts.statsStatus } : {}),
    ...(opts.compareStatus !== undefined ? { compare: opts.compareStatus } : {}),
  };
  const make = () => new FakeNode();
  const document = {
    body,
    title: '',
    hidden: false,
    activeElement: null,
    createElement: (tag: string) => Object.assign(make(), { tagName: tag }),
    createElementNS: (_ns: string, tag: string) => Object.assign(make(), { tagName: tag }),
    createTextNode: (t: string) => Object.assign(make(), { text: t }),
    getElementById: (id: string) => byId.get(id) ?? main.find((n) => n.attrs.get('id') === id),
    querySelector: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const fetchFake = (url: string) => {
    fetched.push(url);
    const json = (status: number, data: unknown) =>
      Promise.resolve({
        ok: status < 400,
        status,
        statusText: 'x',
        json: () => Promise.resolve(data),
      });
    if (url.includes('/api/session'))
      return json(200, {
        user: null,
        authRequired: false,
        loginAvailable: false,
        images: false,
        stats: opts.stats,
      });
    if (url.includes('/api/stats')) {
      const range = new URL(url, 'http://localhost').searchParams.get('range') ?? '';
      const status = range === '24h' ? answers.stats : answers.compare;
      if (status !== undefined) return json(status, { error: 'no' });
      return json(200, statsBody(range, answers.requests));
    }
    return json(404, { error: 'unknown' });
  };
  vi.resetModules();
  vi.stubGlobal('document', document);
  vi.stubGlobal('location', {
    pathname: '/-/web/',
    search: '',
    href: 'http://localhost/-/web/',
    origin: 'http://localhost',
  });
  vi.stubGlobal('history', { pushState: () => undefined, replaceState: () => undefined });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => undefined,
  });
  vi.stubGlobal('fetch', fetchFake);
  vi.stubGlobal('Element', FakeNode);
  for (const name of [
    'HTMLElement',
    'HTMLAnchorElement',
    'HTMLFormElement',
    'HTMLInputElement',
    'HTMLDetailsElement',
    'MouseEvent',
    'KeyboardEvent',
  ]) {
    vi.stubGlobal(name, Never);
  }
  await import(/* @vite-ignore */ appUrl);
  // start() is async (session, then the first route); let the microtasks settle.
  await new Promise((r) => setTimeout(r, 20));
  return { body, main, nav: byId.get('nav')!, fetched, timers, doc: document, answers };
}

/** Fires the refresh timer and lets the reload settle. */
async function tick(l: Loaded): Promise<void> {
  const fn = l.timers[l.timers.length - 1];
  expect(fn).toBeDefined();
  fn?.();
  await new Promise((r) => setTimeout(r, 20));
}

const statsCalls = (l: Loaded) => l.fetched.filter((u) => u.includes('/api/stats'));
const hasClass = (c: string) => (n: FakeNode) => n.classes.has(c);
const hasId = (id: string) => (n: FakeNode) => n.attrs.get('id') === id;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('catalog start page', () => {
  it('is the search-first home when statistics are off, without asking for them', async () => {
    const { body, main, nav, fetched } = await load({ stats: false });
    expect(fetched.some((u) => u.includes('/api/stats'))).toBe(false);
    expect(main.find((n) => n.attrs.get('id') === 'q-home')).not.toBeNull();
    expect(main.find((n) => n.classes.has('kpis'))).toBeNull();
    expect(body.classes.has('home')).toBe(true);
    expect(nav.textContent).toContain('Home');
    expect(nav.textContent).not.toContain('Statistics');
  });

  it.each([401, 403, 404, 503])(
    'degrades to the search-first home when the stats answer %i',
    async (status) => {
      const { main, timers } = await load({ stats: true, statsStatus: status });
      expect(main.find((n) => n.attrs.get('id') === 'q-home')).not.toBeNull();
      expect(main.find((n) => n.classes.has('kpis'))).toBeNull();
      expect(main.find((n) => n.classes.has('error'))).toBeNull();
      // Nothing keeps polling a page that could not be shown.
      expect(timers).toHaveLength(0);
    },
  );

  it('is the dashboard with key figures, panels and a range switch when statistics are available', async () => {
    const l = await load({ stats: true });
    const { main, body, nav } = l;
    expect(body.classes.has('home')).toBe(false);
    const kpis = main.find(hasClass('kpis'));
    expect(kpis?.children).toHaveLength(6);
    expect(kpis?.textContent).toContain('90.0%');
    expect(kpis?.textContent).toContain('200 ms');
    expect(kpis?.textContent).toContain('Tarball traffic');
    expect(main.find(hasClass('range-nav'))).not.toBeNull();
    for (const id of [
      'p-health-h',
      'p-traffic-h',
      'p-cache-h',
      'p-latency-h',
      'p-upstream-h',
      'p-routes-h',
      'p-blocked-h',
      'p-runtime-h',
      'p-pods-h',
    ]) {
      expect(main.find(hasId(id)), id).not.toBeNull();
    }
    expect(nav.textContent).toContain('Dashboard');
    expect(nav.textContent).toContain('Statistics');
    // The overall status and the per-pod status come with text, not only color.
    // 1 of 12 upstream fetches failed (8%): above the 5% threshold with enough samples.
    expect(main.find(hasClass('page-title'))?.textContent).toContain('Degraded');
    const pods = main.find(hasId('p-pods-h'))?.textContent;
    expect(pods).toBe('Pods');
    expect(main.textContent).toContain('Not reporting');
    expect(main.textContent).toContain('1 of 2 pods reporting');
    // Per-route errors and latency come from routeStats.
    expect(main.textContent).toContain('Package metadata');
    expect(main.textContent).toContain('Tarballs');
  });

  it('compares with the previous period from the next longer range, asked after the first', async () => {
    const l = await load({ stats: true });
    expect(statsCalls(l).map((u) => u.split('range=')[1])).toEqual(['24h', '7d']);
    const kpis = l.main.find(hasClass('kpis'));
    // 240 requests now, 60 in the day before: up 300%.
    expect(kpis?.textContent).toContain('+300%');
    expect(kpis?.textContent).toContain('vs previous 24h');
    expect(kpis?.all(hasClass('delta'))).toHaveLength(6);
  });

  it('shows the dashboard without deltas when the comparison cannot be read', async () => {
    const l = await load({ stats: true, compareStatus: 503 });
    const kpis = l.main.find(hasClass('kpis'));
    expect(kpis?.children).toHaveLength(6);
    expect(kpis?.textContent).toContain('No data for the previous 24h');
    expect(kpis?.textContent).not.toContain('vs previous');
    expect(l.main.find(hasClass('error'))).toBeNull();
  });
});

describe('dashboard refresh', () => {
  it('reloads on the timer and patches the page in place, without moving the focus', async () => {
    const l = await load({ stats: true });
    const root = l.main.find(hasId('live'));
    const focused = l.main.focused;
    expect(statsCalls(l)).toHaveLength(2);
    expect(l.timers).toHaveLength(1);
    l.answers.requests = 999;
    await tick(l);
    expect(statsCalls(l)).toHaveLength(4);
    expect(l.main.find(hasId('live'))).toBe(root);
    expect(l.main.find(hasClass('kpis'))?.textContent).toContain('999');
    expect(l.main.focused).toBe(focused);
    // The schedule goes on.
    expect(l.timers.length).toBeGreaterThan(1);
  });

  it('does not reload while the tab is hidden', async () => {
    const l = await load({ stats: true });
    l.doc.hidden = true;
    await tick(l);
    expect(statsCalls(l)).toHaveLength(2);
    l.doc.hidden = false;
    await tick(l);
    expect(statsCalls(l)).toHaveLength(4);
  });

  it('keeps the numbers and says so when a reload fails', async () => {
    const l = await load({ stats: true });
    l.answers.stats = 503;
    await tick(l);
    expect(l.main.find(hasClass('kpis'))?.children).toHaveLength(6);
    expect(l.main.find(hasId('live-state'))?.textContent).toContain('Refresh failed');
    delete l.answers.stats;
    await tick(l);
    expect(l.main.find(hasId('live-state'))?.textContent).not.toContain('Refresh failed');
  });

  it.each([401, 403, 404])(
    'falls back to the search-first home when a reload answers %i',
    async (status) => {
      const l = await load({ stats: true });
      l.answers.stats = status;
      const before = l.timers.length;
      await tick(l);
      expect(l.main.find(hasId('q-home'))).not.toBeNull();
      expect(l.main.find(hasClass('kpis'))).toBeNull();
      // One timer was armed for the tick that failed; nothing re-arms after the fallback.
      expect(l.timers.length).toBeLessThanOrEqual(before + 1);
      const armed = l.timers.length;
      await tick(l);
      expect(statsCalls(l).length).toBeLessThanOrEqual(3);
      expect(l.timers).toHaveLength(armed);
    },
  );
});

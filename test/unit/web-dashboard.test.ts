// The catalog start page is the dashboard only when statistics can be shown; otherwise (stats
// off, not authorized, busy or failing) it is the search-first home. The client is a plain
// script, so it runs here against a tiny fake DOM and a fake fetch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(import.meta.dirname, '..', '..', 'src', 'web', 'static', 'app.js'),
  'utf8',
);

class FakeNode {
  tagName = '';
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  text = '';
  classes = new Set<string>();
  classList = {
    add: (c: string) => this.classes.add(c),
    toggle: (c: string, on: boolean) => (on ? this.classes.add(c) : this.classes.delete(c)),
  };
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
    if (k === 'class') for (const c of v.split(/\s+/)) if (c) this.classes.add(c);
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
  addEventListener() {}
  focus() {}
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
}

/** A class no fake node is an instance of (the client's instanceof checks fail cleanly). */
const Never = function Never() {} as unknown as new () => object;

const bucket = (t: number) => ({
  t,
  requests: 120,
  classes: { '2xx': 118, '5xx': 2 },
  hitRatio: 0.9,
  upstreamRequests: 12,
  upstreamErrors: 1,
  blocked: 3,
  latency: { p50: 0.01, p95: 0.2, p99: 0.4 },
});

async function load(opts: {
  stats: boolean;
  statsStatus?: number;
}): Promise<{ body: FakeNode; main: FakeNode; fetched: string[] }> {
  const body = new FakeNode();
  const byId = new Map<string, FakeNode>();
  for (const id of ['main', 'status', 'account', 'q']) {
    const n = new FakeNode();
    n.attrs.set('id', id);
    byId.set(id, n);
  }
  const main = byId.get('main')!;
  const fetched: string[] = [];
  const make = () => new FakeNode();
  const document = {
    body,
    title: '',
    createElement: (tag: string) => Object.assign(make(), { tagName: tag }),
    createElementNS: (_ns: string, tag: string) => Object.assign(make(), { tagName: tag }),
    createTextNode: (t: string) => Object.assign(make(), { text: t }),
    getElementById: (id: string) => byId.get(id) ?? main.find((n) => n.attrs.get('id') === id),
    querySelector: () => null,
    addEventListener: () => undefined,
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
      if (opts.statsStatus !== undefined) return json(opts.statsStatus, { error: 'no' });
      return json(200, {
        range: '24h',
        from: 1000,
        to: 1000 + 120,
        step: 60,
        pods: ['a'],
        truncated: false,
        totals: { ...bucket(1000), requests: 240 },
        series: [bucket(1000), bucket(1060)],
        perPod: {},
      });
    }
    return json(404, { error: 'unknown' });
  };
  const location = {
    pathname: '/-/web/',
    search: '',
    href: 'http://localhost/-/web/',
    origin: 'http://localhost',
  };
  const sandbox = {
    document,
    location,
    history: { pushState: () => undefined, replaceState: () => undefined },
    navigator: {},
    window: { addEventListener: () => undefined, setTimeout },
    fetch: fetchFake,
    URL,
    URLSearchParams,
    Intl,
    Date,
    Element: FakeNode,
    HTMLAnchorElement: Never,
    HTMLFormElement: Never,
    HTMLInputElement: Never,
    HTMLDetailsElement: Never,
    console,
  };
  createContext(sandbox);
  runInContext(source, sandbox);
  // start() is async (session, then the first route); let the microtasks settle.
  await new Promise((r) => setTimeout(r, 20));
  return { body, main, fetched };
}

describe('catalog start page', () => {
  it('is the search-first home when statistics are off, without asking for them', async () => {
    const { body, main, fetched } = await load({ stats: false });
    expect(fetched.some((u) => u.includes('/api/stats'))).toBe(false);
    expect(main.find((n) => n.attrs.get('id') === 'q-home')).not.toBeNull();
    expect(main.find((n) => n.classes.has('kpis'))).toBeNull();
    expect(body.classes.has('home')).toBe(true);
  });

  it.each([401, 403, 404, 503])(
    'degrades to the search-first home when the stats answer %i',
    async (status) => {
      const { main } = await load({ stats: true, statsStatus: status });
      expect(main.find((n) => n.attrs.get('id') === 'q-home')).not.toBeNull();
      expect(main.find((n) => n.classes.has('kpis'))).toBeNull();
      expect(main.find((n) => n.classes.has('error'))).toBeNull();
    },
  );

  it('is the dashboard with key figures, charts and the search when statistics are available', async () => {
    const { main } = await load({ stats: true });
    expect(main.find((n) => n.attrs.get('id') === 'q-home')).not.toBeNull();
    const kpis = main.find((n) => n.classes.has('kpis'));
    expect(kpis?.children).toHaveLength(5);
    expect(kpis?.textContent).toContain('90.0%');
    expect(kpis?.textContent).toContain('200 ms');
    expect(main.find((n) => n.classes.has('charts'))?.children).toHaveLength(4);
    expect(main.find((n) => n.classes.has('range-nav'))).not.toBeNull();
  });
});

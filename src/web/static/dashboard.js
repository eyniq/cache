// @ts-check
/* global document, window */
// The dashboard (start page) and the statistics page. Both show only what
// GET /-/web/api/stats returns, reload it every 30 s while the tab is visible, and patch the
// page in place so a reload never moves the focus or closes an open table.
import { HttpError, announce, api, h, icon, internalLink, statusLabel } from './dom.js';
import { lineChart, meter, sparkline, stackedBar } from './charts.js';
import {
  COMPARE_RANGE,
  LEVEL_LABELS,
  REFRESH_INTERVAL_MS,
  STATS_RANGES,
  assess,
  cacheBreakdown,
  createRefresher,
  delta,
  formatAge,
  formatBytes,
  formatCount,
  formatDuration,
  formatStep,
  formatValue,
  podStatuses,
  previousPeriod,
  routeRows,
  seriesOf,
  summarize,
} from './metrics.js';

/**
 * @typedef {import('./metrics.js').StatsResponse} StatsResponse
 * @typedef {import('./metrics.js').StatsBucket} StatsBucket
 * @typedef {import('./metrics.js').Summary} Summary
 * @typedef {import('./metrics.js').Level} Level
 * @typedef {import('./metrics.js').Delta} Delta
 * @typedef {{ show: (nodes: Array<Node | null>, title: string, home?: boolean) => void,
 *   searchHome: () => void, fail: (err: unknown) => void, current: () => boolean }} Ui
 * @typedef {{ kind: 'home' | 'stats', range: string, data: StatsResponse,
 *   previous: Summary | null, loadedAt: number, failedAt: number | null,
 *   paused: boolean }} LiveState
 */

/** @type {Readonly<Record<Level, 'success' | 'warning' | 'error' | 'paused'>>} */
const LEVEL_STATUS = { ok: 'success', warn: 'warning', bad: 'error', idle: 'paused' };

/** The running page: its refresh schedule and how to take it down. */
/** @type {{ stop: () => void } | null} */
let live = null;

/** Stops the refresh schedule of the page being left (called by the router). */
export function stopLive() {
  live?.stop();
  live = null;
}

/** @param {Level} level @param {string} [text] @param {string} [title] */
function levelLabel(level, text, title) {
  return statusLabel(LEVEL_STATUS[level], text ?? LEVEL_LABELS[level], title);
}

/**
 * The range and, when there is a longer one, the period before it for the comparison. The
 * second call runs after the first (the server computes at most two ranges at once); when it
 * fails there simply is no comparison.
 * @param {string} range
 * @returns {Promise<{ data: StatsResponse, previous: Summary | null }>}
 */
async function load(range) {
  /** @type {StatsResponse} */
  const data = await api(`stats?${new URLSearchParams({ range }).toString()}`);
  const wider = COMPARE_RANGE[range];
  /** @type {Summary | null} */
  let previous = null;
  if (wider !== undefined && data.series.length > 0) {
    try {
      /** @type {StatsResponse} */
      const more = await api(`stats?${new URLSearchParams({ range: wider }).toString()}`);
      previous = previousPeriod(data, more);
    } catch {
      previous = null;
    }
  }
  return { data, previous };
}

/** @param {number} ms */
function clock(ms) {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * The time range switch: links with aria-current, to the dashboard ('/') or the stats page.
 * @param {string} chosen
 * @param {string} path
 */
function rangeNav(chosen, path) {
  return h(
    'nav',
    { 'aria-label': 'Time range', class: 'range-nav' },
    STATS_RANGES.map((r) => {
      const a = internalLink(`${path}?range=${r}`, [r], { id: `range-${r}` });
      if (r === chosen) a.setAttribute('aria-current', 'page');
      return a;
    }),
  );
}

/**
 * Title, overall status, range switch and the refresh controls.
 * @param {LiveState} s
 * @param {{ refreshNow: () => void, togglePause: () => void }} actions
 */
function toolbar(s, actions) {
  const { data } = s;
  const health = assess(data);
  const pods = podStatuses(data);
  const reporting = pods.filter((p) => p.reporting).length;
  const last = data.series[data.series.length - 1];
  const through = last ? Math.min(last.t + data.step, data.to) : null;
  const pause = h(
    'button',
    {
      type: 'button',
      class: 'quiet icon-button',
      id: 'live-pause',
      'aria-pressed': String(s.paused),
    },
    [icon(s.paused ? 'play' : 'pause'), s.paused ? 'Resume' : 'Pause'],
  );
  pause.addEventListener('click', actions.togglePause);
  const refresh = h('button', { type: 'button', class: 'quiet icon-button', id: 'live-refresh' }, [
    icon('refresh'),
    'Refresh',
  ]);
  refresh.addEventListener('click', actions.refreshNow);
  const state =
    s.failedAt !== null
      ? statusLabel(
          'warning',
          'Refresh failed',
          `Last attempt at ${clock(s.failedAt)}; showing earlier data`,
        )
      : s.paused
        ? statusLabel('paused', 'Paused')
        : statusLabel('busy', `Live, every ${String(REFRESH_INTERVAL_MS / 1000)} s`);
  return h('header', { class: 'page-head' }, [
    h('div', { class: 'page-title' }, [
      h('h1', {}, [s.kind === 'home' ? 'Dashboard' : 'Statistics']),
      levelLabel(
        health.level,
        undefined,
        health.checks
          .filter((c) => c.level === 'warn' || c.level === 'bad')
          .map((c) => `${c.label}: ${c.value}`)
          .join('; ') || undefined,
      ),
    ]),
    h('p', { class: 'muted page-sub' }, [
      `Last ${s.range}, in steps of ${formatStep(data.step)}. `,
      pods.length === 0
        ? 'No pod has reported yet.'
        : `${String(reporting)} of ${String(pods.length)} ${pods.length === 1 ? 'pod' : 'pods'} reporting.`,
    ]),
    h('div', { class: 'page-tools' }, [
      rangeNav(s.range, s.kind === 'home' ? '/' : '/stats'),
      h('div', { class: 'live', id: 'live-state' }, [
        state,
        h('span', { class: 'muted updated' }, [
          `Updated ${clock(s.loadedAt)}`,
          through !== null
            ? `, data through ${new Date(through * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : '',
        ]),
        pause,
        refresh,
      ]),
    ]),
  ]);
}

/** @param {LiveState} s */
function notices(s) {
  /** @type {Array<Node | null>} */
  const out = [];
  if (s.data.truncated) {
    out.push(
      h('p', { class: 'notice deprecated', role: 'note' }, [
        'Part of this range was left out to bound the work.',
      ]),
    );
  }
  if ((s.data.skipped ?? 0) > 0) {
    out.push(
      h('p', { class: 'notice deprecated', role: 'note' }, [
        `${formatCount(s.data.skipped ?? 0)} history records could not be read and were skipped.`,
      ]),
    );
  }
  return out;
}

/**
 * @param {string} id
 * @param {string} title
 * @param {Array<Node | string | null>} children
 * @param {{ status?: Node | null, wide?: boolean, note?: string }} [opts]
 */
function panel(id, title, children, opts = {}) {
  return h(
    'section',
    { class: opts.wide === true ? 'panel card wide' : 'panel card', 'aria-labelledby': `${id}-h` },
    [
      h('div', { class: 'panel-head' }, [h('h2', { id: `${id}-h` }, [title]), opts.status ?? null]),
      opts.note !== undefined ? h('p', { class: 'panel-note' }, [opts.note]) : null,
      ...children,
    ],
  );
}

/** @param {Array<[string, string, string?]>} items label, value, hint */
function facts(items) {
  return h(
    'dl',
    { class: 'facts' },
    items.map(([label, value, hint]) =>
      h('div', {}, [
        h('dt', {}, [label]),
        h('dd', hint !== undefined ? { title: hint } : {}, [value]),
      ]),
    ),
  );
}

/**
 * One key figure: label, value, the change against the previous period and a trend line.
 * @param {{ label: string, value: string, note: string, tone?: string,
 *   change: Delta | null, comparable: boolean, range: string,
 *   spark: Array<{ t: number, v: number }>, slot?: string, status?: Node | null }} k
 * @param {StatsResponse} data
 */
function kpi(k, data) {
  const change =
      k.change !== null
        ? h('span', { class: `delta ${k.change.tone} ${k.change.direction}` }, [
            h('span', { class: 'arrow', 'aria-hidden': 'true' }, [
              k.change.direction === 'up' ? '↑' : k.change.direction === 'down' ? '↓' : '→',
            ]),
            h('span', { class: 'visually-hidden' }, [`${k.change.spoken} `]),
            h('span', { 'aria-hidden': 'true' }, [k.change.text]),
            ` vs previous ${k.range}`,
          ])
        : h('span', { class: 'delta none' }, [
            k.comparable ? `No data for the previous ${k.range}` : 'No earlier period to compare',
          ]),
    cls = `kpi card${k.tone !== undefined ? ` ${k.tone}` : ''}`;
  return h('li', { class: cls }, [
    h('div', { class: 'kpi-top' }, [h('span', { class: 'label' }, [k.label]), k.status ?? null]),
    h('div', { class: 'kpi-mid' }, [
      h('span', { class: 'value' }, [k.value]),
      sparkline(k.spark, data.from, data.to, k.slot ?? 's0'),
    ]),
    h('span', { class: 'note' }, [k.note]),
    change,
  ]);
}

/** @param {LiveState} s */
function kpis(s) {
  const { data, previous: prev, range } = s;
  const t = data.totals;
  const cur = summarize(data.series);
  const health = assess(data);
  /** @param {string} id */
  const check = (id) => health.checks.find((c) => c.id === id);
  /** @param {string} id */
  const flag = (id) => {
    const c = check(id);
    return c && (c.level === 'warn' || c.level === 'bad')
      ? levelLabel(c.level, undefined, c.detail)
      : null;
  };
  const comparable = COMPARE_RANGE[range] !== undefined;
  const seconds = Math.max(1, data.to - data.from);
  const upRatio = t.upstreamRequests > 0 ? t.upstreamErrors / t.upstreamRequests : null;
  const base = { comparable, range };
  return h('ul', { class: 'kpis', 'aria-label': `Key figures, last ${range}` }, [
    kpi(
      {
        ...base,
        label: 'Cache hit ratio',
        tone: 'hit',
        value: t.hitRatio === null ? 'n/a' : formatValue(t.hitRatio, '%'),
        note:
          t.hitRatio === null
            ? 'No cache traffic'
            : `${formatCount(cur.hits)} of ${formatCount(cur.lookups)} lookups from the cache`,
        change: delta(t.hitRatio, prev?.hitRatio, { kind: 'points', better: 'up' }),
        spark: seriesOf(data, (b) => b.hitRatio),
      },
      data,
    ),
    kpi(
      {
        ...base,
        label: 'Requests',
        value: formatCount(t.requests),
        note: `${formatValue(t.requests / seconds, '/s')} on average`,
        change: delta(t.requests, prev?.requests, { kind: 'relative', better: 'none' }),
        spark: seriesOf(data, (b) => b.requests),
        slot: 's2',
        status: flag('errors'),
      },
      data,
    ),
    kpi(
      {
        ...base,
        label: 'Latency p95',
        value: t.latency === null ? 'n/a' : formatDuration(t.latency.p95),
        note: 'Worst pod and route',
        change: delta(t.latency?.p95 ?? null, prev?.p95, { kind: 'relative', better: 'down' }),
        spark: seriesOf(data, (b) => b.latency?.p95),
        slot: 's2',
        status: flag('latency'),
      },
      data,
    ),
    kpi(
      {
        ...base,
        label: 'Upstream errors',
        tone: t.upstreamErrors > 0 ? 'alert' : undefined,
        value: upRatio === null ? 'n/a' : formatValue(upRatio, '%'),
        note: `${formatCount(t.upstreamErrors)} of ${formatCount(t.upstreamRequests)} upstream fetches`,
        change: delta(upRatio, prev?.upstreamErrorRatio, { kind: 'points', better: 'down' }),
        spark: seriesOf(data, (b) => b.upstreamErrors),
        slot: 'se',
        status: flag('upstream'),
      },
      data,
    ),
    kpi(
      {
        ...base,
        label: 'Blocked versions',
        value: formatCount(t.blocked),
        note: 'Tarball requests the policy refused',
        change: delta(t.blocked, prev?.blocked, { kind: 'relative', better: 'none' }),
        spark: seriesOf(data, (b) => b.blocked),
        slot: 's1',
      },
      data,
    ),
    kpi(
      {
        ...base,
        label: 'Tarball traffic',
        value: formatBytes(t.bytes ?? 0),
        note: `${formatBytes((t.bytes ?? 0) / seconds)}/s on average`,
        change: delta(t.bytes ?? 0, prev?.bytes, { kind: 'relative', better: 'none' }),
        spark: seriesOf(data, (b) => b.bytes),
        slot: 's2',
      },
      data,
    ),
  ]);
}

/** @param {StatsResponse} data */
function healthPanel(data) {
  const health = assess(data);
  return panel(
    'p-health',
    'Health',
    [
      h(
        'ul',
        { class: 'checks' },
        health.checks.map((c) =>
          h('li', {}, [
            h('span', { class: 'check-name' }, [c.label]),
            levelLabel(c.level, c.level === 'idle' ? 'No data' : undefined),
            h('span', { class: 'check-value' }, [c.value]),
            h('span', { class: 'muted check-detail' }, [c.detail]),
          ]),
        ),
      ),
    ],
    {
      status: levelLabel(health.level),
      wide: true,
      note: 'Derived from this range with fixed thresholds: 5xx share 1% and 5%, upstream failures 5% and 25%, latency p95 3 s and 10 s, event-loop delay p99 100 ms and 500 ms, any lost storage write.',
    },
  );
}

/** @param {StatsResponse} data */
function cachePanel(data) {
  const { total, segments } = cacheBreakdown(data.totals.cache);
  if (total === 0) {
    return panel('p-cache', 'Cache results', [
      h('p', { class: 'empty' }, ['No cache lookups in this range.']),
    ]);
  }
  return panel(
    'p-cache',
    'Cache results',
    [
      stackedBar(segments, 'Cache results'),
      h('table', { class: 'legend-table' }, [
        h('caption', { class: 'visually-hidden' }, ['Cache results']),
        h('thead', {}, [
          h('tr', {}, [
            h('th', { scope: 'col' }, ['Result']),
            h('th', { scope: 'col', class: 'num' }, ['Lookups']),
            h('th', { scope: 'col', class: 'num' }, ['Share']),
          ]),
        ]),
        h(
          'tbody',
          {},
          segments.map((seg) =>
            h('tr', {}, [
              h('th', { scope: 'row', title: seg.hint }, [
                h('span', { class: `swatch ${seg.slot}`, 'aria-hidden': 'true' }),
                seg.label,
              ]),
              h('td', { class: 'num' }, [formatCount(seg.value)]),
              h('td', { class: 'num' }, [formatValue(seg.share, '%')]),
            ]),
          ),
        ),
      ]),
    ],
    {
      status:
        data.totals.hitRatio !== null
          ? h('span', { class: 'panel-figure' }, [
              `${formatValue(data.totals.hitRatio, '%')} hit ratio`,
            ])
          : null,
      note: 'Hit, revalidated (confirmed upstream with a 304) and stale (served while upstream failed) count as served from the cache; a miss is fetched, a coalesced request waits for a fetch already running.',
    },
  );
}

/** @param {StatsResponse} data */
function routesPanel(data) {
  const rows = routeRows(data);
  if (rows.length === 0) {
    return panel('p-routes', 'Request mix by route', [
      h('p', { class: 'empty' }, ['No requests in this range.']),
    ]);
  }
  /** @param {number | null} n @param {string} cls */
  const errors = (n, cls) =>
    h('td', { class: n !== null && n > 0 ? `num ${cls}` : 'num' }, [
      n === null ? '–' : formatCount(n),
    ]);
  /** @param {number | undefined} v */
  const lat = (v) => h('td', { class: 'num' }, [v === undefined ? '–' : formatDuration(v)]);
  return panel(
    'p-routes',
    'Request mix by route',
    [
      h('div', { class: 'table-scroll', tabindex: '0' }, [
        h('table', { class: 'data' }, [
          h('caption', { class: 'visually-hidden' }, ['Requests, errors and latency per route']),
          h('thead', {}, [
            h('tr', {}, [
              h('th', { scope: 'col' }, ['Route']),
              h('th', { scope: 'col', class: 'num' }, ['Requests']),
              h('th', { scope: 'col' }, ['Share']),
              h('th', { scope: 'col', class: 'num' }, ['4xx']),
              h('th', { scope: 'col', class: 'num' }, ['5xx']),
              h('th', { scope: 'col', class: 'num' }, ['p50']),
              h('th', { scope: 'col', class: 'num' }, ['p95']),
              h('th', { scope: 'col', class: 'num' }, ['p99']),
            ]),
          ]),
          h(
            'tbody',
            {},
            rows.map((r) =>
              h('tr', {}, [
                h('th', { scope: 'row' }, [r.label]),
                h('td', { class: 'num' }, [formatCount(r.requests)]),
                h('td', { class: 'share' }, [meter(r.share), ` ${formatValue(r.share, '%')}`]),
                errors(r.clientErrors, 'warn-text'),
                errors(r.serverErrors, 'bad-text'),
                lat(r.latency?.p50),
                lat(r.latency?.p95),
                lat(r.latency?.p99),
              ]),
            ),
          ),
        ]),
      ]),
    ],
    {
      wide: true,
      note: 'Latency is the worst pod per route (an upper bound). A 404 for an unknown package counts as 4xx.',
    },
  );
}

/** @param {StatsResponse} data @param {boolean} compact */
function latencyChart(data, compact) {
  return lineChart(
    {
      id: compact ? 'd-latency' : 'c-latency',
      title: 'Request latency (worst pod and route)',
      unit: 'ms',
      compact,
      level: compact ? 3 : 2,
      series: [
        { label: 'p50', points: seriesOf(data, (b) => b.latency?.p50), slot: 's0' },
        { label: 'p95', points: seriesOf(data, (b) => b.latency?.p95), slot: 's2' },
        { label: 'p99', points: seriesOf(data, (b) => b.latency?.p99), slot: 's1' },
      ],
    },
    data,
  );
}

/** @param {StatsResponse} data */
function latencyPanel(data) {
  const l = data.totals.latency;
  const c = assess(data).checks.find((x) => x.id === 'latency');
  return panel(
    'p-latency',
    'Latency percentiles',
    [
      facts([
        ['p50', l ? formatDuration(l.p50) : 'n/a'],
        ['p95', l ? formatDuration(l.p95) : 'n/a'],
        ['p99', l ? formatDuration(l.p99) : 'n/a'],
      ]),
      latencyChart(data, true),
    ],
    { status: c && c.level !== 'idle' ? levelLabel(c.level) : null },
  );
}

/** @param {StatsResponse} data */
function upstreamPanel(data) {
  const t = data.totals;
  const c = assess(data).checks.find((x) => x.id === 'upstream');
  const ratio = t.upstreamRequests > 0 ? t.upstreamErrors / t.upstreamRequests : null;
  return panel(
    'p-upstream',
    'Upstream health',
    [
      facts([
        ['Fetches', formatCount(t.upstreamRequests)],
        ['Failed', formatCount(t.upstreamErrors)],
        ['Failure rate', ratio === null ? 'n/a' : formatValue(ratio, '%')],
        [
          'Coalesced waiters',
          formatCount(t.coalesced ?? 0),
          'Requests that waited for a fetch already in progress',
        ],
      ]),
      lineChart(
        {
          id: 'd-upstream',
          title: `Upstream fetches per ${formatStep(data.step)}`,
          unit: '',
          compact: true,
          level: 3,
          series: [
            { label: 'Fetches', points: seriesOf(data, (b) => b.upstreamRequests), slot: 's2' },
            { label: 'Failed', points: seriesOf(data, (b) => b.upstreamErrors), slot: 'se' },
          ],
        },
        data,
      ),
    ],
    { status: c ? levelLabel(c.level, c.level === 'idle' ? 'Too few fetches' : undefined) : null },
  );
}

/** @param {StatsResponse} data */
function blockedPanel(data) {
  const t = data.totals;
  const search = internalLink('/search', ['Search a package']);
  return panel(
    'p-blocked',
    'Blocked versions',
    [
      facts([
        ['Blocked in this range', formatCount(t.blocked)],
        [
          'Per 1,000 requests',
          t.requests > 0 ? formatValue((t.blocked / t.requests) * 1000, '') : 'n/a',
        ],
      ]),
      lineChart(
        {
          id: 'd-blocked',
          title: `Blocked versions per ${formatStep(data.step)}`,
          unit: '',
          compact: true,
          level: 3,
          series: [{ label: 'Blocked', points: seriesOf(data, (b) => b.blocked), slot: 's1' }],
        },
        data,
      ),
      h('p', { class: 'muted panel-foot' }, [
        'The history counts refused requests; it does not record which packages. ',
        search,
        ' to see its held-back versions with the reason and the time they become allowed.',
      ]),
    ],
    {
      note: 'Tarball requests for versions the registry policy holds back, for example a lockfile that pins a version younger than the minimum release age.',
    },
  );
}

/** @param {StatsResponse} data */
function podsPanel(data) {
  const pods = podStatuses(data);
  if (pods.length === 0) {
    return panel(
      'p-pods',
      'Pods',
      [h('p', { class: 'empty' }, ['No pod has reported in this range.'])],
      {
        wide: true,
      },
    );
  }
  return panel(
    'p-pods',
    'Pods',
    [
      h('div', { class: 'table-scroll', tabindex: '0' }, [
        h('table', { class: 'data' }, [
          h('caption', { class: 'visually-hidden' }, ['Memory and last record per pod']),
          h('thead', {}, [
            h('tr', {}, [
              h('th', { scope: 'col' }, ['Pod']),
              h('th', { scope: 'col' }, ['Status']),
              h('th', { scope: 'col' }, ['Last record']),
              h('th', { scope: 'col', class: 'num' }, ['Memory (RSS)']),
              h('th', { scope: 'col', class: 'num' }, ['Peak']),
              h('th', { scope: 'col', class: 'num' }, ['Heap']),
              h('th', { scope: 'col' }, ['Memory trend']),
            ]),
          ]),
          h(
            'tbody',
            {},
            pods.map((p) =>
              h('tr', {}, [
                h('th', { scope: 'row', class: 'mono' }, [p.name]),
                h('td', {}, [
                  p.reporting
                    ? statusLabel('success', 'Reporting')
                    : statusLabel(
                        'paused',
                        'Not reporting',
                        'No recent record: stopped, or replaced by a rollout',
                      ),
                ]),
                h('td', {}, [
                  p.lastSeen === null
                    ? '–'
                    : h('time', { datetime: new Date(p.lastSeen * 1000).toISOString() }, [
                        formatAge(data.to - p.lastSeen),
                      ]),
                ]),
                h('td', { class: 'num' }, [formatBytes(p.rss)]),
                h('td', { class: 'num' }, [formatBytes(p.rssPeak)]),
                h('td', { class: 'num' }, [formatBytes(p.heap)]),
                h('td', {}, [sparkline(p.points, data.from, data.to, 's2')]),
              ]),
            ),
          ),
        ]),
      ]),
    ],
    {
      wide: true,
      status: h('span', { class: 'panel-figure' }, [
        `${String(pods.filter((p) => p.reporting).length)} of ${String(pods.length)} reporting`,
      ]),
      note: 'A pod writes its history every 5 minutes, so the last record can be a few minutes old.',
    },
  );
}

/** @param {StatsResponse} data */
function runtimePanel(data) {
  const t = data.totals;
  const g = t.gauges ?? {};
  const w = t.writes;
  const c = assess(data).checks.filter((x) => x.id === 'loop' || x.id === 'writes');
  const level = c.some((x) => x.level === 'bad')
    ? 'bad'
    : c.some((x) => x.level === 'warn')
      ? 'warn'
      : null;
  return panel(
    'p-runtime',
    'Runtime and storage',
    [
      facts([
        ['Event-loop delay p50', formatDuration(g.loopP50?.avg ?? 0), 'Average over the range'],
        [
          'Event-loop delay p99',
          formatDuration(g.loopP99?.max ?? 0),
          'Highest sample in the range',
        ],
        [
          'Worker queue (peak)',
          formatCount(g.workerQueue?.max ?? 0),
          'Packuments waiting for a worker thread',
        ],
        [
          'Metadata cache in memory',
          formatBytes(g.lruBytes?.avg ?? 0),
          `Peak ${formatBytes(g.lruBytes?.max ?? 0)}`,
        ],
        ['Cache evictions', formatCount(t.evictions ?? 0)],
        ['Storage writes', w ? formatCount(w.ok) : 'n/a', 'Background writes stored'],
        ['Writes failed or dropped', w ? formatCount(w.failed + w.dropped) : 'n/a'],
        ['Writes retried', w ? formatCount(w.retries) : 'n/a'],
        ['Write duration p95', t.writeLatency ? formatDuration(t.writeLatency.p95) : 'n/a'],
        ['Write queue (peak)', formatCount(g.writeQueue?.max ?? 0)],
      ]),
    ],
    { status: level !== null ? levelLabel(level) : null },
  );
}

/** @param {StatsResponse} data @param {boolean} compact */
function trafficChart(data, compact) {
  return lineChart(
    {
      id: compact ? 'd-rate' : 'c-rate',
      title: 'Requests per second',
      unit: '/s',
      compact,
      level: compact ? 3 : 2,
      series: [
        {
          label: 'All requests',
          points: seriesOf(data, (b) => b.requests / data.step),
          slot: 's2',
        },
        {
          label: 'Server errors (5xx)',
          points: seriesOf(data, (b) => (b.classes['5xx'] ?? 0) / data.step),
          slot: 'se',
        },
      ],
    },
    data,
  );
}

/** @param {string} range */
function emptyState(range) {
  return h('section', { class: 'card empty-state' }, [
    h('h2', {}, ['No statistics recorded yet']),
    h('p', {}, [
      `Nothing was recorded in the last ${range}. Each pod writes one record per minute and saves them every 5 minutes, so a fresh registry shows its first numbers after a few minutes.`,
    ]),
    h('p', { class: 'muted' }, ['This page reloads by itself.']),
  ]);
}

/** @param {LiveState} s @returns {Array<Node | null>} */
function dashboardBody(s) {
  const { data } = s;
  if (data.series.length === 0) return [...notices(s), emptyState(s.range)];
  const more = internalLink('/stats?range=' + s.range, ['All charts and tables']);
  more.classList.add('more');
  return [
    ...notices(s),
    kpis(s),
    h('div', { class: 'panels' }, [
      healthPanel(data),
      panel('p-traffic', 'Traffic', [trafficChart(data, true)]),
      cachePanel(data),
      latencyPanel(data),
      upstreamPanel(data),
      blockedPanel(data),
      runtimePanel(data),
      routesPanel(data),
      podsPanel(data),
    ]),
    h('p', { class: 'dash-foot' }, [more]),
  ];
}

/** @param {LiveState} s @returns {Array<Node | null>} */
function statsBody(s) {
  const { data } = s;
  if (data.series.length === 0) return [...notices(s), emptyState(s.range)];
  const step = formatStep(data.step);
  /** @param {(b: StatsBucket) => number | null | undefined} f */
  const line = (f) => seriesOf(data, f);
  const pods = podStatuses(data);
  const drawn = pods.slice(0, 4);
  const t = data.totals;
  return [
    ...notices(s),
    h('p', { class: 'muted summary-line' }, [
      `${formatCount(t.requests)} requests, hit ratio ${t.hitRatio === null ? 'n/a' : formatValue(t.hitRatio, '%')}, ` +
        `${formatCount(t.upstreamRequests)} upstream fetches, ${formatCount(t.blocked)} blocked versions, ` +
        `${formatBytes(t.bytes ?? 0)} of tarballs.`,
    ]),
    h('div', { class: 'charts' }, [
      trafficChart(data, false),
      lineChart(
        {
          id: 'c-classes',
          title: `Answers by status class per ${step}`,
          unit: '',
          series: [
            { label: '2xx', points: line((b) => b.classes['2xx'] ?? 0), slot: 's0' },
            { label: '3xx', points: line((b) => b.classes['3xx'] ?? 0), slot: 's2' },
            { label: '4xx', points: line((b) => b.classes['4xx'] ?? 0), slot: 's1' },
            { label: '5xx', points: line((b) => b.classes['5xx'] ?? 0), slot: 'se' },
          ],
        },
        data,
      ),
      lineChart(
        {
          id: 'c-hit',
          title: 'Cache hit ratio',
          unit: '%',
          series: [{ label: 'Hit ratio', points: line((b) => b.hitRatio), slot: 's0' }],
        },
        data,
      ),
      lineChart(
        {
          id: 'c-cache',
          title: `Cache results per ${step}`,
          unit: '',
          series: [
            { label: 'Hit', points: line((b) => b.cache?.hit ?? 0), slot: 's0' },
            { label: 'Miss', points: line((b) => b.cache?.miss ?? 0), slot: 's1' },
            { label: 'Revalidated', points: line((b) => b.cache?.revalidated ?? 0), slot: 's2' },
            { label: 'Stale', points: line((b) => b.cache?.stale ?? 0), slot: 's3' },
          ],
        },
        data,
      ),
      lineChart(
        {
          id: 'c-upstream',
          title: `Upstream fetches and failures per ${step}`,
          unit: '',
          series: [
            { label: 'Fetches', points: line((b) => b.upstreamRequests), slot: 's2' },
            { label: 'Failed', points: line((b) => b.upstreamErrors), slot: 'se' },
          ],
        },
        data,
      ),
      lineChart(
        {
          id: 'c-blocked',
          title: `Blocked versions per ${step}`,
          unit: '',
          series: [{ label: 'Blocked', points: line((b) => b.blocked), slot: 's1' }],
        },
        data,
      ),
      latencyChart(data, false),
      lineChart(
        {
          id: 'c-bytes',
          title: `Tarball traffic per ${step}`,
          unit: 'bytes',
          series: [{ label: 'Tarball bytes', points: line((b) => b.bytes), slot: 's2' }],
        },
        data,
      ),
      lineChart(
        {
          id: 'c-memory',
          title: 'Memory per pod (resident set)',
          unit: 'MiB',
          ...(pods.length > drawn.length
            ? {
                note: `The ${String(drawn.length)} most recent of ${String(pods.length)} pods; the table below lists all.`,
              }
            : {}),
          series: drawn.map((p) => ({ label: p.name, points: p.points })),
        },
        data,
      ),
      lineChart(
        {
          id: 'c-loop',
          title: 'Event-loop delay',
          unit: 'ms',
          series: [
            { label: 'p50 (average)', points: line((b) => b.gauges?.loopP50?.avg), slot: 's0' },
            { label: 'p99 (highest)', points: line((b) => b.gauges?.loopP99?.max), slot: 's1' },
          ],
        },
        data,
      ),
      lineChart(
        {
          id: 'c-lru',
          title: 'Metadata cache in memory',
          unit: 'bytes',
          series: [
            { label: 'Cache size', points: line((b) => b.gauges?.lruBytes?.avg), slot: 's0' },
          ],
        },
        data,
      ),
      lineChart(
        {
          id: 'c-writes',
          title: `Background storage writes per ${step}`,
          unit: '',
          series: [
            { label: 'Stored', points: line((b) => b.writes?.ok), slot: 's2' },
            {
              label: 'Failed or dropped',
              points: line((b) => (b.writes ? b.writes.failed + b.writes.dropped : null)),
              slot: 'se',
            },
          ],
        },
        data,
      ),
    ]),
    h('div', { class: 'panels' }, [
      healthPanel(data),
      cachePanel(data),
      runtimePanel(data),
      routesPanel(data),
      podsPanel(data),
    ]),
  ];
}

/**
 * Replaces the live part of the page and keeps what the reader was doing: the focused control
 * and the tables that were open.
 * @param {HTMLElement} root
 * @param {Array<Node | null>} nodes
 */
function patch(root, nodes) {
  const active = document.activeElement;
  const focusId = active instanceof HTMLElement && root.contains(active) ? active.id : '';
  /** @type {string[]} */
  const open = [];
  for (const d of root.querySelectorAll('details[open]')) if (d.id !== '') open.push(d.id);
  root.replaceChildren(...nodes.filter((n) => n !== null));
  for (const id of open) {
    const d = document.getElementById(id);
    if (d instanceof HTMLDetailsElement) d.open = true;
  }
  if (focusId !== '') document.getElementById(focusId)?.focus({ preventScroll: true });
}

/**
 * Shows a live page and keeps it fresh until the router leaves it.
 * @param {'home' | 'stats'} kind
 * @param {string} range
 * @param {{ data: StatsResponse, previous: Summary | null }} first
 * @param {Ui} ui
 */
function runLive(kind, range, first, ui) {
  /** @type {LiveState} */
  const state = {
    kind,
    range,
    data: first.data,
    previous: first.previous,
    loadedAt: Date.now(),
    failedAt: null,
    paused: false,
  };
  let gone = false;
  const root = h('div', { class: kind === 'home' ? 'dash' : 'dash stats', id: 'live' });
  const actions = {
    refreshNow: () => {
      void refresher.refreshNow();
    },
    togglePause: () => {
      state.paused = !state.paused;
      refresher.setPaused(state.paused);
      announce(state.paused ? 'Automatic refresh paused' : 'Automatic refresh resumed');
      render();
    },
  };
  function render() {
    patch(root, [
      toolbar(state, actions),
      ...(kind === 'home' ? dashboardBody(state) : statsBody(state)),
    ]);
  }
  const refresher = createRefresher({
    isHidden: () => document.hidden,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => {
      window.clearTimeout(/** @type {number} */ (id));
    },
    run: async () => {
      try {
        const next = await load(range);
        if (gone) return;
        state.data = next.data;
        state.previous = next.previous;
        state.loadedAt = Date.now();
        state.failedAt = null;
      } catch (err) {
        if (gone) return;
        // No longer allowed (signed out, stats turned off): leave the page as a first load
        // would. Anything else keeps the numbers already shown and says so.
        if (err instanceof HttpError && [401, 403, 404].includes(err.status)) {
          stopLive();
          if (kind === 'home') ui.searchHome();
          else ui.fail(err);
          return;
        }
        state.failedAt = Date.now();
      }
      render();
    },
  });
  const onVisibility = () => {
    refresher.visibilityChanged();
  };
  stopLive();
  live = {
    stop: () => {
      gone = true;
      refresher.stop();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
  ui.show([root], kind === 'home' ? 'Dashboard' : 'Statistics');
  render();
  document.addEventListener('visibilitychange', onVisibility);
  refresher.start();
}

/** @param {string} title */
function loading(title) {
  return [
    h('div', { class: 'dash', 'aria-busy': 'true' }, [
      h('header', { class: 'page-head' }, [h('h1', {}, [title])]),
      h('p', { class: 'visually-hidden' }, ['Loading statistics']),
      h(
        'ul',
        { class: 'kpis skeleton', 'aria-hidden': 'true' },
        [0, 1, 2, 3, 4, 5].map(() => h('li', { class: 'kpi card' })),
      ),
      h('div', { class: 'panels skeleton', 'aria-hidden': 'true' }, [
        h('div', { class: 'panel card wide' }),
        h('div', { class: 'panel card' }),
        h('div', { class: 'panel card' }),
      ]),
    ]),
  ];
}

/**
 * The start page. With statistics available it is the dashboard; for any reason it cannot be
 * built (disabled, not authorized, busy, failed) it quietly becomes the search-first home.
 * @param {string | null} range
 * @param {boolean} available session.stats
 * @param {Ui} ui
 */
export async function homePage(range, available, ui) {
  if (!available) {
    ui.searchHome();
    return;
  }
  const chosen = range !== null && STATS_RANGES.includes(range) ? range : '24h';
  ui.show(loading('Dashboard'), 'Dashboard');
  /** @type {{ data: StatsResponse, previous: Summary | null }} */
  let first;
  try {
    first = await load(chosen);
  } catch {
    if (ui.current()) ui.searchHome();
    return;
  }
  if (ui.current()) runLive('home', chosen, first, ui);
}

/**
 * @param {string} range
 * @param {Ui} ui
 */
export async function statsPage(range, ui) {
  const chosen = STATS_RANGES.includes(range) ? range : '24h';
  ui.show(loading('Statistics'), 'Statistics');
  const first = await load(chosen);
  if (ui.current()) runLive('stats', chosen, first, ui);
}

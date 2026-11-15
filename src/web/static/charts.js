// @ts-check
// Charts of the dashboard and the statistics page: plain SVG built with createElementNS, no
// library. Every data-driven size is an SVG attribute and every color a class in style.css,
// because the CSP forbids inline styles. Each chart has one y-axis, a legend when it has two
// or more series, a readout for the point under the pointer or the keyboard cursor, and
// (full size) a table with the same data.
import { announce, h, svg } from './dom.js';
import { formatValue } from './metrics.js';

/**
 * @typedef {import('./metrics.js').StatsResponse} StatsResponse
 * @typedef {import('./metrics.js').Segment} Segment
 * @typedef {{ label: string, points: Array<{ t: number, v: number }>, slot?: string }} ChartSeries
 * @typedef {{ id: string, title: string, unit: string, series: ChartSeries[],
 *   level?: 2 | 3, compact?: boolean, note?: string }} ChartSpec
 */

const CHART_W = 640;
const PAD = { left: 64, right: 14, top: 12, bottom: 26 };
/** Categorical slots in a fixed order; a chart never draws more series than this. */
export const SERIES_SLOTS = ['s0', 's1', 's2', 's3'];
const CHAR_W = 6.4;

/**
 * A round axis maximum. With `whole` (the number of grid lines of a chart that counts things)
 * every tick is a whole number.
 * @param {number} max
 * @param {number} [whole]
 */
export function niceMax(max, whole = 0) {
  if (!(max > 0)) return whole > 0 ? whole : 1;
  if (whole > 0 && max <= whole) return whole;
  const exp = 10 ** Math.floor(Math.log10(max));
  for (const m of whole > 0 ? [1, 2, 4, 6, 8, 10] : [1, 2, 2.5, 5, 10]) {
    const top = m * exp;
    if (top >= max && (whole === 0 || Number.isInteger(top / whole))) return top;
  }
  return 10 * exp * (whole > 0 && !Number.isInteger((10 * exp) / whole) ? 2 : 1);
}

/** @param {number} sec @param {string} range */
export function formatTime(sec, range) {
  const d = new Date(sec * 1000);
  return range === '1h' || range === '24h'
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** @param {number} sec @param {string} range */
function formatMoment(sec, range) {
  const d = new Date(sec * 1000);
  return range === '1h' || range === '24h'
    ? d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** @param {ChartSeries} s @param {number} i */
function slotOf(s, i) {
  return s.slot ?? SERIES_SLOTS[i % SERIES_SLOTS.length] ?? 's0';
}

/**
 * One line chart with a legend, a readout and a table fallback.
 * @param {ChartSpec} spec
 * @param {StatsResponse} data
 */
export function lineChart(spec, data) {
  const series = spec.series.filter((s) => s.points.length > 0).slice(0, SERIES_SLOTS.length);
  const figure = h('figure', { class: spec.compact === true ? 'chart compact' : 'chart' });
  figure.append(h(`h${String(spec.level ?? 2)}`, { id: `${spec.id}-title` }, [spec.title]));
  if (spec.note !== undefined) figure.append(h('p', { class: 'chart-note' }, [spec.note]));
  if (series.length === 0) {
    figure.append(h('p', { class: 'empty' }, ['No data in this range.']));
    return figure;
  }
  // A compact chart sits in a narrow panel: a smaller drawing keeps its text near 11 px.
  const W = spec.compact === true ? 440 : CHART_W;
  const padLeft = spec.compact === true ? 56 : PAD.left;
  const height = spec.compact === true ? 170 : 230;
  const lines = spec.compact === true ? 2 : 4;
  const plotW = W - padLeft - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const max =
    spec.unit === '%'
      ? 1
      : niceMax(
          Math.max(...series.flatMap((s) => s.points.map((p) => p.v)), 0),
          spec.unit === '' ? lines : 0,
        );
  const span = Math.max(1, data.to - data.from);
  /** @param {number} t */
  const x = (t) => padLeft + (Math.min(Math.max(t - data.from, 0), span) / span) * plotW;
  /** @param {number} v */
  const y = (v) => PAD.top + plotH - (Math.min(Math.max(v, 0), max) / max) * plotH;
  const summary = series
    .map((s) => {
      const values = s.points.map((p) => p.v);
      const last = values[values.length - 1] ?? 0;
      return `${s.label}: latest ${formatValue(last, spec.unit)}, highest ${formatValue(Math.max(...values), spec.unit)}`;
    })
    .join('. ');
  const root = svg('svg', {
    viewBox: `0 0 ${String(W)} ${String(height)}`,
    role: 'img',
    'aria-labelledby': `${spec.id}-title ${spec.id}-desc`,
    class: 'plot',
  });
  root.append(svg('title', {}, [spec.title]), svg('desc', { id: `${spec.id}-desc` }, [summary]));
  for (let i = 0; i <= lines; i++) {
    const v = (max * i) / lines;
    root.append(
      svg('line', {
        class: i === 0 ? 'grid base' : 'grid',
        x1: String(padLeft),
        x2: String(W - PAD.right),
        y1: y(v).toFixed(1),
        y2: y(v).toFixed(1),
      }),
      svg('text', { class: 'tick end', x: String(padLeft - 8), y: (y(v) + 4).toFixed(1) }, [
        formatValue(v, spec.unit),
      ]),
    );
  }
  root.append(
    svg('text', { class: 'tick', x: String(padLeft), y: String(height - 6) }, [
      formatTime(data.from, data.range),
    ]),
    svg('text', { class: 'tick mid', x: String(padLeft + plotW / 2), y: String(height - 6) }, [
      formatTime(data.from + span / 2, data.range),
    ]),
    svg('text', { class: 'tick end', x: String(W - PAD.right), y: String(height - 6) }, [
      formatTime(data.to, data.range),
    ]),
  );
  series.forEach((s, i) => {
    const cls = slotOf(s, i);
    let d = '';
    let prev = -Infinity;
    /** @type {Array<{ t: number, v: number }>} */
    const lone = [];
    s.points.forEach((p, k) => {
      const gapBefore = p.t - prev > data.step * 2.5;
      const next = s.points[k + 1];
      if (gapBefore && (!next || next.t - p.t > data.step * 2.5)) lone.push(p);
      d += `${gapBefore ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)} `;
      prev = p.t;
    });
    // The dash follows the position in the chart (the first series is solid), the color the series.
    root.append(svg('path', { class: `line ${cls} d${String(i)}`, d: d.trim() }));
    // A point without neighbours draws no line: it gets a dot. Short series get all dots.
    for (const p of s.points.length <= 24 ? s.points : lone) {
      root.append(
        svg('circle', {
          class: `dot ${cls}`,
          cx: x(p.t).toFixed(1),
          cy: y(p.v).toFixed(1),
          r: '2.5',
        }),
      );
    }
  });

  // The readout: a guide line, a ring per series and an inverse plate with the values.
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const lookup = series.map((s) => new Map(s.points.map((p) => [p.t, p.v])));
  const readout = svg('g', { class: 'readout', 'aria-hidden': 'true' });
  root.append(readout);
  let cursor = -1;

  /** @param {number} index */
  function showAt(index) {
    const t = times[Math.min(Math.max(index, 0), times.length - 1)];
    if (t === undefined) return '';
    cursor = times.indexOf(t);
    const cx = x(t);
    /** @type {Array<{ label: string, value: string, cls: string, cy: number }>} */
    const rows = [];
    series.forEach((s, i) => {
      const v = lookup[i]?.get(t);
      if (v === undefined) return;
      rows.push({ label: s.label, value: formatValue(v, spec.unit), cls: slotOf(s, i), cy: y(v) });
    });
    const when = formatMoment(t, data.range);
    const chars = Math.max(when.length, ...rows.map((r) => r.label.length + r.value.length + 4));
    const w = Math.ceil(chars * CHAR_W) + 20;
    const hgt = 14 + 16 * (rows.length + 1);
    const left = cx + 12 + w > W - 2 ? cx - 12 - w : cx + 12;
    const top = PAD.top + 2;
    readout.replaceChildren(
      svg('line', {
        class: 'guide',
        x1: cx.toFixed(1),
        x2: cx.toFixed(1),
        y1: String(PAD.top),
        y2: String(PAD.top + plotH),
      }),
      ...rows.map((r) =>
        svg('circle', { class: `ring ${r.cls}`, cx: cx.toFixed(1), cy: r.cy.toFixed(1), r: '4.5' }),
      ),
      svg('g', { class: 'tip', transform: `translate(${left.toFixed(1)} ${String(top)})` }, [
        svg('rect', { class: 'plate', width: String(w), height: String(hgt), rx: '4' }),
        svg('text', { class: 'when', x: '10', y: '17' }, [when]),
        ...rows.flatMap((r, i) => [
          svg('rect', {
            class: `key ${r.cls}`,
            x: '10',
            y: String(25 + i * 16),
            width: '8',
            height: '8',
            rx: '2',
          }),
          svg('text', { class: 'name', x: '24', y: String(33 + i * 16) }, [r.label]),
          svg('text', { class: 'val', x: String(w - 10), y: String(33 + i * 16) }, [r.value]),
        ]),
      ]),
    );
    return `${when}: ${rows.map((r) => `${r.label} ${r.value}`).join(', ')}`;
  }

  function hide() {
    cursor = -1;
    readout.replaceChildren();
  }

  /** @param {number} clientX */
  function nearest(clientX) {
    const box = root.getBoundingClientRect();
    if (box.width === 0) return 0;
    const t = data.from + (((clientX - box.left) / box.width) * W - padLeft) * (span / plotW);
    let best = 0;
    let dist = Infinity;
    times.forEach((time, i) => {
      const dd = Math.abs(time - t);
      if (dd < dist) {
        dist = dd;
        best = i;
      }
    });
    return best;
  }

  const wrap = h(
    'div',
    {
      class: 'plot-wrap',
      id: `${spec.id}-plot`,
      tabindex: '0',
      role: 'group',
      'aria-label': `${spec.title}. Use the left and right arrow keys to read the values.`,
    },
    [root],
  );
  wrap.addEventListener('pointermove', (event) => {
    if (event instanceof MouseEvent) showAt(nearest(event.clientX));
  });
  wrap.addEventListener('pointerdown', (event) => {
    if (event instanceof MouseEvent) showAt(nearest(event.clientX));
  });
  wrap.addEventListener('pointerleave', hide);
  wrap.addEventListener('blur', hide);
  wrap.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent)) return;
    const last = times.length - 1;
    /** @type {number | null} */
    let next = null;
    if (event.key === 'ArrowLeft') next = cursor === -1 ? last : Math.max(0, cursor - 1);
    else if (event.key === 'ArrowRight') next = cursor === -1 ? last : Math.min(last, cursor + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === 'Escape') hide();
    if (next === null) return;
    event.preventDefault();
    announce(showAt(next));
  });
  figure.append(wrap);

  if (series.length > 1) {
    figure.append(
      h(
        'ul',
        { class: 'legend' },
        series.map((s, i) =>
          h('li', {}, [
            h('span', { class: `swatch ${slotOf(s, i)}`, 'aria-hidden': 'true' }),
            s.label,
          ]),
        ),
      ),
    );
  }
  if (spec.compact === true) return figure;
  const details = h('details', { class: 'chart-table', id: `${spec.id}-table` }, [
    h('summary', { id: `${spec.id}-summary` }, ['Show as table']),
  ]);
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    details.append(dataTable(spec, series));
  };
  details.addEventListener('toggle', () => {
    if (details instanceof HTMLDetailsElement && details.open) build();
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
        ...series.map((s) => h('th', { scope: 'col', class: 'num' }, [s.label])),
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
            return h('td', { class: 'num' }, [v === undefined ? '' : formatValue(v, spec.unit)]);
          }),
        ]),
      ),
    ),
  ]);
  return h('div', { class: 'table-scroll', tabindex: '0', id: `${spec.id}-scroll` }, [table]);
}

/**
 * A small trend line without axes, decorative: the tile states the number in text.
 * @param {Array<{ t: number, v: number }>} points
 * @param {number} from
 * @param {number} to
 * @param {string} [slot]
 */
export function sparkline(points, from, to, slot = 's0') {
  const W = 120;
  const H = 32;
  const root = svg('svg', {
    class: `spark ${slot}`,
    viewBox: `0 0 ${String(W)} ${String(H)}`,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  if (points.length === 0) return root;
  const max = Math.max(...points.map((p) => p.v), 0);
  const min = Math.min(...points.map((p) => p.v), 0);
  const span = Math.max(1, to - from);
  const height = max - min || 1;
  /** @param {number} t */
  const x = (t) => 2 + (Math.min(Math.max(t - from, 0), span) / span) * (W - 6);
  /** @param {number} v */
  const y = (v) => H - 4 - ((v - min) / height) * (H - 8);
  if (points.length > 1) {
    root.append(
      svg('path', {
        class: 'line',
        d: points
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
          .join(' '),
      }),
    );
  }
  const last = points[points.length - 1];
  if (last) {
    root.append(
      svg('circle', {
        class: 'end-dot',
        cx: x(last.t).toFixed(1),
        cy: y(last.v).toFixed(1),
        r: '2.5',
      }),
    );
  }
  return root;
}

/**
 * One horizontal bar split into parts of a whole, with a 2 px gap between the parts. The
 * legend next to it lists every value, so the bar itself is described in one sentence.
 * @param {Segment[]} segments
 * @param {string} label
 */
export function stackedBar(segments, label) {
  const W = 600;
  const H = 18;
  const GAP = 2;
  const shown = segments.filter((s) => s.value > 0);
  const root = svg('svg', {
    class: 'stack',
    viewBox: `0 0 ${String(W)} ${String(H)}`,
    role: 'img',
    'aria-label': `${label}: ${shown.map((s) => `${s.label} ${formatValue(s.share, '%')}`).join(', ')}`,
  });
  // Every part is at least 3 px wide so a small share stays visible.
  const free = W - GAP * Math.max(0, shown.length - 1);
  const widths = shown.map((s) => Math.max(3, s.share * free));
  const scale = free / widths.reduce((a, b) => a + b, 0);
  let x = 0;
  shown.forEach((s, i) => {
    const w = (widths[i] ?? 0) * scale;
    root.append(
      svg(
        'rect',
        {
          class: `part ${s.slot}`,
          x: x.toFixed(1),
          y: '0',
          width: w.toFixed(1),
          height: String(H),
          rx: '4',
        },
        [
          svg('title', {}, [
            `${s.label}: ${formatValue(s.value, '')} (${formatValue(s.share, '%')})`,
          ]),
        ],
      ),
    );
    x += w + GAP;
  });
  return root;
}

/**
 * A thin meter for one share of a whole (0..1), decorative next to its number.
 * @param {number} share
 * @param {string} [slot]
 */
export function meter(share, slot = 's2') {
  const W = 100;
  const w = Math.max(share > 0 ? 2 : 0, Math.min(1, share) * W);
  return svg('svg', { class: 'meter', viewBox: `0 0 ${String(W)} 6`, 'aria-hidden': 'true' }, [
    svg('rect', { class: 'track', x: '0', y: '0', width: String(W), height: '6', rx: '3' }),
    svg('rect', {
      class: `fill ${slot}`,
      x: '0',
      y: '0',
      width: w.toFixed(1),
      height: '6',
      rx: '3',
    }),
  ]);
}

import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, type MdNode } from '../../src/web/markdown.ts';

const md = (src: string, images = false) => renderMarkdown(src, { images }).nodes;
const json = (nodes: MdNode[]) => JSON.stringify(nodes);

/** Every href and src in the tree. */
function urls(nodes: MdNode[]): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      if (typeof o.href === 'string') out.push(o.href);
      if (typeof o.src === 'string') out.push(o.src);
      Object.values(o).forEach(walk);
    }
  };
  walk(nodes);
  return out;
}

/** Node types in the tree. */
function types(nodes: MdNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      if (typeof o.t === 'string') out.add(o.t);
      Object.values(o).forEach(walk);
    }
  };
  walk(nodes);
  return out;
}

describe('renderMarkdown: structure', () => {
  it('renders headings, paragraphs and inline formatting', () => {
    expect(md('# Title\n\nSome *em* and **strong** and `code` and ~~gone~~.')).toEqual([
      { t: 'h', l: 1, c: ['Title'] },
      {
        t: 'p',
        c: [
          'Some ',
          { t: 'em', c: ['em'] },
          ' and ',
          { t: 'strong', c: ['strong'] },
          ' and ',
          { t: 'code', code: 'code' },
          ' and ',
          { t: 'del', c: ['gone'] },
          '.',
        ],
      },
    ]);
  });

  it('renders setext headings, rules, quotes and fenced and indented code', () => {
    const nodes = md(
      'Title\n=====\n\n---\n\n> quoted *text*\n\n```js\nconst a = "<b>";\n```\n\n    indented',
    );
    expect(nodes).toEqual([
      { t: 'h', l: 1, c: ['Title'] },
      { t: 'hr' },
      { t: 'quote', c: [{ t: 'p', c: ['quoted ', { t: 'em', c: ['text'] }] }] },
      { t: 'pre', code: 'const a = "<b>";', lang: 'js' },
      { t: 'pre', code: 'indented' },
    ]);
  });

  it('renders ordered, unordered and nested lists', () => {
    expect(md('- a\n- b\n  - c\n\n3. x\n4. y')).toEqual([
      {
        t: 'ul',
        items: [
          [{ t: 'p', c: ['a'] }],
          [
            { t: 'p', c: ['b'] },
            { t: 'ul', items: [[{ t: 'p', c: ['c'] }]] },
          ],
        ],
      },
      { t: 'ol', start: 3, items: [[{ t: 'p', c: ['x'] }], [{ t: 'p', c: ['y'] }]] },
    ]);
  });

  it('renders pipe tables', () => {
    expect(md('| a | b |\n|---|:-:|\n| 1 | `2` |')).toEqual([
      { t: 'table', head: [['a'], ['b']], rows: [[['1'], [{ t: 'code', code: '2' }]]] },
    ]);
  });

  it('renders links, reference links, autolinks and hard breaks', () => {
    const nodes = md(
      '[site](https://example.com "title") and [ref][r] and <https://a.example/x> and https://b.example/y.\nline  \nbreak\n\n[r]: https://ref.example/',
    );
    expect(urls(nodes)).toEqual([
      'https://example.com/',
      'https://ref.example/',
      'https://a.example/x',
      'https://b.example/y',
    ]);
    expect(types(nodes).has('br')).toBe(true);
  });

  it('keeps underscores inside words and decodes entities to text', () => {
    expect(md('snake_case_name &amp; &lt;b&gt; &#65;')).toEqual([
      { t: 'p', c: ['snake_case_name & <b> A'] },
    ]);
  });
});

describe('renderMarkdown: safety', () => {
  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'jav&#x61;script:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example/x',
    '/relative/path',
    'docs/readme.md',
    '#anchor',
    'https://user:pass@evil.example/',
  ])('drops the link target %j but keeps the text', (target) => {
    const nodes = md(`[click](${target}) <${target}>`);
    expect(urls(nodes)).toEqual([]);
    expect(json(nodes)).toContain('click');
  });

  it('allows http, https and mailto only', () => {
    expect(urls(md('[a](http://x.example) [b](mailto:a@x.example) [c](ftp://x.example)'))).toEqual([
      'http://x.example/',
      'mailto:a@x.example',
    ]);
  });

  it('never passes raw HTML through: tags are stripped, script and style bodies dropped', () => {
    const nodes = md(
      '<p align="center"><img src="x" onerror="alert(1)">Hello</p>\n\n<script>alert(1)</script>\n\n<style>body{}</style>\n\ntext <b onclick="x()">bold</b> <!-- hidden -->',
    );
    const text = json(nodes);
    expect(text).not.toMatch(/<|onerror|onclick|alert|body\{\}|hidden/);
    expect(text).toContain('Hello');
    expect(text).toContain('bold');
  });

  it('emits only whitelisted node types', () => {
    const allowed = new Set([
      'h',
      'p',
      'em',
      'strong',
      'del',
      'code',
      'pre',
      'a',
      'img',
      'ul',
      'ol',
      'quote',
      'hr',
      'br',
      'table',
    ]);
    const nodes = md(
      '# a\n\n*b* **c** ~~d~~ `e` [f](https://x.example) ![g](https://x.example/g.png)\n\n- h\n\n> i\n\n---\n\n| j |\n|---|\n| k |',
      true,
    );
    for (const t of types(nodes)) expect(allowed.has(t), t).toBe(true);
  });

  it('shows images only when enabled and only over https', () => {
    const src =
      '![logo](https://x.example/logo.png) ![insecure](http://x.example/a.png) ![js](javascript:alert(1))';
    const off = md(src, false);
    expect(types(off).has('img')).toBe(false);
    expect(json(off)).toContain('logo');
    const on = md(src, true);
    expect(on).toEqual([
      {
        t: 'p',
        c: [{ t: 'img', src: 'https://x.example/logo.png', alt: 'logo' }, ' insecure js'],
      },
    ]);
  });

  it('keeps badge links ([![alt](img)](href)) as links with the alt text when images are off', () => {
    const nodes = md('[![build](https://ci.example/badge.svg)](https://ci.example/run)');
    expect(nodes).toEqual([
      { t: 'p', c: [{ t: 'a', href: 'https://ci.example/run', c: ['build'] }] },
    ]);
  });

  it('caps the input and the number of nodes', () => {
    const big = renderMarkdown('word '.repeat(200_000), {
      images: false,
      maxInputBytes: 64 * 1024,
    });
    expect(big.truncated).toBe(true);
    expect(json(big.nodes).length).toBeLessThan(80 * 1024);
    const many = renderMarkdown('- x\n'.repeat(50_000), { images: false, maxNodes: 1000 });
    expect(many.truncated).toBe(true);
  });

  it('limits nesting depth', () => {
    const deep = renderMarkdown(`${'> '.repeat(500)}x`, { images: false });
    let depth = 0;
    let n: unknown = deep.nodes[0];
    while (n && typeof n === 'object' && (n as { t?: string }).t === 'quote') {
      depth++;
      n = (n as { c: unknown[] }).c[0];
    }
    expect(depth).toBeLessThanOrEqual(16);
  });

  it.each([
    ['unclosed emphasis', '*a '.repeat(40_000)],
    ['unclosed strong', '**a '.repeat(30_000)],
    ['brackets', '['.repeat(100_000)],
    ['link openers', '[a]('.repeat(30_000)],
    ['backticks', '`a '.repeat(40_000)],
    ['tags', '<a '.repeat(40_000)],
    ['underscores', '_a_'.repeat(40_000)],
    ['long table row', `|${'a|'.repeat(50_000)}\n|${'-|'.repeat(50_000)}`],
  ])('stays fast on pathological input: %s', (_label, src) => {
    const start = performance.now();
    renderMarkdown(src, { images: false });
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

// CI runners share their CPUs with other jobs (1.1 s seen for a 0.4 s case), so 200 ms locally and 3 s there. A
// quadratic regression on these inputs costs far more either way.
const COST_BUDGET_MS = process.env['CI'] ? 3000 : 200;

describe('renderMarkdown: cost bounds', () => {
  const HOSTILE: Array<[string, string]> = [
    ['link openers', '[a]('.repeat(65_000) + ')'],
    ['image openers', '![a]('.repeat(30_000) + ')'],
    ['a long paragraph closed as a setext heading', 'a\n'.repeat(60_000) + '==='],
    ['bracketed lines', '[a]\n'.repeat(30_000)],
    ['pointy destinations', '[x](<'.repeat(20_000) + '>)'],
    ['hard breaks', 'a  \n'.repeat(60_000)],
    ['bare URLs with closing parentheses', `http://a.example/${')'.repeat(2000)} `.repeat(30)],
    ['nested parentheses', '[a](' + '('.repeat(60_000)],
    ['badges', '[!['.repeat(30_000)],
    ['script tags', '<script>'.repeat(20_000)],
  ];

  it.each(HOSTILE)('renders %s in under 200 ms (default limits)', (_label, src) => {
    const start = performance.now();
    renderMarkdown(src, { images: true });
    expect(performance.now() - start).toBeLessThan(COST_BUDGET_MS);
  });

  it.each(HOSTILE)('renders %s in under 200 ms with a 256 KiB input cap', (_label, src) => {
    const start = performance.now();
    renderMarkdown(src, { images: true, maxInputBytes: 256 * 1024 });
    expect(performance.now() - start).toBeLessThan(COST_BUDGET_MS);
  });

  it('stays fast on random Markdown-like input', () => {
    // A small seeded generator: failures are reproducible.
    let seed = 0x2f6b1d;
    const rand = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed % n;
    };
    const pieces = [
      '[',
      ']',
      '(',
      ')',
      '<',
      '>',
      '!',
      '*',
      '_',
      '~',
      '`',
      '\\',
      '\n',
      '  \n',
      '#',
      '>',
      '-',
      '|',
      ':',
      'http://x.example/',
      'a',
      'b ',
      ' ',
      '&amp;',
      '&#',
      '"',
      "'",
      '\t',
      '<script>',
      '</script>',
      '<!--',
      '-->',
      '```',
      '1. ',
      '- ',
      '[a]: http://r.example/',
    ];
    let worst = 0;
    for (let round = 0; round < 40; round++) {
      let src = '';
      while (src.length < 64 * 1024) src += pieces[rand(pieces.length)] ?? '';
      const start = performance.now();
      renderMarkdown(src, { images: true });
      worst = Math.max(worst, performance.now() - start);
    }
    expect(worst).toBeLessThan(COST_BUDGET_MS);
  });

  it('caps README input at 64 KiB by default', () => {
    expect(renderMarkdown('a'.repeat(65 * 1024), { images: false }).truncated).toBe(true);
    expect(renderMarkdown('a'.repeat(63 * 1024), { images: false }).truncated).toBe(false);
  });

  it('renders a large ordinary README completely', () => {
    const section = (n: number) =>
      [
        `## Section ${n}`,
        '',
        `Some text with *emphasis*, **strong**, \`code\` and a [link](https://example.com/${n}).`,
        '',
        '- item one',
        '- item [two](https://example.com/two) with `code`',
        '  - nested item',
        '',
        '| a | b |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '```js',
        `const x = ${n};`,
        '```',
        '',
      ].join('\n');
    let src = '# Title\n\n';
    for (let n = 0; src.length < 60 * 1024; n++) src += section(n);
    const r = renderMarkdown(src, { images: false });
    expect(r.truncated).toBe(false);
    expect(json(r.nodes)).toContain('Section 1');
  });
});

// The catalog client builds DOM from server data; these sinks would turn data into markup
// or code, so they must never appear in the shipped assets.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', '..', 'src', 'web', 'static');
/** Every client module: the checks below hold for each of them. */
const modules = ['app.js', 'charts.js', 'dashboard.js', 'dom.js', 'metrics.js'];

describe('web catalog assets', () => {
  it('ship only the expected files', () => {
    expect(readdirSync(dir).sort()).toEqual([
      'app.js',
      'charts.js',
      'dashboard.js',
      'dom.js',
      'favicon.svg',
      'index.html',
      'metrics.js',
      'style.css',
      'tsconfig.json',
    ]);
  });

  it('check every script that is shipped', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.js'))).toEqual(modules);
  });

  it.each(modules)('never use HTML or code sinks in the client (%s)', (file) => {
    const js = readFileSync(join(dir, file), 'utf8');
    for (const sink of [
      /\.innerHTML/,
      /\.outerHTML/,
      /insertAdjacentHTML/,
      /document\.write/,
      /\beval\s*\(/,
      /new Function/,
      /setAttribute\(\s*['"]on/i,
      /srcdoc/i,
      /javascript:/i,
      /data:[a-z]+\//i,
      /\.style\s*[.=[]/,
    ]) {
      expect(js, String(sink)).not.toMatch(sink);
    }
    // href and src are only ever set after safeUrl() (h() refuses them as attributes).
    for (const m of js.matchAll(/setAttribute\('(href|src)', ([a-z]+)\)/g)) {
      expect(['href', 'src']).toContain(m[2]);
    }
  });

  it('never embed data: URIs in the stylesheet (the CSP serves only self)', () => {
    expect(readFileSync(join(dir, 'style.css'), 'utf8')).not.toMatch(/data:[a-z]+\//i);
  });

  it.each(modules)('never set inline styles from the client (%s; the CSP forbids them)', (file) => {
    const js = readFileSync(join(dir, file), 'utf8');
    expect(js).not.toMatch(/setAttribute\(\s*['"]style/i);
    expect(js).not.toMatch(/\bstyle\s*:/);
    expect(js).not.toMatch(
      /cssText|attributeStyleMap|setProperty|adoptedStyleSheets|CSSStyleSheet/,
    );
  });

  it.each(modules)('only import the other shipped modules (%s)', (file) => {
    const js = readFileSync(join(dir, file), 'utf8');
    const imports = [...js.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    for (const spec of imports) {
      expect(spec.startsWith('./')).toBe(true);
      expect(modules).toContain(spec.slice(2));
    }
    // No dynamic imports in code (JSDoc type references in comments do not count).
    const code = js
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  it('keep the shell free of inline code and inline styles', () => {
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
    // Scripts, styles and preloads come from the catalog's own static path only.
    for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      expect(m[1]).toMatch(/^\/-\/web\/(static\/[a-z.-]+|search)?$|^#main$/);
    }
    expect(html).not.toMatch(/data:/i);
    const svg = readFileSync(join(dir, 'favicon.svg'), 'utf8');
    expect(svg).not.toMatch(/<script|\son[a-z]+=|href=/i);
  });
});

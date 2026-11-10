// The catalog client builds DOM from server data; these sinks would turn data into markup
// or code, so they must never appear in the shipped assets.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', '..', 'src', 'web', 'static');

describe('web catalog assets', () => {
  it('ship only the expected files', () => {
    expect(readdirSync(dir).sort()).toEqual([
      'app.js',
      'favicon.svg',
      'index.html',
      'style.css',
      'tsconfig.json',
    ]);
  });

  it('never use HTML or code sinks in the client', () => {
    const js = readFileSync(join(dir, 'app.js'), 'utf8');
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
      /\.style\s*[.=[]/,
    ]) {
      expect(js, String(sink)).not.toMatch(sink);
    }
    // href and src are only ever set after safeUrl() (h() refuses them as attributes).
    for (const m of js.matchAll(/setAttribute\('(href|src)', ([a-z]+)\)/g)) {
      expect(['href', 'src']).toContain(m[2]);
    }
  });

  it('never set inline styles from the client (the CSP forbids them)', () => {
    const js = readFileSync(join(dir, 'app.js'), 'utf8');
    expect(js).not.toMatch(/setAttribute\(\s*['"]style/i);
    expect(js).not.toMatch(/\bstyle\s*:/);
  });

  it('keep the shell free of inline code and inline styles', () => {
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
    const svg = readFileSync(join(dir, 'favicon.svg'), 'utf8');
    expect(svg).not.toMatch(/<script|\son[a-z]+=|href=/i);
  });
});

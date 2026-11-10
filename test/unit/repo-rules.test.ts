import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('repository rules', () => {
  it('has zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.optionalDependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it('keeps the core free of adapter imports', () => {
    const offenders: string[] = [];
    for (const file of filesUnder(join(root, 'src'))) {
      // Composition entries may wire in the default adapter: the community composition root,
      // the community composition (compose.ts) and the public `defaults` barrel.
      if (
        file.includes(join('src', 'adapters')) ||
        file.endsWith(join('src', 'main.ts')) ||
        file.endsWith(join('src', 'compose.ts')) ||
        file.endsWith(join('src', 'defaults.ts'))
      )
        continue;
      if (/from\s+['"][^'"]*adapters\//.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('never imports the public barrels from inside src (they are entry points only)', () => {
    const offenders: string[] = [];
    for (const file of filesUnder(join(root, 'src'))) {
      if (file.endsWith(join('src', 'index.ts'))) continue;
      const src = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*(?:\/defaults|\.\.?\/index)\.ts['"]/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('imports only node builtins and relative files in src', () => {
    const offenders: string[] = [];
    for (const file of filesUnder(join(root, 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?:\bfrom\s+|import\(\s*)['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('node:') && !spec.startsWith('.')) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

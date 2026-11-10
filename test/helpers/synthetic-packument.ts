// A synthetic, deterministic packument of roughly 30 MB (about 4,000 versions), shaped like the
// packument of a very large, long-lived package. Generated at test time so the repository ships
// no recorded third-party data. Used by the event-loop test (DESIGN.md section 12).
import { createHash } from 'node:crypto';

function hex(seed: string, length: number): string {
  let out = '';
  for (let i = 0; out.length < length; i++) {
    out += createHash('sha512').update(`${seed}:${i}`).digest('hex');
  }
  return out.slice(0, length);
}

export function buildSyntheticPackument(name: string, versionCount = 4000): Buffer {
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = {
    created: '2020-01-01T00:00:00.000Z',
    modified: '2024-01-01T00:00:00.000Z',
  };
  const maintainers = [
    { name: 'example-maintainer-a', email: 'a@example.invalid' },
    { name: 'example-maintainer-b', email: 'b@example.invalid' },
  ];
  const start = Date.UTC(2020, 0, 1);
  let latest = '';
  for (let i = 0; i < versionCount; i++) {
    const version = `${Math.floor(i / 400)}.${Math.floor(i / 20) % 20}.${i % 20}`;
    latest = version;
    const sha = hex(`${name}@${version}`, 40);
    versions[version] = {
      name,
      version,
      description: `Synthetic package used for performance tests (${version}).`,
      keywords: ['synthetic', 'fixture', 'performance', 'test', 'packument'],
      license: 'MIT',
      _id: `${name}@${version}`,
      maintainers,
      homepage: `https://example.invalid/${name}`,
      bugs: { url: `https://example.invalid/${name}/issues` },
      bin: { [name]: 'dist/bin/cli' },
      dist: {
        shasum: sha,
        tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
        fileCount: 8000 + (i % 700),
        integrity: `sha512-${Buffer.from(hex(`${name}@${version}:sri`, 128), 'hex').toString('base64')}`,
        signatures: [
          {
            sig: Buffer.from(hex(`${name}@${version}:sig`, 140), 'hex').toString('base64'),
            keyid: 'SHA256:synthetic-key-id',
          },
        ],
        unpackedSize: 100_000_000 + i,
      },
      main: './dist/index.js',
      types: './dist/index.d.ts',
      engines: { node: '>=18.0.0' },
      scripts: { build: 'tsc', test: 'vitest run', prepublishOnly: 'pnpm build' },
      _npmUser: maintainers[0],
      _npmVersion: '10.0.0',
      _nodeVersion: '22.0.0',
      _hasShrinkwrap: false,
      repository: { type: 'git', url: `git+https://example.invalid/${name}.git` },
      directories: {},
      dependencies: { 'dep-a': '^1.0.0', 'dep-b': '^2.0.0', 'dep-c': '^3.0.0' },
      peerDependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
      optionalDependencies: Object.fromEntries(
        ['darwin-arm64', 'darwin-x64', 'linux-arm64-gnu', 'linux-x64-gnu', 'win32-x64-msvc'].map(
          (p) => [`@example/${name}-${p}`, version],
        ),
      ),
      peerDependenciesMeta: { react: { optional: true } },
      readme: hex(`${name}@${version}:readme`, 6000),
    };
    time[version] = new Date(start + i * 3_600_000).toISOString();
  }
  return Buffer.from(
    JSON.stringify({
      _id: name,
      name,
      'dist-tags': { latest },
      versions,
      time,
      license: 'MIT',
      description: 'Synthetic package used for performance tests.',
      maintainers,
      readme: hex(`${name}:readme`, 20_000),
      readmeFilename: 'README.md',
    }),
  );
}

// A PublishRequest as the npm adapter hands it to a PackageSource (digests computed), with a
// real tarball whose package.json describes `name@version` unless `tarballFor` says otherwise.
import { createHash } from 'node:crypto';
import type { PublishRequest } from '../../src/core/contracts.ts';
import { makeTarball } from './tarball.ts';

export function publishRequest(
  name: string,
  version: string,
  opts: {
    tags?: Record<string, string>;
    document?: Record<string, unknown>;
    tarballFor?: { name: string; version: string };
    manifest?: Record<string, unknown>;
    /** More package.json fields inside the tarball. */
    packageJson?: Record<string, unknown>;
    /** More files inside the tarball (under package/). */
    files?: Record<string, string>;
  } = {},
): PublishRequest {
  const inside = { ...opts.packageJson, ...(opts.tarballFor ?? { name, version }) };
  const data = makeTarball({
    'package.json': JSON.stringify(inside),
    'index.js': `// ${version}`,
    ...opts.files,
  });
  const hex = createHash('sha512').update(data).digest('hex');
  const file = `${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`;
  return {
    ecosystem: 'npm',
    name,
    versions: [
      {
        version,
        manifest: {
          name,
          version,
          ...opts.manifest,
          dist: {
            integrity: `sha512-${Buffer.from(hex, 'hex').toString('base64')}`,
            shasum: createHash('sha1').update(data).digest('hex'),
            tarball: `/${name}/-/${file}`,
          },
        },
        artifact: {
          file,
          contentType: 'application/octet-stream',
          data,
          integrity: { algorithm: 'sha512', hex },
        },
      },
    ],
    distTags: opts.tags ?? { latest: version },
    document: opts.document ?? { description: `${name} package` },
  };
}

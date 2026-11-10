import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inspectTarball } from '../../src/adapters/npm/tarball-check.ts';
import { makeTarball } from '../helpers/tarball.ts';

const LIMITS = { maxUnpackedBytes: 1024 * 1024 };

const POSIX_MAGIC = 'ustar\u000000';
const GNU_MAGIC = 'ustar  \u0000';

/**
 * One raw tar entry (header plus padded data). `magic` is the 8 bytes at offset 257 (magic and
 * version); `name` and `prefix` are written as given, so a test can put bytes after a NUL.
 */
function entry(
  path: string,
  content: string | Buffer,
  type = '0',
  prefix = '',
  magic = POSIX_MAGIC,
): Buffer {
  const data = typeof content === 'string' ? Buffer.from(content) : content;
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write(magic, 257, 8, 'latin1');
  if (prefix) header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

const END = Buffer.alloc(1024);

/** A pax record "<length> <key>=<value>\n", where <length> counts its own digits too. */
function record(k: string, v: string): string {
  const body = ` ${k}=${v}\n`;
  let len = body.length + String(body.length).length;
  len = body.length + String(len).length;
  return `${String(len)}${body}`;
}
const pkg = (name = '@acme/lib', version = '1.0.0') => JSON.stringify({ name, version });
const tgz = (...parts: Buffer[]) => gzipSync(Buffer.concat(parts));

describe('inspectTarball', () => {
  it('returns name and version of package/package.json', async () => {
    const data = makeTarball({ 'package.json': pkg(), 'index.js': 'module.exports = 1;' });
    expect(await inspectTarball(data, LIMITS)).toMatchObject({
      name: '@acme/lib',
      version: '1.0.0',
    });
  });

  it('follows ustar prefixes and pax path records', async () => {
    const viaPrefix = tgz(entry('package.json', pkg(), '0', 'package'), END);
    expect((await inspectTarball(viaPrefix, LIMITS)).name).toBe('@acme/lib');
    const viaPax = tgz(
      entry('PaxHeader', record('path', 'package/package.json'), 'x'),
      entry('ignored-name', pkg()),
      END,
    );
    expect((await inspectTarball(viaPax, LIMITS)).version).toBe('1.0.0');
  });

  it('accepts the pax records npm pack writes (path, mtime, a matching size)', async () => {
    const manifest = pkg();
    const data = tgz(
      entry(
        'PaxHeader',
        record('path', 'package/package.json') +
          record('mtime', '499162500') +
          record('size', String(Buffer.byteLength(manifest))),
        'x',
      ),
      entry('package/package.json', manifest),
      entry('PaxHeader', record('path', `package/${'d'.repeat(120)}/x.js`), 'x'),
      entry('ignored', 'x'),
      END,
    );
    expect((await inspectTarball(data, LIMITS)).name).toBe('@acme/lib');
  });

  it.each([
    ['package/./package.json', 'package/./package.json'],
    ['package//package.json', 'package//package.json'],
    ['a case variant', 'package/PACKAGE.json'],
    ['a trailing slash', 'package/package.json/'],
  ])('refuses a second manifest spelled as %s', async (_label, path) => {
    const data = tgz(entry('package/package.json', pkg()), entry(path, pkg('evil')), END);
    await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
    // Also when it comes first.
    const first = tgz(entry(path, pkg('evil')), entry('package/package.json', pkg()), END);
    await expect(inspectTarball(first, LIMITS)).rejects.toThrow(/invalid tarball/);
  });

  it.each([
    ['an empty segment', 'package/lib//x.js'],
    ['a "." segment', 'package/./lib/x.js'],
    ['a trailing "."', 'package/lib/.'],
  ])('refuses entry paths with %s', async (_label, path) => {
    const data = tgz(entry('package/package.json', pkg()), entry(path, 'x'), END);
    await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
  });

  it.each([
    ['a size that differs from the entry', record('size', '7'), 'x'],
    ['a linkpath record', record('path', 'package/a.js') + record('linkpath', '/etc/passwd'), 'x'],
    ['a charset record', record('hdrcharset', 'BINARY'), 'x'],
    ['a vendor record', record('SCHILY.xattr.user.x', 'y'), 'x'],
    ['a non-numeric mtime', record('mtime', 'soon'), 'x'],
    ['a non-numeric size', record('size', '1e3'), 'x'],
    ['an oversized size', record('size', '99999999999999'), 'x'],
    ['a duplicate key', record('path', 'package/a.js') + record('path', 'package/b.js'), 'x'],
    ['a record without its newline', record('path', 'package/a.js').replace(/\n$/, ' '), 'x'],
    ['a length with a leading zero', `0${record('path', 'package/a.js')}`, 'x'],
    ['a length that is not a number', `xx path=package/a.js\n`, 'x'],
    ['a global path record', record('path', 'package/package.json'), 'g'],
    ['a global size record', record('size', '3'), 'g'],
  ])('refuses a pax header with %s', async (_label, body, type) => {
    const data = tgz(
      entry('package/package.json', pkg()),
      entry('PaxHeader', body, type),
      entry('package/a.js', 'x = 1'),
      END,
    );
    await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
  });

  it('refuses a pax header that describes no entry, or two in a row', async () => {
    const dangling = tgz(
      entry('package/package.json', pkg()),
      entry('PaxHeader', record('path', 'package/a.js'), 'x'),
      END,
    );
    await expect(inspectTarball(dangling, LIMITS)).rejects.toThrow(/invalid tarball/);
    const twice = tgz(
      entry('package/package.json', pkg()),
      entry('PaxHeader', record('path', 'package/a.js'), 'x'),
      entry('PaxHeader', record('path', 'package/b.js'), 'x'),
      entry('package/a.js', 'x'),
      END,
    );
    await expect(inspectTarball(twice, LIMITS)).rejects.toThrow(/invalid tarball/);
  });

  it.each([
    ['not gzip', Buffer.from('plain text, not a tarball')],
    ['gzip of garbage', gzipSync(Buffer.from('x'.repeat(2000)))],
    ['no package.json', makeTarball({ 'index.js': '1' })],
    ['package.json outside package/', tgz(entry('other/package.json', pkg()), END)],
    ['invalid package.json', makeTarball({ 'package.json': '{ nope' })],
    ['package.json without a version', makeTarball({ 'package.json': '{"name":"x"}' })],
    [
      'two package.json entries',
      tgz(entry('package/package.json', pkg()), entry('package/package.json', pkg('evil')), END),
    ],
    [
      'a path escaping the package',
      tgz(entry('package/package.json', pkg()), entry('package/../../etc/x', 'x'), END),
    ],
    ['an absolute path', tgz(entry('package/package.json', pkg()), entry('/etc/passwd', 'x'), END)],
    ['a symlink', tgz(entry('package/package.json', pkg()), entry('package/link', '', '2'), END)],
    [
      'a truncated archive',
      gzipSync(Buffer.concat([entry('package/package.json', pkg())]).subarray(0, 700)),
    ],
    [
      'data after the end marker',
      tgz(entry('package/package.json', pkg()), END, entry('package/x', 'x')),
    ],
  ])('refuses %s', async (_label, data) => {
    await expect(inspectTarball(data, LIMITS)).rejects.toThrow();
  });

  it('refuses a bad header checksum', async () => {
    const raw = Buffer.concat([entry('package/package.json', pkg()), END]);
    raw[0] = 'q'.charCodeAt(0); // changes the name after the checksum was computed
    await expect(inspectTarball(gzipSync(raw), LIMITS)).rejects.toThrow(/checksum/);
  });

  it('stops decompressing at the unpacked size limit (gzip bomb)', async () => {
    const bomb = tgz(
      entry('package/package.json', pkg()),
      entry('package/zeros', Buffer.alloc(8 * 1024 * 1024)),
      END,
    );
    expect(bomb.length).toBeLessThan(64 * 1024);
    await expect(inspectTarball(bomb, LIMITS)).rejects.toThrow(/unpacked size/);
  });

  it('caps the size of package.json', async () => {
    const big = JSON.stringify({ name: 'x', version: '1.0.0', pad: 'p'.repeat(2 * 1024 * 1024) });
    await expect(
      inspectTarball(makeTarball({ 'package.json': big }), { maxUnpackedBytes: 8 * 1024 * 1024 }),
    ).rejects.toThrow(/package.json/);
  });

  describe("ustar prefix and magic, as npm's extractor (node-tar) reads them", () => {
    // node-tar joins the prefix field only when the 8 bytes at 257 are exactly "ustar\0" "00".
    it('refuses the manifest-confusion PoC: magic "ustar\\0" with version "  " and a prefix', async () => {
      // This checker used to read package/x/package/package.json (an ordinary file); npm
      // ignores the prefix for this version and extracts package/package.json, last one wins.
      const data = tgz(
        entry('package/package.json', pkg()),
        entry('package/package.json', pkg('@acme/lib', '6.6.6'), '0', 'package/x', 'ustar\u0000  '),
        END,
      );
      await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
      // Also with the confusing entry first.
      const first = tgz(
        entry('package/package.json', pkg('evil'), '0', 'package/x', 'ustar\u0000  '),
        entry('package/package.json', pkg()),
        END,
      );
      await expect(inspectTarball(first, LIMITS)).rejects.toThrow(/invalid tarball/);
    });

    it('accepts GNU tar headers ("ustar  \\0") without a prefix', async () => {
      const data = tgz(
        entry('package/package.json', pkg(), '0', '', GNU_MAGIC),
        entry('package/index.js', 'x', '0', '', GNU_MAGIC),
        END,
      );
      expect((await inspectTarball(data, LIMITS)).name).toBe('@acme/lib');
    });

    it('refuses GNU tar headers with a prefix field (node-tar ignores it)', async () => {
      const data = tgz(
        entry('package/package.json', pkg()),
        entry('package.json', pkg('evil'), '0', 'other', GNU_MAGIC),
        END,
      );
      await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
    });

    it.each([
      ['an old v7 header (no magic)', '\0'.repeat(8)],
      ['magic "ustar\\0" with version "01"', 'ustar\u000001'],
      ['magic "ustar\\0" with version "  "', 'ustar\u0000  '],
      ['magic "ustar " with version "00"', 'ustar 00'],
      ['an unknown magic', 'tar\0\0\0\0\0'],
    ])('refuses %s', async (_label, magic) => {
      const data = tgz(entry('package/package.json', pkg(), '0', '', magic), END);
      await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
    });

    it.each([
      // node-tar decodes a field with .replace(/\0.*/, ''), which stops at a newline: it would
      // read "package\n/../x" where a C-string reader sees "package".
      ['the name', entry('package\0\n/../../x.js', 'x')],
      ['the prefix', entry('x.js', 'x', '0', 'package\0\n/../..')],
    ])('refuses bytes after the NUL terminator of %s', async (_label, bad) => {
      const data = tgz(entry('package/package.json', pkg()), bad, END);
      await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
    });

    it('refuses bytes after the NUL terminator of a GNU long name', async () => {
      const data = tgz(
        entry('package/package.json', pkg()),
        entry('././@LongLink', 'package/a.js\0\n/../../x', 'L'),
        entry('ignored', 'x'),
        END,
      );
      await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
    });

    it('refuses a file entry whose path ends in a slash (node-tar makes it a directory)', async () => {
      const data = tgz(entry('package/package.json/', pkg()), END);
      await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
      const file = tgz(entry('package/package.json', pkg()), entry('package/a.js/', 'x'), END);
      await expect(inspectTarball(file, LIMITS)).rejects.toThrow(/invalid tarball/);
    });

    it.each([
      ['a trailing dot', 'package/package.json.'],
      ['a trailing space', 'package/package.json '],
      ['a dot-space mix in the directory', 'package. /package.json'],
    ])('refuses a second manifest with %s (Windows drops it)', async (_label, path) => {
      const data = tgz(entry('package/package.json', pkg()), entry(path, pkg('evil')), END);
      await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
    });
  });

  describe('entry sizes node-tar ignores', () => {
    it('refuses the PoC: a directory with a body that hides a second package.json', async () => {
      // node-tar forces a directory's size to 0 and reads its "body" as further headers.
      const smuggled = entry('package/package.json', pkg('@acme/lib', '6.6.6'));
      const dir = entry('package/d/', smuggled, '5');
      const data = tgz(entry('package/package.json', pkg()), dir, END);
      await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
    });

    it('refuses any directory entry with a size', async () => {
      const data = tgz(entry('package/package.json', pkg()), entry('package/d/', 'x', '5'), END);
      await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
      const ok = tgz(entry('package/package.json', pkg()), entry('package/d/', '', '5'), END);
      expect((await inspectTarball(ok, LIMITS)).name).toBe('@acme/lib');
    });

    it.each(['1', '2', '3', '4', '6', 'D', 'S'])('refuses entry type %s', async (type) => {
      const data = tgz(entry('package/package.json', pkg()), entry('package/x', '', type), END);
      await expect(inspectTarball(data, LIMITS)).rejects.toThrow(/invalid tarball/);
    });
  });

  it.each([
    ['package/binding.gyp', true],
    ['package/Binding.GYP', true],
    ['package/binding.gyp.', true],
    ['package/binding.gyp ', true],
    ['package/lib/binding.gyp', false],
  ])('reports %s as a binding.gyp: %s', async (path, expected) => {
    const data = tgz(entry('package/package.json', pkg()), entry(path, '{}'), END);
    expect((await inspectTarball(data, LIMITS)).hasBindingGyp).toBe(expected);
  });

  it('reports package/npm-shrinkwrap.json in any spelling', async () => {
    const without = tgz(entry('package/package.json', pkg()), END);
    expect((await inspectTarball(without, LIMITS)).hasShrinkwrap).toBe(false);
    const withIt = tgz(
      entry('package/package.json', pkg()),
      entry('package/NPM-shrinkwrap.json', '{}'),
      END,
    );
    expect((await inspectTarball(withIt, LIMITS)).hasShrinkwrap).toBe(true);
  });
});

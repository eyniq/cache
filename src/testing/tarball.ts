import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// Minimal ustar writer: enough for npm, pnpm and yarn to unpack a test package.
export function makeTarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`package/${path}`, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

export function sha512Integrity(buf: Buffer): string {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`;
}

export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

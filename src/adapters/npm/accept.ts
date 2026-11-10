// Content negotiation for packuments. npm, pnpm and yarn all send
// `application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*`.
export const ABBREVIATED_MEDIA_TYPE = 'application/vnd.npm.install-v1+json';

/** True when the client ranks the abbreviated form at least as high as plain JSON. */
export function prefersAbbreviated(accept: string): boolean {
  let abbreviated = 0;
  let json = -1;
  for (const range of accept.split(',')) {
    const [type = '', ...params] = range.split(';');
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    const t = type.trim().toLowerCase();
    if (t === ABBREVIATED_MEDIA_TYPE) abbreviated = Math.max(abbreviated, q);
    else if (t === 'application/json') json = Math.max(json, q);
  }
  return abbreviated > 0 && abbreviated >= json;
}

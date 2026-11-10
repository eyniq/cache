/** Weak comparison for If-None-Match (RFC 9110 section 13.1.2), including `*` and lists. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header || !etag) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value.trim() === '*') return true;
  const target = etag.replace(/^W\//, '');
  return value.split(',').some((t) => t.trim().replace(/^W\//, '') === target);
}

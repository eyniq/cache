// PUBLIC_URL_ALIASES: extra public base URLs for clients that reach the cache under another
// host (e.g. an in-cluster PUBLIC_URL plus a LAN host behind an ingress). A request whose Host
// header names an alias exactly gets documents with PUBLIC_URL swapped for that alias; every
// other request (unknown hosts included) keeps PUBLIC_URL, so the Host header can only pick a
// configured base. The swap runs on the pre-serialized bytes (no JSON parsing) and only for
// alias requests: the canonical hot path is unchanged.

/** Every occurrence of `from` in `body` replaced by `to`; the same Buffer when there is none. */
export function rebase(body: Buffer, from: Buffer, to: Buffer): Buffer {
  let at = body.indexOf(from);
  if (at === -1) return body;
  const parts: Buffer[] = [];
  let start = 0;
  while (at !== -1) {
    parts.push(body.subarray(start, at), to);
    start = at + from.length;
    at = body.indexOf(from, start);
  }
  parts.push(body.subarray(start));
  return Buffer.concat(parts);
}

export interface PublicUrlAlias {
  /** The alias base URL (no trailing slash), as configured. */
  base: string;
  /** The response body with PUBLIC_URL replaced by this alias. */
  rewrite(body: Buffer): Buffer;
  /** An ETag of its own, so a body validated for one base never matches another. */
  etag(etag: string): string;
}

export interface PublicUrls {
  /** The alias the Host header names, or null for PUBLIC_URL. */
  forHost(host: string | undefined): PublicUrlAlias | null;
}

const DEFAULT_PORT: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** `publicUrl` and `aliases` as loadConfig normalizes them (absolute, no trailing slash). */
export function createPublicUrls(publicUrl: string, aliases: readonly string[]): PublicUrls {
  const from = Buffer.from(`${publicUrl}/`);
  const byHost = new Map<string, PublicUrlAlias>();
  aliases.forEach((base, i) => {
    const url = new URL(base);
    const to = Buffer.from(`${base}/`);
    const alias: PublicUrlAlias = {
      base,
      rewrite: (body) => rebase(body, from, to),
      etag: (etag) => etag.replace(/"$/, `-a${i + 1}"`),
    };
    byHost.set(url.host, alias);
    // URL.host leaves the scheme's default port out; clients may still send it.
    if (url.port === '') byHost.set(`${url.hostname}:${DEFAULT_PORT[url.protocol]}`, alias);
  });
  return {
    forHost: (host) => (host === undefined ? null : (byHost.get(host.toLowerCase()) ?? null)),
  };
}

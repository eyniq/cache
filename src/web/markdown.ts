// Minimal, safe Markdown for README files in the web catalog (C5). The output is a JSON tree of
// a fixed set of node types; the browser builds DOM nodes from it with createElement and text
// nodes only, so nothing in a README is ever parsed as HTML:
//   - raw HTML is never passed through: tags are stripped (their text stays), comments and
//     the bodies of <script> and <style> are dropped;
//   - links survive only as absolute http, https or mailto URLs without credentials (parsed
//     with URL, so encodings, case and whitespace tricks cannot smuggle another scheme);
//   - images only when enabled (WEB_UI_IMAGES) and only over https; otherwise their alt text;
//   - bounded: input (default 64 KiB), node count (default 20,000), nesting depth (12), link
//     and delimiter look-ahead (a link destination is scanned once, at most MAX_URL + 200
//     characters, with its parenthesis balance counted on the way), and a global step budget
//     (characters scanned and loop rounds) after which the rest is cut off (`truncated`); no
//     regular expression runs over unbounded input, so hostile input costs linear time.
// Supported: ATX and setext headings, paragraphs, emphasis, strong, strikethrough, inline and
// fenced/indented code, ordered and unordered (nested) lists, blockquotes, rules, pipe tables,
// inline/reference/auto links, bare URLs, hard breaks, backslash escapes and entities.

export type MdNode = string | MdElement;

export type MdElement =
  | { t: 'h'; l: number; c: MdNode[] }
  | { t: 'p'; c: MdNode[] }
  | { t: 'em'; c: MdNode[] }
  | { t: 'strong'; c: MdNode[] }
  | { t: 'del'; c: MdNode[] }
  | { t: 'code'; code: string }
  | { t: 'pre'; code: string; lang?: string }
  | { t: 'a'; href: string; c: MdNode[] }
  | { t: 'img'; src: string; alt: string }
  | { t: 'ul'; items: MdNode[][] }
  | { t: 'ol'; start: number; items: MdNode[][] }
  | { t: 'quote'; c: MdNode[] }
  | { t: 'hr' }
  | { t: 'br' }
  | { t: 'table'; head: MdNode[][]; rows: MdNode[][][] };

export interface MarkdownOptions {
  /** Render https images (else their alt text). */
  images: boolean;
  /** Input beyond this many bytes is cut off. Default 64 KiB. */
  maxInputBytes?: number;
  /** Elements beyond this count are not rendered. Default 20,000. */
  maxNodes?: number;
  /** Work (characters scanned, loop rounds) before the rest is cut off. Default 1,000,000. */
  maxSteps?: number;
}

export interface MarkdownResult {
  nodes: MdNode[];
  /** Input or output was cut off at a limit. */
  truncated: boolean;
}

const MAX_DEPTH = 12;
const MAX_CANDIDATES = 50;
const MAX_LINK_TEXT = 1000;
const MAX_URL = 2048;
const MAX_TABLE_COLUMNS = 64;
const MAX_TABLE_ROWS = 1000;
/** Nested parentheses in a link destination (CommonMark implementations use 32). */
const MAX_PAREN_DEPTH = 32;

interface Ctx {
  images: boolean;
  maxNodes: number;
  nodes: number;
  maxSteps: number;
  steps: number;
  truncated: boolean;
  refs: Map<string, string>;
}

/** Out of nodes or out of steps: the rest is not rendered. */
function full(ctx: Ctx): boolean {
  if (ctx.nodes >= ctx.maxNodes || ctx.steps >= ctx.maxSteps) {
    ctx.truncated = true;
    return true;
  }
  return false;
}

/** Spaces at the end of `text` removed (a loop: a regex would rescan the whole buffer). */
function trimTrailingSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) end--;
  return end === text.length ? text : text.slice(0, end);
}

function el<T extends MdElement>(ctx: Ctx, node: T): T {
  ctx.nodes++;
  return node;
}

/** Absolute http(s)/mailto (links) or https (images) URL without credentials; else null. */
function safeUrl(raw: string, kind: 'link' | 'image'): string | null {
  const value = raw.trim();
  if (value === '' || value.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (kind === 'image') return url.protocol === 'https:' ? url.href : null;
  return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
    ? url.href
    : null;
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  middot: '·',
  times: '×',
  rarr: '→',
  larr: '←',
};

function decodeEntity(body: string): string | null {
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return '�';
    }
    return String.fromCodePoint(cp);
  }
  return Object.hasOwn(NAMED, body) ? (NAMED[body] ?? null) : null;
}

function pushText(out: MdNode[], text: string): void {
  if (text === '') return;
  const last = out.length - 1;
  if (typeof out[last] === 'string') out[last] = `${out[last]}${text}`;
  else out.push(text);
}

const isAlnum = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);
const PUNCT = /[!-/:-@[-`{-~]/;
const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]{1,2048})>/y;
const TAG = /<\/?[A-Za-z][A-Za-z0-9-]{0,30}(?:\s[^<>]{0,2000})?\/?>/y;
const BARE_URL = /https?:\/\/[^\s<>"'`]{1,2048}/y;

/** Text and nodes of one block's inline content. */
function parseInline(s: string, depth: number, ctx: Ctx, inLink = false): MdNode[] {
  const out: MdNode[] = [];
  if (depth > MAX_DEPTH) {
    pushText(out, s);
    return out;
  }
  // Next occurrence of a delimiter, cached so repeated look-ahead stays linear: a search from
  // `from` that found `at` answers every later search starting in [from, at].
  const cache = new Map<string, { from: number; at: number }>();
  const find = (delim: string, from: number): number => {
    const c = cache.get(delim);
    if (c && from >= c.from && (c.at === -1 || from <= c.at)) return c.at;
    const at = s.indexOf(delim, from);
    ctx.steps += ((at === -1 ? s.length : at) - from) >> 4; // a scan is cheap per character
    cache.set(delim, { from, at });
    return at;
  };
  let lower: string | null = null;
  let buf = '';
  const flush = (): void => {
    pushText(out, buf);
    buf = '';
  };
  const emit = (node: MdNode): void => {
    flush();
    if (typeof node === 'string') pushText(out, node);
    else out.push(node);
  };

  let i = 0;
  while (i < s.length) {
    ctx.steps++;
    if (full(ctx)) {
      buf += s.slice(i);
      break;
    }
    const ch = s[i] ?? '';
    const next = s[i + 1];

    if (ch === '\\' && next !== undefined) {
      if (next === '\n') {
        emit(el(ctx, { t: 'br' }));
        i += 2;
        continue;
      }
      if (PUNCT.test(next)) {
        buf += next;
        i += 2;
        continue;
      }
    }

    if (ch === '\n') {
      if (buf.endsWith('  ')) {
        buf = trimTrailingSpaces(buf);
        emit(el(ctx, { t: 'br' }));
      } else {
        buf = `${trimTrailingSpaces(buf)} `;
      }
      i++;
      while (s[i] === ' ') i++;
      continue;
    }

    if (ch === '`') {
      let k = 1;
      while (s[i + k] === '`') k++;
      const run = '`'.repeat(k);
      let at = find(run, i + k);
      let tries = 0;
      while (at !== -1 && tries++ < MAX_CANDIDATES && (s[at + k] === '`' || s[at - 1] === '`')) {
        let end = at;
        while (s[end] === '`') end++;
        at = find(run, end);
      }
      if (at !== -1 && tries <= MAX_CANDIDATES) {
        let code = s.slice(i + k, at).replace(/\n/g, ' ');
        if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
          code = code.slice(1, -1);
        }
        emit(el(ctx, { t: 'code', code }));
        i = at + k;
        continue;
      }
      buf += run;
      i += k;
      continue;
    }

    if (ch === '!' && next === '[') {
      const image = parseLinkLike(s, i + 1, depth, ctx, find, true);
      if (image) {
        emit(image.node);
        i = image.end;
        continue;
      }
    }

    if (ch === '[' && !inLink) {
      const link = parseLinkLike(s, i, depth, ctx, find, false);
      if (link) {
        if (typeof link.node === 'string' || link.node.t !== 'a') {
          // Unsafe target: keep the text, drop the link.
          flush();
          const children = Array.isArray(link.children) ? link.children : [];
          for (const c of children) {
            if (typeof c === 'string') pushText(out, c);
            else out.push(c);
          }
        } else {
          emit(link.node);
        }
        i = link.end;
        continue;
      }
    }

    if (ch === '<') {
      AUTOLINK.lastIndex = i;
      const auto = AUTOLINK.exec(s);
      if (auto) {
        const target = auto[1] ?? '';
        const href = safeUrl(target, 'link');
        if (href && !inLink) emit(el(ctx, { t: 'a', href, c: [target] }));
        else buf += target;
        i = AUTOLINK.lastIndex;
        continue;
      }
      if (s.startsWith('<!--', i)) {
        const end = find('-->', i + 4);
        i = end === -1 ? s.length : end + 3;
        continue;
      }
      TAG.lastIndex = i;
      const tag = TAG.exec(s);
      if (tag) {
        ctx.steps += tag[0].length >> 4;
        const name = /^<([a-z0-9-]+)/i.exec(tag[0])?.[1]?.toLowerCase();
        i = TAG.lastIndex;
        if (name === 'script' || name === 'style') {
          // Their bodies are code, never content: drop up to the closing tag (or the end).
          if (lower === null) {
            lower = s.toLowerCase();
            ctx.steps += s.length >> 4;
          }
          const close = lower.indexOf(`</${name}`, i);
          const gt = close === -1 ? -1 : s.indexOf('>', close);
          ctx.steps += ((gt === -1 ? s.length : gt) - i) >> 4;
          i = gt === -1 ? s.length : gt + 1;
        }
        continue;
      }
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const em = parseEmphasis(s, i, depth, ctx, find, inLink);
      if (em) {
        emit(em.node);
        i = em.end;
        continue;
      }
      let k = 1;
      while (s[i + k] === ch) k++;
      buf += s.slice(i, i + k);
      i += k;
      continue;
    }

    if (ch === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(s);
      const decoded = m ? decodeEntity(m[1] ?? '') : null;
      if (m && decoded !== null) {
        buf += decoded;
        i = ENTITY.lastIndex;
        continue;
      }
    }

    if (ch === 'h' && !inLink && !isAlnum(s[i - 1]) && s.startsWith('http', i)) {
      BARE_URL.lastIndex = i;
      const m = BARE_URL.exec(s);
      if (m) {
        ctx.steps += m[0].length >> 2;
        let url = m[0];
        // Trailing punctuation belongs to the sentence; a ")" only to a URL that opened one.
        let opens = 0;
        let closes = 0;
        for (const c of url) {
          if (c === '(') opens++;
          else if (c === ')') closes++;
        }
        for (;;) {
          const last = url[url.length - 1] ?? '';
          if ('.,:;!?*_~'.includes(last)) url = url.slice(0, -1);
          else if (last === ')' && opens < closes) {
            url = url.slice(0, -1);
            closes--;
          } else break;
        }
        const href = safeUrl(url, 'link');
        if (href) {
          emit(el(ctx, { t: 'a', href, c: [url] }));
          i += url.length;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

type Finder = (delim: string, from: number) => number;

/** `*em*`, `**strong**`, `~~del~~` (and `_`/`__`, never inside words). */
function parseEmphasis(
  s: string,
  i: number,
  depth: number,
  ctx: Ctx,
  find: Finder,
  inLink: boolean,
): { node: MdElement; end: number } | null {
  const ch = s[i] ?? '';
  let k = 1;
  while (s[i + k] === ch) k++;
  const size = ch === '~' ? (k === 2 ? 2 : 0) : k >= 2 ? 2 : 1;
  if (size === 0) return null;
  if (ch === '_' && isAlnum(s[i - 1])) return null;
  const delim = ch.repeat(size);
  const start = i + size;
  if (isSpace(s[start])) return null;
  let at = find(delim, start + 1);
  for (let tries = 0; at !== -1 && tries < MAX_CANDIDATES; tries++) {
    ctx.steps++;
    const closesHere =
      !isSpace(s[at - 1]) && (ch !== '_' || !isAlnum(s[at + size])) && s[at - 1] !== '\\';
    if (closesHere) {
      const inner = s.slice(start, at);
      const t = ch === '~' ? 'del' : size === 2 ? 'strong' : 'em';
      return {
        node: el(ctx, { t, c: parseInline(inner, depth + 1, ctx, inLink) }),
        end: at + size,
      };
    }
    at = find(delim, at + 1);
  }
  return null;
}

/**
 * `[text](url)`, `[text][ref]`, `[ref]` (links) or `![alt](src)` (images, at `i` = "[").
 * `node` is the element, or for an unsafe target the text alone (in `children`).
 */
function parseLinkLike(
  s: string,
  i: number,
  depth: number,
  ctx: Ctx,
  find: Finder,
  image: boolean,
): { node: MdNode; end: number; children?: MdNode[] } | null {
  let textEnd: number;
  let children: MdNode[] | null = null;
  // A badge: [![alt](img)](href) has an image as its whole text.
  if (!image && s.startsWith('![', i + 1)) {
    const inner = parseLinkLike(s, i + 2, depth + 1, ctx, find, true);
    if (inner && s[inner.end] === ']') {
      textEnd = inner.end;
      children = [inner.node];
    } else {
      textEnd = find(']', i + 1);
    }
  } else {
    textEnd = find(']', i + 1);
  }
  ctx.steps++;
  if (textEnd === -1 || textEnd - i - 1 > MAX_LINK_TEXT) return null;
  const text = s.slice(i + 1, textEnd);
  let target: string | null;
  let end = textEnd + 1;
  if (s[textEnd + 1] === '(') {
    const dest = linkDestination(s, textEnd + 2, ctx);
    if (!dest) return null;
    target = dest.target;
    end = dest.close + 1;
  } else if (s[textEnd + 1] === '[') {
    const close = find(']', textEnd + 2);
    if (close === -1 || close - textEnd > MAX_LINK_TEXT) return null;
    const label = s.slice(textEnd + 2, close) || text;
    const ref = ctx.refs.get(normalizeLabel(label));
    if (ref === undefined) return null;
    target = ref;
    end = close + 1;
  } else {
    const ref = ctx.refs.get(normalizeLabel(text));
    if (ref === undefined) return null;
    target = ref;
  }
  if (image) {
    const src = ctx.images ? safeUrl(target, 'image') : null;
    const alt = text.replace(/[\\*_`[\]]/g, '').slice(0, 500);
    return { node: src ? el(ctx, { t: 'img', src, alt }) : alt, end };
  }
  const kids = children ?? parseInline(text, depth + 1, ctx, true);
  const href = safeUrl(target, 'link');
  if (!href) return { node: '', end, children: kids };
  return { node: el(ctx, { t: 'a', href, c: kids }), end };
}

const isWhite = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n';

/**
 * The destination of an inline link starting after "(", and the index of its closing ")":
 * `<...>` or a run without spaces whose parentheses balance (at most 32 deep), then an optional
 * title. One forward scan of at most MAX_URL + 200 characters; null when there is no valid end.
 */
function linkDestination(
  s: string,
  start: number,
  ctx: Ctx,
): { target: string; close: number } | null {
  const limit = Math.min(s.length, start + MAX_URL + 200);
  let p = start;
  while (p < limit && isWhite(s[p])) p++;
  let target: string;
  if (s[p] === '<') {
    let q = p + 1;
    while (q < limit && s[q] !== '>') {
      if (s[q] === '<' || s[q] === '\n') break;
      q += s[q] === '\\' ? 2 : 1;
    }
    ctx.steps += (q - start) >> 2;
    if (q >= limit || s[q] !== '>') return null;
    target = s.slice(p + 1, q);
    p = q + 1;
  } else {
    let q = p;
    let depth = 0;
    while (q < limit) {
      const c = s[q] ?? '';
      if (c === '\\' && q + 1 < limit) {
        q += 2;
        continue;
      }
      if (c === '(') {
        if (++depth > MAX_PAREN_DEPTH) break;
      } else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c <= ' ') {
        break;
      }
      q++;
    }
    ctx.steps += (q - start) >> 2;
    if (q >= limit || depth > MAX_PAREN_DEPTH) return null;
    target = s.slice(p, q);
    p = q;
  }
  const spaced = p < limit && isWhite(s[p]);
  while (p < limit && isWhite(s[p])) p++;
  if (s[p] === ')') return { target, close: p };
  // An optional title: "...", '...' or (...), after white space.
  const open = s[p];
  if (!spaced || (open !== '"' && open !== "'" && open !== '(')) return null;
  const closer = open === '(' ? ')' : open;
  let q = p + 1;
  while (q < limit && s[q] !== closer) q += s[q] === '\\' ? 2 : 1;
  ctx.steps += (q - p) >> 2;
  if (q >= limit) return null;
  p = q + 1;
  while (p < limit && isWhite(s[p])) p++;
  return s[p] === ')' ? { target, close: p } : null;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---- Blocks -------------------------------------------------------------------------------

function indentOf(line: string): number {
  let n = 0;
  while (line[n] === ' ') n++;
  return n;
}

const isBlank = (line: string): boolean => line.trim() === '';

function atxHeading(line: string): { level: number; text: string } | null {
  const indent = indentOf(line);
  if (indent > 3) return null;
  let level = 0;
  while (line[indent + level] === '#') level++;
  if (level === 0 || level > 6) return null;
  const after = line[indent + level];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  let text = line.slice(indent + level).trim();
  // Optional closing sequence: " ###".
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === 0) text = '';
  else if (end < text.length && text[end - 1] === ' ') text = text.slice(0, end).trim();
  return { level, text };
}

function isRule(line: string): boolean {
  if (indentOf(line) > 3) return false;
  const compact = line.replace(/[ \t]/g, '');
  if (compact.length < 3) return false;
  const c = compact[0] ?? '';
  if (c !== '-' && c !== '*' && c !== '_') return false;
  for (const x of compact) if (x !== c) return false;
  return true;
}

function fenceOpen(line: string): { indent: number; marker: string; lang?: string } | null {
  const indent = indentOf(line);
  if (indent > 3) return null;
  const c = line[indent];
  if (c !== '`' && c !== '~') return null;
  let k = 0;
  while (line[indent + k] === c) k++;
  if (k < 3) return null;
  const info = line.slice(indent + k).trim();
  if (c === '`' && info.includes('`')) return null;
  const lang = info.split(/\s/, 1)[0] ?? '';
  return {
    indent,
    marker: c.repeat(k),
    ...(/^[A-Za-z0-9_+#.-]{1,32}$/.test(lang) ? { lang } : {}),
  };
}

function isFenceClose(line: string, marker: string): boolean {
  if (indentOf(line) > 3) return false;
  const t = line.trim();
  const c = marker[0] ?? '';
  if (t.length < marker.length) return false;
  for (const x of t) if (x !== c) return false;
  return true;
}

interface ListMarker {
  indent: number;
  ordered: boolean;
  /** "-", "*", "+", "." or ")". */
  kind: string;
  start: number;
  /** Column where the item content starts. */
  content: number;
  empty: boolean;
}

function listMarker(line: string): ListMarker | null {
  const indent = indentOf(line);
  if (indent > 3) return null;
  let pos = indent;
  let ordered = false;
  let kind: string;
  let start = 1;
  const c = line[pos] ?? '';
  if (c === '-' || c === '*' || c === '+') {
    kind = c;
    pos++;
  } else {
    let digits = 0;
    while (digits < 10 && /[0-9]/.test(line[pos + digits] ?? '')) digits++;
    if (digits === 0 || digits > 9) return null;
    const d = line[pos + digits];
    if (d !== '.' && d !== ')') return null;
    ordered = true;
    kind = d;
    start = Number(line.slice(pos, pos + digits));
    pos += digits + 1;
  }
  const rest = line.slice(pos);
  if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
  const spaces = indentOf(rest);
  const empty = rest.trim() === '';
  const content = pos + (empty || spaces > 4 ? 1 : spaces);
  return { indent, ordered, kind, start, content, empty };
}

const SCRIPT_START = /^ {0,3}<(script|style)(?:[\s>]|$)/i;

function startsBlock(line: string): boolean {
  if (atxHeading(line) || isRule(line) || fenceOpen(line)) return true;
  if (/^ {0,3}>/.test(line) || SCRIPT_START.test(line) || /^ {0,3}<!--/.test(line)) return true;
  const m = listMarker(line);
  // Only a non-empty item interrupts a paragraph (and an ordered one only when it starts at 1).
  return m !== null && !m.empty && (!m.ordered || m.start === 1);
}

function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length && cells.length < MAX_TABLE_COLUMNS; i++) {
    const c = t[i] ?? '';
    if (c === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cells.length < MAX_TABLE_COLUMNS) cells.push(cur.trim());
  return cells;
}

function isDelimiterRow(line: string | undefined): number {
  if (line === undefined || !line.includes('-')) return 0;
  const cells = splitCells(line);
  return cells.every((c) => /^:?-+:?$/.test(c)) ? cells.length : 0;
}

function parseBlocks(lines: string[], depth: number, ctx: Ctx): MdNode[] {
  const out: MdNode[] = [];
  let i = 0;
  while (i < lines.length && !full(ctx)) {
    const line = lines[i] ?? '';
    ctx.steps += 1 + (line.length >> 4);
    if (isBlank(line)) {
      i++;
      continue;
    }

    // Indented code.
    if (indentOf(line) >= 4) {
      const code: string[] = [];
      while (i < lines.length && (isBlank(lines[i] ?? '') || indentOf(lines[i] ?? '') >= 4)) {
        code.push((lines[i] ?? '').slice(4));
        i++;
      }
      while (code.length > 0 && isBlank(code[code.length - 1] ?? '')) code.pop();
      out.push(el(ctx, { t: 'pre', code: code.join('\n') }));
      continue;
    }

    const fence = fenceOpen(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i] ?? '', fence.marker)) {
        const l = lines[i] ?? '';
        code.push(l.slice(Math.min(fence.indent, indentOf(l))));
        i++;
      }
      i++; // the closing fence (or the end)
      out.push(
        el(ctx, {
          t: 'pre',
          code: code.join('\n'),
          ...(fence.lang !== undefined ? { lang: fence.lang } : {}),
        }),
      );
      continue;
    }

    const heading = atxHeading(line);
    if (heading) {
      out.push(el(ctx, { t: 'h', l: heading.level, c: parseInline(heading.text, depth, ctx) }));
      i++;
      continue;
    }

    if (isRule(line)) {
      out.push(el(ctx, { t: 'hr' }));
      i++;
      continue;
    }

    // Raw HTML whose content is never text: dropped up to its end.
    const script = SCRIPT_START.exec(line);
    if (script || /^ {0,3}<!--/.test(line)) {
      const end = script ? `</${(script[1] ?? '').toLowerCase()}` : '-->';
      while (i < lines.length && !(lines[i] ?? '').toLowerCase().includes(end)) i++;
      i++;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i] ?? '')) {
        inner.push((lines[i] ?? '').replace(/^ {0,3}> ?/, ''));
        i++;
      }
      if (depth >= MAX_DEPTH) {
        out.push(el(ctx, { t: 'p', c: [inner.join(' ')] }));
      } else {
        out.push(el(ctx, { t: 'quote', c: parseBlocks(inner, depth + 1, ctx) }));
      }
      continue;
    }

    const marker = listMarker(line);
    if (marker) {
      i = parseList(lines, i, marker, depth, ctx, out);
      continue;
    }

    const columns = line.includes('|') ? isDelimiterRow(lines[i + 1]) : 0;
    if (columns > 0 && splitCells(line).length === columns) {
      const head = splitCells(line).map((c) => parseInline(c, depth, ctx));
      const rows: MdNode[][][] = [];
      i += 2;
      while (
        i < lines.length &&
        !isBlank(lines[i] ?? '') &&
        !startsBlock(lines[i] ?? '') &&
        rows.length < MAX_TABLE_ROWS &&
        !full(ctx)
      ) {
        const cells = splitCells(lines[i] ?? '').slice(0, columns);
        while (cells.length < columns) cells.push('');
        rows.push(cells.map((c) => parseInline(c, depth, ctx)));
        i++;
      }
      out.push(el(ctx, { t: 'table', head, rows }));
      continue;
    }

    // Paragraph (or setext heading).
    const para: string[] = [line.trim()];
    i++;
    let level = 0;
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (isBlank(l)) break;
      const t = l.trim();
      if (indentOf(l) <= 3 && /^=+$/.test(t)) {
        level = 1;
        i++;
        break;
      }
      if (indentOf(l) <= 3 && /^-+$/.test(t)) {
        level = 2;
        i++;
        break;
      }
      if (startsBlock(l)) break;
      if (l.includes('|') && isDelimiterRow(lines[i + 1]) > 0) break;
      para.push(l.replace(/^ +/, ''));
      i++;
    }
    const text = para.join('\n');
    if (level > 0) out.push(el(ctx, { t: 'h', l: level, c: parseInline(text, depth, ctx) }));
    else out.push(el(ctx, { t: 'p', c: parseInline(text, depth, ctx) }));
  }
  return out;
}

/** Parses a list starting at `start`; returns the index after it. */
function parseList(
  lines: string[],
  start: number,
  first: ListMarker,
  depth: number,
  ctx: Ctx,
  out: MdNode[],
): number {
  const items: MdNode[][] = [];
  let i = start;
  while (i < lines.length && !full(ctx)) {
    const m = listMarker(lines[i] ?? '');
    if (!m || m.ordered !== first.ordered || m.kind !== first.kind) break;
    const itemLines = [m.empty ? '' : (lines[i] ?? '').slice(m.content)];
    i++;
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (isBlank(l)) {
        let j = i;
        while (j < lines.length && isBlank(lines[j] ?? '')) j++;
        if (j < lines.length && indentOf(lines[j] ?? '') >= m.content) {
          for (; i < j; i++) itemLines.push('');
          continue;
        }
        break;
      }
      if (indentOf(l) >= m.content) {
        itemLines.push(l.slice(m.content));
        i++;
        continue;
      }
      if (listMarker(l) || startsBlock(l)) break;
      // Lazy continuation of the item's paragraph.
      if (!isBlank(itemLines[itemLines.length - 1] ?? '')) {
        itemLines.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    items.push(
      depth >= MAX_DEPTH
        ? [el(ctx, { t: 'p', c: [itemLines.join(' ').trim()] })]
        : parseBlocks(itemLines, depth + 1, ctx),
    );
    // A blank line between items keeps the list going.
    let j = i;
    while (j < lines.length && isBlank(lines[j] ?? '')) j++;
    const nextMarker = j < lines.length ? listMarker(lines[j] ?? '') : null;
    if (
      nextMarker &&
      nextMarker.ordered === first.ordered &&
      nextMarker.kind === first.kind &&
      nextMarker.indent < m.content
    ) {
      i = j;
      continue;
    }
    break;
  }
  out.push(
    first.ordered ? el(ctx, { t: 'ol', start: first.start, items }) : el(ctx, { t: 'ul', items }),
  );
  return i;
}

const REF_DEF =
  /^ {0,3}\[([^\]\n]{1,200})\]:[ \t]*<?([^\s>]{1,2048})>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/;

/** Collects reference definitions (outside code fences) and blanks their lines. */
function collectRefs(lines: string[], refs: Map<string, string>): void {
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (fence !== null) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      fence = open.marker;
      continue;
    }
    if (line.length > 2400 || !line.includes(']:')) continue;
    const m = REF_DEF.exec(line);
    if (!m) continue;
    const label = normalizeLabel(m[1] ?? '');
    if (!refs.has(label)) refs.set(label, m[2] ?? '');
    lines[i] = '';
  }
}

export function renderMarkdown(source: string, opts: MarkdownOptions): MarkdownResult {
  const maxInput = opts.maxInputBytes ?? 64 * 1024;
  let truncated = false;
  let src = source;
  if (Buffer.byteLength(src, 'utf8') > maxInput) {
    src = Buffer.from(src, 'utf8').subarray(0, maxInput).toString('utf8');
    truncated = true;
  }
  const lines = src
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => {
      // Leading tabs count as four spaces (indentation decides code blocks and list items).
      let n = 0;
      while (l[n] === '\t' || l[n] === ' ') n++;
      return n === 0 ? l : l.slice(0, n).replace(/\t/g, '    ') + l.slice(n);
    });
  const ctx: Ctx = {
    images: opts.images,
    maxNodes: opts.maxNodes ?? 20_000,
    nodes: 0,
    maxSteps: opts.maxSteps ?? 1_000_000,
    steps: 0,
    truncated: false,
    refs: new Map(),
  };
  collectRefs(lines, ctx.refs);
  const nodes = parseBlocks(lines, 0, ctx);
  return { nodes, truncated: truncated || ctx.truncated };
}

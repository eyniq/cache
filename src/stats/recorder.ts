// Records the statistics history of one pod (DESIGN.md section 17). Every interval it turns
// the difference between two metric samples into a point; points are batched per hour into
// storage objects that only this pod writes, so the writes need no compare-and-swap. Storage
// trouble is counted and logged (throttled) and never reaches request handling.
import { Readable } from 'node:stream';
import type { Storage } from '../core/contracts.ts';
import { errorFields, log } from '../core/log.ts';
import { readLimited } from '../core/streams.ts';
import { isStorageAdmin } from '../core/storage.ts';
import {
  dayKey,
  dayStart,
  hourKey,
  hourStart,
  minuteKey,
  monthStart,
  nextMonth,
  parseKey,
} from './keys.ts';
import { diffSample, parsePointsCounted, rollup } from './points.ts';
import type { StatsPoint, StatsSample, StatsTier } from './types.ts';

const FLUSH_INTERVAL_MS = 300_000;
const PRUNE_INTERVAL_MS = 6 * 3_600_000;
/** The first prune waits this long after start, so a boot never starts with a storage sweep. */
const FIRST_PRUNE_DELAY_MS = 600_000;
const STOP_TIMEOUT_MS = 5000;
const WARN_INTERVAL_MS = 600_000;
/** Same cap as the reader, so nothing is written that the reader would skip. */
const MAX_OBJECT_BYTES = 2 * 1024 * 1024;
/** Unflushed objects kept while storage is failing; the oldest are dropped beyond this. */
const MAX_PENDING_OBJECTS = 6;
const MAX_PRUNE_PAGES = 50;

class OversizedObjectError extends Error {}

export interface StatsRetention {
  /** 0 keeps the tier forever. */
  minuteMs: number;
  hourMs: number;
  dayMs: number;
}

export interface RecorderOptions {
  storage: Storage;
  /** Reads the cumulative metrics; called once per tick, never on the request path. */
  source: () => StatsSample;
  /** Sanitized pod id (the only writer of its own keys). */
  pod: string;
  intervalMs: number;
  retention: StatsRetention;
  flushIntervalMs?: number;
  now?: () => number;
  onWriteError?: () => void;
}

interface StatsObject {
  key: string;
  tier: StatsTier;
  start: number;
  end: number;
  points: StatsPoint[];
  /** Merged with what an earlier run of this pod left in storage. */
  loaded: boolean;
  dirty: boolean;
}

function upsert(points: StatsPoint[], p: StatsPoint): void {
  const i = points.findIndex((x) => x.t === p.t);
  if (i === -1) points.push(p);
  else points[i] = p;
  points.sort((a, b) => a.t - b.t);
}

export class StatsRecorder {
  private readonly o: Required<Omit<RecorderOptions, 'onWriteError'>> & {
    onWriteError: (() => void) | undefined;
  };
  private readonly objects = new Map<string, StatsObject>();
  private prev: StatsSample | null = null;
  private prevAtMs = 0;
  private lastFlushMs = 0;
  private lastPruneMs = 0;
  private lastWarnMs = 0;
  private lastHour = -1;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** Flushes queued or running; a timer-driven flush is skipped while one is active. */
  private active = 0;
  private warnedOversized = false;
  private stopping = false;

  constructor(options: RecorderOptions) {
    this.o = {
      flushIntervalMs: FLUSH_INTERVAL_MS,
      now: Date.now,
      onWriteError: undefined,
      ...options,
    };
  }

  start(): void {
    if (this.timer) return;
    const now = this.o.now();
    this.prev = this.o.source();
    this.prevAtMs = now;
    this.lastFlushMs = now;
    this.lastPruneMs = now + FIRST_PRUNE_DELAY_MS - PRUNE_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.tick();
    }, this.o.intervalMs);
    this.timer.unref();
  }

  /** Takes one point from the activity since the last tick. Never throws. */
  tick(): void {
    try {
      const nowMs = this.o.now();
      const cur = this.o.source();
      const prev = this.prev;
      const seconds = (nowMs - this.prevAtMs) / 1000;
      this.prev = cur;
      this.prevAtMs = nowMs;
      if (!prev || seconds <= 0) return;
      const endSec = Math.floor(nowMs / 1000);
      const point = diffSample(prev, cur, endSec, seconds);
      const key = minuteKey(endSec, this.o.pod);
      let obj = this.objects.get(key);
      if (!obj) {
        const start = hourStart(endSec);
        obj = this.object(key, 'minute', start, start + 3600);
      }
      obj.points.push(point);
      obj.dirty = true;
      const hour = hourStart(endSec);
      const rolled = this.lastHour !== -1 && hour !== this.lastHour;
      this.lastHour = hour;
      if (
        (rolled || nowMs - this.lastFlushMs >= this.o.flushIntervalMs) &&
        this.active === 0 &&
        !this.stopping
      ) {
        void this.flush();
      }
    } catch (err) {
      this.failed(err);
    }
  }

  private object(key: string, tier: StatsTier, start: number, end: number): StatsObject {
    let obj = this.objects.get(key);
    if (!obj) {
      obj = { key, tier, start, end, points: [], loaded: false, dirty: false };
      this.objects.set(key, obj);
    }
    return obj;
  }

  /** Writes every dirty object (and the rollups derived from them). Serialized; never rejects. */
  flush(opts: { prune?: boolean } = {}): Promise<void> {
    this.active++;
    const run = this.chain.then(() => this.doFlush(opts.prune ?? true));
    this.chain = run
      .catch(() => undefined)
      .finally(() => {
        this.active--;
      });
    return this.chain;
  }

  private async doFlush(prune: boolean): Promise<void> {
    const nowMs = this.o.now();
    this.lastFlushMs = nowMs;
    try {
      const minutes = [...this.objects.values()]
        .filter((o) => o.tier === 'minute' && o.dirty)
        .sort((a, b) => a.start - b.start);
      for (const m of minutes) {
        if (!(await this.write(m))) continue;
        const hours = this.object(
          hourKey(m.start, this.o.pod),
          'hour',
          dayStart(m.start),
          dayStart(m.start) + 86_400,
        );
        upsert(hours.points, rollup(m.points, m.start));
        hours.dirty = true;
      }
      const hourObjs = [...this.objects.values()]
        .filter((o) => o.tier === 'hour' && o.dirty)
        .sort((a, b) => a.start - b.start);
      for (const h of hourObjs) {
        if (!(await this.write(h))) continue;
        const days = this.object(
          dayKey(h.start, this.o.pod),
          'day',
          monthStart(h.start),
          nextMonth(monthStart(h.start)),
        );
        upsert(days.points, rollup(h.points, h.start));
        days.dirty = true;
      }
      for (const d of [...this.objects.values()].filter((o) => o.tier === 'day' && o.dirty)) {
        await this.write(d);
      }
      this.evict(nowMs);
      if (prune && nowMs - this.lastPruneMs >= PRUNE_INTERVAL_MS) {
        this.lastPruneMs = nowMs;
        await this.prune(nowMs);
      }
    } catch (err) {
      this.failed(err);
    }
  }

  /** Merges with an earlier run's object once, then replaces the object. */
  private async write(obj: StatsObject): Promise<boolean> {
    try {
      if (!obj.loaded) {
        const existing = await this.readOwn(obj.key);
        const merged = new Map<number, StatsPoint>();
        for (const p of existing) merged.set(p.t, p);
        for (const p of obj.points) merged.set(p.t, p);
        obj.points = [...merged.values()].sort((a, b) => a.t - b.t);
        obj.loaded = true;
      }
      if (obj.points.length === 0) {
        obj.dirty = false;
        return true;
      }
      const body = Buffer.from(`${obj.points.map((p) => JSON.stringify(p)).join('\n')}\n`);
      await this.o.storage.put(obj.key, Readable.from(body), {
        contentType: 'application/x-ndjson',
      });
      obj.dirty = false;
      return true;
    } catch (err) {
      this.failed(err);
      return false;
    }
  }

  /** An oversized existing object of this pod is replaced (logged once), not merged. */
  private async readOwn(key: string): Promise<StatsPoint[]> {
    try {
      const stream = await this.o.storage.get(key);
      if (!stream) return [];
      const buf = await readLimited(
        stream,
        MAX_OBJECT_BYTES,
        () => new OversizedObjectError('stats object too large'),
      );
      return parsePointsCounted(buf.toString('utf8')).points;
    } catch (err) {
      if (!(err instanceof OversizedObjectError)) throw err;
      if (!this.warnedOversized) {
        this.warnedOversized = true;
        log.warn('stats history object is too large and is overwritten', { key });
      }
      return [];
    }
  }

  /** Drops written objects of past periods and the oldest pending ones when storage is down. */
  private evict(nowMs: number): void {
    const nowSec = Math.floor(nowMs / 1000);
    for (const [key, obj] of this.objects) {
      if (!obj.dirty && obj.end <= nowSec - 3600) this.objects.delete(key);
    }
    const pending = [...this.objects.values()]
      .filter((o) => o.dirty)
      .sort((a, b) => a.start - b.start);
    while (pending.length > MAX_PENDING_OBJECTS) {
      const dropped = pending.shift();
      if (dropped) this.objects.delete(dropped.key);
      this.failed(new Error('dropped an unwritten stats object'));
    }
  }

  /**
   * Deletes expired objects of every pod (a rollout leaves dead pods' objects behind; an
   * object past its retention has no live writer); skipped when the storage cannot list.
   */
  private async prune(nowMs: number): Promise<void> {
    const storage = this.o.storage;
    if (!isStorageAdmin(storage)) return;
    const nowSec = nowMs / 1000;
    const keep: Record<StatsTier, number> = {
      minute: this.o.retention.minuteMs / 1000,
      hour: this.o.retention.hourMs / 1000,
      day: this.o.retention.dayMs / 1000,
    };
    for (const tier of ['minute', 'hour', 'day'] as const) {
      if (keep[tier] === 0) continue;
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PRUNE_PAGES; page++) {
        const res = await storage.list(`stats/${tier}/`, cursor ? { cursor } : {});
        for (const e of res.entries) {
          const parsed = parseKey(e.key);
          if (parsed?.tier !== tier) continue;
          if (parsed.end < nowSec - keep[tier] && !this.objects.has(e.key)) {
            await storage.delete(e.key);
          }
        }
        cursor = res.cursor;
        if (!cursor) break;
      }
    }
  }

  private failed(err: unknown): void {
    this.o.onWriteError?.();
    const now = this.o.now();
    if (now - this.lastWarnMs >= WARN_INTERVAL_MS) {
      this.lastWarnMs = now;
      log.warn('stats history write failed', errorFields(err));
    }
  }

  /** Final partial tick and flush (no prune), bounded by a timeout. Never throws. */
  async stop(timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    this.stopping = true;
    try {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        if (this.o.now() > this.prevAtMs) this.tick();
      }
      await Promise.race([
        this.flush({ prune: false }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } catch (err) {
      this.failed(err);
    } finally {
      clearTimeout(timer);
    }
  }
}

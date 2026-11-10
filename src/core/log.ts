// JSON-lines logger on stdout (DESIGN.md section 9). Never log request bodies or tokens.
import type { LogLevel } from '../config.ts';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;
type Sink = (line: LogFields) => void;

const stdoutSink: Sink = (line) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

let sink: Sink = stdoutSink;
let threshold = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

function emit(level: LogLevel, msg: string, fields: LogFields): void {
  if (LEVELS[level] < threshold) return;
  sink({ time: new Date().toISOString(), level, msg, ...fields });
}

/** Audit records are written whatever LOG_LEVEL says: they are a record, not diagnostics. */
export function writeAudit(fields: LogFields): void {
  // The envelope is applied last as well: event fields (open-ended) must not overwrite it,
  // or audit lines would stop matching msg="audit" filters. Key order stays envelope-first.
  const envelope = { time: new Date().toISOString(), level: 'info', msg: 'audit' };
  sink({ ...envelope, ...fields, ...envelope });
}

export const log = {
  debug: (msg: string, fields: LogFields = {}) => {
    emit('debug', msg, fields);
  },
  info: (msg: string, fields: LogFields = {}) => {
    emit('info', msg, fields);
  },
  warn: (msg: string, fields: LogFields = {}) => {
    emit('warn', msg, fields);
  },
  error: (msg: string, fields: LogFields = {}) => {
    emit('error', msg, fields);
  },
};

export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) return { error: err.message, errorName: err.name };
  return { error: String(err) };
}

export interface CapturedLogs {
  lines: LogFields[];
  restore(): void;
}

/** Test helper: capture log lines in memory instead of writing to stdout. */
export function captureLogs(): CapturedLogs {
  const lines: LogFields[] = [];
  const previous = sink;
  sink = (line) => lines.push(line);
  return {
    lines,
    restore() {
      sink = previous;
    },
  };
}

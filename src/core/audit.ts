import type { AuditEvent, AuditSink } from './contracts.ts';
import { writeAudit } from './log.ts';

/** Who and which request an event belongs to (a RequestContext fits). */
export interface AuditOrigin {
  requestId?: string;
  identity?: string;
}

/** Builds an event stamped with the current time and, when given, request id and identity. */
export function auditEvent(
  type: AuditEvent['type'],
  fields: Record<string, unknown> = {},
  origin?: AuditOrigin,
): AuditEvent {
  return {
    ...fields,
    type,
    at: new Date().toISOString(),
    ...(origin?.requestId !== undefined ? { requestId: origin.requestId } : {}),
    ...(origin?.identity !== undefined ? { identity: origin.identity } : {}),
  };
}

/** Community default: audit events become structured log lines. Never throws. */
export class StdoutAuditSink implements AuditSink {
  record(event: AuditEvent): void {
    try {
      // The log line carries its own `time`; `at` would only repeat it.
      const fields: Record<string, unknown> = { ...event };
      Reflect.deleteProperty(fields, 'at');
      writeAudit(fields);
    } catch {
      // An audit sink must never break the request path.
    }
  }
}

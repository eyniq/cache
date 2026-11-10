import type { AuditEvent, AuditSink } from '../core/contracts.ts';

/** Test sink: keeps every audit event in memory. */
export class RecordingAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  record(event: AuditEvent): void {
    this.events.push(event);
  }

  ofType(type: string): AuditEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

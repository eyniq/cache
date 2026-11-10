// Test helpers and conformance suites (`@eyniq/cache/testing`). Never imported by the
// production entry points; excluded from the container build (tsconfig.build.json).
export {
  FakeUpstream,
  type FakeHook,
  type FakeVersion,
  type RecordedRequest,
} from './fake-upstream.ts';
export { ABBREVIATED_ACCEPT, json, send, type RawRequest, type RawResponse } from './http.ts';
export { makeTarball, sha1Hex, sha512Integrity } from './tarball.ts';
export { captureLogs, type CapturedLogs } from '../core/log.ts';
export { RecordingAuditSink } from './audit.ts';
export type { ConformanceCase } from './conformance.ts';
export { storageConformance, type StorageFactory } from './storage-conformance.ts';
export { policyConformance, type PolicyConformanceOptions } from './policy-conformance.ts';

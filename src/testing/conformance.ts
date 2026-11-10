/**
 * One conformance check. Suites return plain cases instead of calling a test framework, so
 * src stays dependency-free and any runner can execute them:
 *   for (const c of storageConformance(factory)) it(c.name, c.run);
 * Failures throw (node:assert).
 */
export interface ConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

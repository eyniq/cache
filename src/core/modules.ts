/**
 * Resolve a sibling module with the caller's own extension: `.ts` when running from source
 * (Vitest, Node type stripping), `.js` when running the compiled build from dist/.
 */
export function siblingModule(base: string, callerUrl: string): URL {
  const ext = callerUrl.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`${base}${ext}`, callerUrl);
}

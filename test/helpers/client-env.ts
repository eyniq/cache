// Environment for real package-manager clients in tests. CI runner pods set npm_config_registry and
// pnpm_config_registry to the cluster's cache; inherited, they would send the client there instead of to the cache
// under test.
export function clientEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(npm|pnpm|yarn)_config_/i.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

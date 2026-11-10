// `node dist/main.js stats [--range 24h]`: prints a compact summary read straight from
// storage with the same configuration as the server (no running server needed).
import { createStorage } from '../compose.ts';
import { ConfigError, loadConfig, type Env } from '../config.ts';
import { StatsReader, STATS_RANGES, isStatsRange } from './reader.ts';
import { formatSummary } from './summary.ts';

const USAGE = `usage: stats [--range ${STATS_RANGES.join('|')}]\n`;

export async function runStatsCli(
  args: string[],
  io: { env: Env; stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown } },
): Promise<number> {
  let range = '24h';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--range' && args[i + 1] !== undefined) {
      range = args[++i] ?? range;
    } else if (a?.startsWith('--range=')) {
      range = a.slice('--range='.length);
    } else {
      io.stderr.write(USAGE);
      return 2;
    }
  }
  if (!isStatsRange(range)) {
    io.stderr.write(USAGE);
    return 2;
  }
  try {
    const config = loadConfig(io.env);
    const storage = await createStorage(config);
    io.stdout.write(formatSummary(await new StatsReader(storage).query(range)));
    return 0;
  } catch (err) {
    io.stderr.write(
      `${err instanceof ConfigError || err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

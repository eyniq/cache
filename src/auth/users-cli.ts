// `user` subcommand of the community build: manages USERS_FILE.
//   node dist/main.js user add <name> --packages <pattern,...>
//   node dist/main.js user passwd <name>
//   node dist/main.js user remove <name>
//   node dist/main.js user list
// The file comes from USERS_FILE or --file. Passwords are read from the terminal without echo
// (asked twice), or as the first line of stdin when it is not a terminal; never from the
// command line, where they would end up in shell history and process listings.
import type { Readable, Writable } from 'node:stream';
import { isNamePattern } from '../core/patterns.ts';
import {
  DEFAULT_SCRYPT,
  PASSWORD_MAX_LENGTH,
  checkPasswordPolicy,
  hashPassword,
  type ScryptParams,
} from './password.ts';
import { UsersFile, generationOf, isValidUserName, nextGeneration } from './users.ts';

export interface UserCliIo {
  env: Record<string, string | undefined>;
  stdin: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdout: Writable;
  stderr: Writable;
  /** Tests only: cheaper hashes. */
  hashParams?: ScryptParams;
}

const USAGE = `usage: user <command> [options]
  user add <name> --packages <pattern,...>     add a user (password from the terminal or stdin)
  user passwd <name>                           change a password (ends the user's tokens)
  user remove <name>                           remove a user (ends the user's tokens)
  user list                                    list users and their publish patterns
options:
  --file <path>       the users file (default: $USERS_FILE)
  --packages <list>   packages the user may publish, e.g. "@acme/*,tool"; "*" for every
                      package this registry owns, "" for none (required for add)
`;

class UsageError extends Error {}

interface Parsed {
  command: string;
  name?: string;
  file?: string;
  packages?: string[];
}

function parseArgs(args: string[]): Parsed {
  const positional: string[] = [];
  let file: string | undefined;
  let packages: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--file' || a === '--packages') {
      const value = args[++i];
      if (value === undefined) throw new UsageError(`${a} needs a value`);
      if (a === '--file') file = value;
      else {
        packages = value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (!packages.every(isNamePattern)) throw new UsageError('invalid --packages pattern');
      }
    } else if (a.startsWith('--')) {
      throw new UsageError('unknown option');
    } else {
      positional.push(a);
    }
  }
  const [command, name, ...rest] = positional;
  // Never echo extra arguments: they may be a password typed on the command line.
  if (rest.length > 0) throw new UsageError('too many arguments (passwords are never arguments)');
  if (command === undefined) throw new UsageError('missing command');
  return {
    command,
    ...(name !== undefined ? { name } : {}),
    ...(file !== undefined ? { file } : {}),
    ...(packages !== undefined ? { packages } : {}),
  };
}

/** First line of a non-terminal stdin (at most PASSWORD_MAX_LENGTH + 2 bytes are kept). */
function readLine(stdin: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const done = (): void => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      stdin.pause();
    };
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1 || buf.length > PASSWORD_MAX_LENGTH + 2) {
        done();
        resolve((nl === -1 ? buf : buf.slice(0, nl)).replace(/\r$/, ''));
      }
    };
    const onEnd = (): void => {
      done();
      resolve(buf.replace(/\r?\n?$/, ''));
    };
    const onError = (err: Error): void => {
      done();
      reject(err);
    };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume();
  });
}

/** Reads a password from a terminal in raw mode, echoing nothing. */
function readHidden(io: UserCliIo, prompt: string): Promise<string> {
  const { stdin, stderr } = io;
  stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode?.(true);
    const finish = (err: Error | null): void => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of chunk.toString()) {
        if (ch === '\r' || ch === '\n') {
          finish(null);
          return;
        }
        if (ch === '\u0003' || (ch === '\u0004' && value === '')) {
          finish(new UsageError('aborted'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (value.length <= PASSWORD_MAX_LENGTH) value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function readPassword(io: UserCliIo): Promise<string> {
  let password: string;
  if (io.stdin.isTTY) {
    password = await readHidden(io, 'Password: ');
    const again = await readHidden(io, 'Repeat password: ');
    if (again !== password) throw new UsageError('the passwords do not match');
  } else {
    password = await readLine(io.stdin);
  }
  const problem = checkPasswordPolicy(password);
  if (problem) throw new UsageError(problem);
  return password;
}

function requireName(parsed: Parsed): string {
  if (parsed.name === undefined) throw new UsageError('missing user name');
  if (!isValidUserName(parsed.name)) {
    throw new UsageError(
      'user names are 1-64 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit',
    );
  }
  return parsed.name;
}

export async function runUserCli(args: string[], io: UserCliIo): Promise<number> {
  const out = (line: string): void => {
    io.stdout.write(`${line}\n`);
  };
  try {
    const parsed = parseArgs(args);
    const path = parsed.file ?? (io.env.USERS_FILE || undefined);
    if (!path) throw new UsageError('set USERS_FILE or pass --file <path>');
    const params = io.hashParams ?? DEFAULT_SCRYPT;
    switch (parsed.command) {
      case 'add': {
        const name = requireName(parsed);
        // Explicit: a forgotten option must never mean "may publish everything".
        if (parsed.packages === undefined) {
          throw new UsageError('add needs --packages ("*" for every owned package, "" for none)');
        }
        const packages = parsed.packages;
        const file = await UsersFile.open(path, { allowMissing: true });
        if (file.get(name)) throw new UsageError(`user ${name} already exists`);
        const password = await hashPassword(await readPassword(io), params);
        await file.update((data) => {
          if (Object.hasOwn(data.users, name)) throw new UsageError(`user ${name} already exists`);
          const now = new Date().toISOString();
          data.users[name] = {
            password,
            created: now,
            changed: now,
            generation: nextGeneration(),
            packages,
          };
          return data;
        });
        out(`added user ${name}`);
        return 0;
      }
      case 'passwd': {
        const name = requireName(parsed);
        const file = await UsersFile.open(path);
        if (!file.get(name)) throw new UsageError(`no user ${name}`);
        const password = await hashPassword(await readPassword(io), params);
        await file.update((data) => {
          const user = Object.hasOwn(data.users, name) ? data.users[name] : undefined;
          if (!user) throw new UsageError(`no user ${name}`);
          user.generation = nextGeneration(generationOf(user));
          user.password = password;
          user.changed = new Date().toISOString();
          return data;
        });
        out(`changed the password of ${name}; existing tokens of ${name} no longer work`);
        return 0;
      }
      case 'remove': {
        const name = requireName(parsed);
        const file = await UsersFile.open(path);
        await file.update((data) => {
          if (!Object.hasOwn(data.users, name)) throw new UsageError(`no user ${name}`);
          Reflect.deleteProperty(data.users, name);
          return data;
        });
        out(`removed user ${name}`);
        return 0;
      }
      case 'list': {
        const file = await UsersFile.open(path, { allowMissing: true });
        for (const [name, user] of file.entries().sort(([a], [b]) => a.localeCompare(b))) {
          const packages =
            user.packages === undefined ? 'all owned packages' : user.packages.join(',') || 'none';
          out(`${name}\tpublish: ${packages}\tpassword changed: ${user.changed}`);
        }
        return 0;
      }
      default:
        throw new UsageError('unknown command');
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`error: ${err.message}\n${USAGE}`);
      return 2;
    }
    io.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** Command-line argument parsing, kept separate so it can be unit tested. */

export interface ParsedArgs {
  command: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
      const key = rawKey ?? '';
      if (key.startsWith('no-')) {
        flags[key.slice(3)] = false;
        continue;
      }
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (arg.startsWith('-')) {
      flags[arg.slice(1)] = true;
      continue;
    }
    if (command === null) command = arg;
    else positional.push(arg);
  }

  return { command, positional, flags };
}

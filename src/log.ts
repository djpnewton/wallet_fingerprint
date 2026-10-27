/** Minimal structured logger: info to stdout, warnings/errors to stderr. */

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  verbose?: boolean;
  quiet?: boolean;
}

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const { verbose = false, quiet = false } = options;
  return {
    debug(message) {
      if (verbose) process.stderr.write(`${stamp()} debug ${message}\n`);
    },
    info(message) {
      if (!quiet) process.stdout.write(`${stamp()} ${message}\n`);
    },
    warn(message) {
      process.stderr.write(`${stamp()} warn  ${message}\n`);
    },
    error(message) {
      process.stderr.write(`${stamp()} error ${message}\n`);
    },
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

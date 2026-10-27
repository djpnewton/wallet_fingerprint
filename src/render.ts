/** Tiny table renderer for the CLI (no dependencies). */

export interface TableOptions {
  maxColumnWidth?: number;
  align?: Array<'left' | 'right'>;
}

function visibleWidth(s: string): number {
  return [...s].length;
}

function truncate(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  return `${[...s].slice(0, Math.max(1, width - 1)).join('')}…`;
}

export function table(headers: string[], rows: string[][], options: TableOptions = {}): string {
  const maxWidth = options.maxColumnWidth ?? 48;
  const safeHeaders = headers.map((h) => truncate(h, maxWidth));
  const safeRows = rows.map((row) => row.map((cell) => truncate(cell ?? '', maxWidth)));
  const widths = safeHeaders.map((h, i) =>
    Math.max(visibleWidth(h), ...safeRows.map((r) => visibleWidth(r[i] ?? ''))),
  );

  const pad = (cell: string, i: number): string => {
    const width = widths[i] ?? 0;
    const padding = ' '.repeat(Math.max(0, width - visibleWidth(cell)));
    return options.align?.[i] === 'right' ? padding + cell : cell + padding;
  };

  const lines = [
    safeHeaders.map(pad).join('  '),
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...safeRows.map((row) => row.map(pad).join('  ')),
  ];
  return lines.join('\n');
}

export function bar(value: number, max: number, width = 20): string {
  const filled = max <= 0 ? 0 : Math.round((value / max) * width);
  return '█'.repeat(Math.max(0, Math.min(width, filled))) + '·'.repeat(Math.max(0, width - filled));
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** Percentages below 1% keep a decimal, so rare signatures are not shown as 0%. */
export function pctFine(value: number): string {
  if (value > 0 && value < 0.01) return `${(value * 100).toFixed(2)}%`;
  if (value < 0.1) return `${(value * 100).toFixed(1)}%`;
  return `${(value * 100).toFixed(0)}%`;
}

export function shortTxid(txid: string): string {
  return `${txid.slice(0, 8)}…${txid.slice(-4)}`;
}

export function sats(n: number): string {
  return n.toLocaleString('en-US');
}

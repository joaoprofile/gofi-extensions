import { DiffHunk } from './types';

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateCost(tokens: number, costPerMillion: number): number {
  return (tokens / 1_000_000) * costPerMillion;
}

export function formatCost(usd: number): string {
  if (usd < 0.000001) { return '$0.00'; }
  if (usd < 0.0001) { return '$' + usd.toFixed(6); }
  if (usd < 0.01) { return '$' + usd.toFixed(4); }
  return '$' + usd.toFixed(2);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) { return (n / 1_000_000).toFixed(1) + 'M'; }
  if (n >= 1_000) { return (n / 1_000).toFixed(1) + 'k'; }
  return String(n);
}

export function rawDiffText(hunks: DiffHunk[]): string {
  return hunks.flatMap(h => [
    h.header,
    ...h.lines.map(l => {
      const prefix = l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' ';
      return prefix + l.content;
    }),
  ]).join('\n');
}

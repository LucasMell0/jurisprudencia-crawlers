/**
 * Bissecção de intervalo de datas (YYYY-MM-DD), usada por qualquer
 * crawler de tribunal pra quebrar uma partição que excedeu o teto de
 * paginação da fonte em duas metades sem sobreposição. Compartilhado
 * entre todas as fontes (ver src/sources/*).
 */

function toUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function midpointDate(from: string, to: string): string {
  const f = toUtcMs(from);
  const t = toUtcMs(to);
  return fromUtcMs(f + Math.floor((t - f) / 2));
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * ONE_DAY_MS);
}

/**
 * Divide [from, to] em duas metades contíguas sem sobreposição.
 * Retorna null se o intervalo já é de um único dia (não dá pra bissectar mais).
 */
export function splitRange(from: string, to: string): [[string, string], [string, string]] | null {
  if (from >= to) return null;

  const mid = midpointDate(from, to);
  const rightStart = addDays(mid, 1);
  if (rightStart > to) return null;

  return [
    [from, mid],
    [rightStart, to],
  ];
}

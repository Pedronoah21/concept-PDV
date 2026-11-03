/**
 * Todo valor monetário do Concept PDV é um inteiro em centavos.
 * Nunca usar float para dinheiro: 0.1 + 0.2 !== 0.3.
 */
export type Cents = number;

export function toCents(value: number | string): Cents {
  if (typeof value === 'number') return Math.round(value * 100);
  const clean = value.trim().replace(/[R$\s]/g, '');
  if (!clean) return 0;
  // Aceita "1.234,56", "1234,56" e "1234.56"
  const normalized = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean;
  const n = Number(normalized);
  if (!Number.isFinite(n)) throw new Error(`Valor inválido: ${value}`);
  return Math.round(n * 100);
}

export function fromCents(cents: Cents): number {
  return cents / 100;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(cents: Cents): string {
  return brl.format(cents / 100);
}

/** Divide um valor em partes proporcionais aos pesos, sem perder centavos (método do maior resto). */
export function allocate(total: Cents, weights: number[]): Cents[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floored = raw.map((r) => Math.floor(r));
  let rest = total - floored.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) floored[order[k].i] += 1;
  return floored;
}

/** Divide um valor em N parcelas iguais; a diferença de centavos vai para a primeira. */
export function splitInstallments(total: Cents, count: number): Cents[] {
  const base = Math.floor(total / count);
  const parts = Array.from({ length: count }, () => base);
  parts[0] += total - base * count;
  return parts;
}

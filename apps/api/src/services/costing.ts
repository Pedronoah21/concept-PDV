import { allocate } from '@concept/shared';

/**
 * Custo de entrada: frete e despesas somam, desconto subtrai, e tudo é rateado
 * proporcionalmente ao valor de cada item (como o LojaUp faz).
 */
export function landedCosts(items: { quantity: number; unitCostCents: number }[], freight: number, other: number, discount: number) {
  const values = items.map((i) => i.quantity * i.unitCostCents);
  const extra = allocate(freight + other, values);
  const disc = allocate(discount, values);
  return items.map((i, k) => Math.round((values[k] + extra[k] - disc[k]) / i.quantity));
}

/** Custo médio ponderado. Se o saldo anterior for zero ou negativo, vale o custo da entrada. */
export function weightedAverage(currentQty: number, currentAvg: number, inQty: number, inCost: number) {
  if (currentQty <= 0) return inCost;
  return Math.round((currentQty * currentAvg + inQty * inCost) / (currentQty + inQty));
}

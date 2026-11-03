import type { MovementType } from '@prisma/client';
import type { Tx } from '../db';
import { badRequest } from '../lib/errors';

export interface MovementInput {
  companyId: string;
  storeId: string;
  variantId: string;
  type: MovementType;
  /** positivo entra, negativo sai */
  quantity: number;
  unitCostCents?: number;
  refType?: string;
  refId?: string;
  reason?: string;
  userId?: string;
  /** Permite saldo negativo (vendas offline já realizadas, por exemplo) */
  allowNegative?: boolean;
}

/**
 * Única porta de entrada para alterar estoque: grava o movimento e atualiza o saldo
 * na mesma transação, com bloqueio de linha para evitar corrida entre caixas.
 */
export async function moveStock(tx: Tx, m: MovementInput) {
  if (m.quantity === 0) return null;
  await tx.stockBalance.upsert({
    where: { variantId_storeId: { variantId: m.variantId, storeId: m.storeId } },
    create: { variantId: m.variantId, storeId: m.storeId, quantity: 0 },
    update: {},
  });
  // Bloqueia a linha do saldo até o fim da transação.
  const [row] = await tx.$queryRaw<{ quantity: number }[]>`
    SELECT quantity FROM "StockBalance" WHERE "variantId" = ${m.variantId} AND "storeId" = ${m.storeId} FOR UPDATE`;
  const after = row.quantity + m.quantity;
  if (after < 0 && !m.allowNegative) {
    throw badRequest('Estoque insuficiente para esta operação', 'ESTOQUE_INSUFICIENTE');
  }
  await tx.stockBalance.update({
    where: { variantId_storeId: { variantId: m.variantId, storeId: m.storeId } },
    data: { quantity: after },
  });
  return tx.stockMovement.create({
    data: {
      companyId: m.companyId,
      storeId: m.storeId,
      variantId: m.variantId,
      type: m.type,
      quantity: m.quantity,
      balanceAfter: after,
      unitCostCents: m.unitCostCents,
      refType: m.refType,
      refId: m.refId,
      reason: m.reason,
      userId: m.userId,
    },
  });
}

/** Ajusta a reserva de estoque (pedidos online). */
export async function reserveStock(tx: Tx, storeId: string, variantId: string, delta: number) {
  await tx.stockBalance.upsert({
    where: { variantId_storeId: { variantId, storeId } },
    create: { variantId, storeId, quantity: 0, reserved: 0 },
    update: {},
  });
  const [row] = await tx.$queryRaw<{ quantity: number; reserved: number }[]>`
    SELECT quantity, reserved FROM "StockBalance" WHERE "variantId" = ${variantId} AND "storeId" = ${storeId} FOR UPDATE`;
  const reserved = row.reserved + delta;
  if (delta > 0 && row.quantity - reserved < 0) {
    throw badRequest('Produto sem estoque disponível', 'ESTOQUE_INSUFICIENTE');
  }
  await tx.stockBalance.update({
    where: { variantId_storeId: { variantId, storeId } },
    data: { reserved: Math.max(0, reserved) },
  });
}

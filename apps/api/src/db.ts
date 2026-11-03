import { PrismaClient, Prisma } from '@prisma/client';

export const prisma = new PrismaClient();
export type Tx = Prisma.TransactionClient;
export { Prisma };

/** Próximo número sequencial por empresa (vendas, pedidos, código EAN interno). */
export async function nextNumber(tx: Tx, companyId: string, key: string): Promise<number> {
  const row = await tx.counter.upsert({
    where: { companyId_key: { companyId, key } },
    create: { companyId, key, value: 1 },
    update: { value: { increment: 1 } },
  });
  return row.value;
}

export async function audit(
  tx: Tx,
  companyId: string,
  userId: string | null,
  action: string,
  entity: string,
  entityId?: string,
  data?: unknown,
) {
  await tx.auditLog.create({
    data: { companyId, userId, action, entity, entityId, data: data as Prisma.InputJsonValue },
  });
}

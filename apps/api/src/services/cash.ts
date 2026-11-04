import { PAYMENT_METHODS } from '@concept/shared';
import { z } from 'zod';
import { audit, prisma } from '../db';
import { badRequest, conflict, notFound } from '../lib/errors';
import { assertCan, can, type AuthUser } from '../lib/auth';

export const openInput = z.object({ registerId: z.string(), openingCents: z.number().int().nonnegative() });
export const movementInput = z.object({
  type: z.enum(['SANGRIA', 'SUPRIMENTO']),
  amountCents: z.number().int().positive(),
  reason: z.string().nullish(),
});
export const closeInput = z.object({
  /** Valores contados pelo operador, por forma de pagamento (em centavos). */
  counted: z.record(z.enum(PAYMENT_METHODS), z.number().int().nonnegative()),
  notes: z.string().nullish(),
});

async function findSession(user: AuthUser, id: string) {
  const s = await prisma.cashSession.findFirst({
    where: { id, register: { store: { companyId: user.companyId } } },
    include: { register: { include: { store: true } } },
  });
  if (!s) throw notFound('Sessão de caixa');
  return s;
}

export async function openSession(user: AuthUser, input: z.infer<typeof openInput>) {
  assertCan(user, 'caixa:operar');
  const register = await prisma.register.findFirst({ where: { id: input.registerId, store: { companyId: user.companyId } } });
  if (!register) throw notFound('Caixa');
  const open = await prisma.cashSession.findFirst({ where: { registerId: register.id, status: 'ABERTO' } });
  if (open) throw conflict('Este caixa já está aberto', 'CAIXA_JA_ABERTO');
  return prisma.cashSession.create({ data: { registerId: register.id, userId: user.id, openingCents: input.openingCents } });
}

export async function addMovement(user: AuthUser, sessionId: string, input: z.infer<typeof movementInput>) {
  assertCan(user, 'caixa:operar');
  const s = await findSession(user, sessionId);
  if (s.status !== 'ABERTO') throw badRequest('Caixa fechado', 'CAIXA_FECHADO');
  if (input.type === 'SANGRIA') {
    const summary = await computeSummary(user, sessionId);
    if (input.amountCents > summary.expected.DINHEIRO) throw badRequest('Sangria maior que o dinheiro em caixa');
  }
  return prisma.cashMovement.create({
    data: { sessionId, type: input.type, amountCents: input.amountCents, reason: input.reason, userId: user.id },
  });
}

/** Valor esperado no caixa por forma de pagamento. */
async function computeSummary(user: AuthUser, sessionId: string) {
  const s = await findSession(user, sessionId);
  const [payments, sales, movements, change] = await Promise.all([
    prisma.salePayment.groupBy({
      by: ['method'],
      where: { sale: { cashSessionId: sessionId, status: 'CONCLUIDA' } },
      _sum: { amountCents: true },
    }),
    prisma.sale.aggregate({
      where: { cashSessionId: sessionId, status: 'CONCLUIDA' },
      _count: true,
      _sum: { totalCents: true },
    }),
    prisma.cashMovement.groupBy({ by: ['type', 'method'], where: { sessionId }, _sum: { amountCents: true } }),
    prisma.sale.aggregate({ where: { cashSessionId: sessionId, status: 'CONCLUIDA' }, _sum: { changeCents: true } }),
  ]);
  const expected = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<(typeof PAYMENT_METHODS)[number], number>;
  for (const p of payments) expected[p.method as keyof typeof expected] += p._sum.amountCents ?? 0;
  expected.DINHEIRO += s.openingCents - (change._sum.changeCents ?? 0);
  const mv = (type: string, method = 'DINHEIRO') =>
    movements.filter((m) => m.type === type && m.method === method).reduce((a, m) => a + (m._sum.amountCents ?? 0), 0);
  expected.DINHEIRO += mv('SUPRIMENTO') - mv('SANGRIA') - mv('DEVOLUCAO');
  for (const method of PAYMENT_METHODS) expected[method] += mv('RECEBIMENTO_CREDIARIO', method);
  // Dados extras para o relatório impresso de fechamento.
  const [canceledCount, movementsList, people] = await Promise.all([
    prisma.sale.count({ where: { cashSessionId: sessionId, status: 'CANCELADA' } }),
    prisma.cashMovement.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: { type: true, method: true, amountCents: true, reason: true, createdAt: true },
    }),
    prisma.user.findMany({ where: { id: { in: [s.userId, s.closedById].filter(Boolean) as string[] } }, select: { id: true, name: true } }),
  ]);
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  const company = await prisma.company.findUnique({ where: { id: user.companyId }, select: { tradeName: true } });
  // Crediário e vale-troca não entram em dinheiro físico; ficam fora da conferência.
  return {
    report: {
      company: company?.tradeName ?? '',
      store: s.register.store.name,
      openedBy: nameOf(s.userId),
      closedBy: nameOf(s.closedById),
      canceledCount,
      salesByMethod: Object.fromEntries(payments.map((p) => [p.method, p._sum.amountCents ?? 0])),
      changeCents: change._sum.changeCents ?? 0,
      movements: movementsList
        .filter((m) => m.type !== 'RECEBIMENTO_CREDIARIO' || m.method === 'DINHEIRO')
        .map((m) => ({ type: m.type, method: m.method, amountCents: m.amountCents, reason: m.reason, at: m.createdAt })),
      notes: s.notes,
    },
    session: { id: s.id, status: s.status, openedAt: s.openedAt, closedAt: s.closedAt, openingCents: s.openingCents, register: s.register.name },
    salesCount: sales._count,
    salesTotalCents: sales._sum.totalCents ?? 0,
    movements: { suprimento: mv('SUPRIMENTO'), sangria: mv('SANGRIA'), devolucao: mv('DEVOLUCAO') },
    expected,
    counted: s.countedJson,
    differenceCents: s.differenceCents,
  };
}

export async function sessionSummary(user: AuthUser, sessionId: string, internal = false) {
  const result = await computeSummary(user, sessionId);
  const s = result.session;
  // Fechamento cego: o operador não vê o valor esperado antes de contar.
  if (!internal && s.status === 'ABERTO' && !can(user, 'caixa:ver-esperado')) {
    return { ...result, expected: null };
  }
  return result;
}

const COUNTED_METHODS = ['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO', 'OUTRO'] as const;

export async function closeSession(user: AuthUser, sessionId: string, input: z.infer<typeof closeInput>) {
  assertCan(user, 'caixa:operar');
  const summary = await computeSummary(user, sessionId);
  if (summary.session.status !== 'ABERTO') throw badRequest('Caixa já fechado');
  let difference = 0;
  for (const m of COUNTED_METHODS) difference += (input.counted[m] ?? 0) - summary.expected[m];
  await prisma.$transaction(async (tx) => {
    await tx.cashSession.update({
      where: { id: sessionId },
      data: {
        status: 'FECHADO',
        closedAt: new Date(),
        closedById: user.id,
        countedJson: input.counted,
        expectedJson: summary.expected,
        differenceCents: difference,
        notes: input.notes,
      },
    });
    await audit(tx, user.companyId, user.id, 'caixa.fechar', 'CashSession', sessionId, { difference });
  });
  // Relê depois de fechar: o relatório já sai com quem fechou, horário e observações.
  return computeSummary(user, sessionId);
}

export const installmentPayInput = z.object({
  amountCents: z.number().int().positive(),
  method: z.enum(['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO']),
  cashSessionId: z.string(),
});

/** Recebimento de parcela de crediário (aceita pagamento parcial). */
export async function payInstallment(user: AuthUser, installmentId: string, input: z.infer<typeof installmentPayInput>) {
  assertCan(user, 'crediario:receber');
  return prisma.$transaction(async (tx) => {
    const inst = await tx.installment.findFirst({ where: { id: installmentId, customer: { companyId: user.companyId } } });
    if (!inst) throw notFound('Parcela');
    if (inst.status !== 'ABERTA') throw badRequest('Parcela não está em aberto');
    const remaining = inst.amountCents - inst.paidCents;
    if (input.amountCents > remaining) throw badRequest('Valor maior que o saldo da parcela');
    const session = await tx.cashSession.findFirst({ where: { id: input.cashSessionId, status: 'ABERTO', register: { store: { companyId: user.companyId } } } });
    if (!session) throw badRequest('Caixa não está aberto', 'CAIXA_FECHADO');
    const paid = inst.paidCents + input.amountCents;
    const updated = await tx.installment.update({
      where: { id: inst.id },
      data: { paidCents: paid, status: paid >= inst.amountCents ? 'PAGA' : 'ABERTA', paidAt: paid >= inst.amountCents ? new Date() : null },
    });
    await tx.cashMovement.create({
      data: {
        sessionId: session.id,
        type: 'RECEBIMENTO_CREDIARIO',
        method: input.method,
        amountCents: input.amountCents,
        reason: `Parcela ${inst.number}/${inst.of}`,
        userId: user.id,
      },
    });
    return updated;
  });
}

import { randomBytes } from 'node:crypto';
import {
  checkPayments,
  computeCart,
  discountPercent,
  onlyDigits,
  splitInstallments,
  type SaleInput,
} from '@concept/shared';
import { z } from 'zod';
import { audit, nextNumber, prisma, type Tx } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { assertCan, type AuthUser, verifyApproval } from '../lib/auth';
import { moveStock } from './stock';
import { enqueueFiscal } from '../fiscal/queue';

export const effectivePrice = (v: { priceCents: number; promoPriceCents: number | null }) =>
  v.promoPriceCents != null && v.promoPriceCents < v.priceCents ? v.promoPriceCents : v.priceCents;

function addMonths(date: Date, months: number) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

const saleInclude = {
  items: true,
  payments: true,
  fiscalDocuments: { orderBy: { createdAt: 'desc' as const } },
  customer: { select: { id: true, name: true, document: true } },
  installments: true,
  returns: { include: { items: true } },
};

export type SaleResult = Awaited<ReturnType<typeof getSale>>;

export function getSale(companyId: string, id: string) {
  return prisma.sale.findFirst({ where: { id, companyId }, include: saleInclude });
}

/**
 * Registra uma venda do PDV. Idempotente pelo `id` gerado no caixa: se a mesma venda
 * chegar duas vezes (reenvio após queda de internet), a segunda devolve a primeira.
 */
export async function createSale(user: AuthUser, input: SaleInput) {
  assertCan(user, 'venda:criar');
  const existing = await prisma.sale.findUnique({ where: { id: input.id }, include: saleInclude });
  if (existing) {
    if (existing.companyId !== user.companyId) throw conflict('Identificador de venda já utilizado');
    return { sale: existing, duplicate: true };
  }

  try {
    const saleId = await prisma.$transaction(
      async (tx) => {
        const company = await tx.company.findUniqueOrThrow({ where: { id: user.companyId } });
        const register = await tx.register.findFirst({
          where: { id: input.registerId, store: { companyId: user.companyId } },
        });
        if (!register) throw notFound('Caixa');
        const session = await tx.cashSession.findFirst({ where: { id: input.cashSessionId, registerId: register.id } });
        if (!session) throw notFound('Sessão de caixa');
        // Venda feita offline pode chegar depois do fechamento — o caixa já recebeu o dinheiro.
        if (session.status !== 'ABERTO' && !input.offline) throw badRequest('O caixa está fechado', 'CAIXA_FECHADO');

        const variants = await tx.variant.findMany({
          where: { id: { in: input.items.map((i) => i.variantId) }, product: { companyId: user.companyId } },
          include: { product: true },
        });
        const byId = new Map(variants.map((v) => [v.id, v]));
        for (const it of input.items) if (!byId.has(it.variantId)) throw badRequest('Produto não encontrado na venda');

        let totals: ReturnType<typeof computeCart>;
        let changeCents: number;
        try {
          totals = computeCart(input.items, input.discountCents);
          changeCents = checkPayments(totals.totalCents, input.payments).changeCents;
        } catch (e) {
          throw badRequest((e as Error).message, 'PAGAMENTO_INVALIDO');
        }

        // Desconto efetivo = descontos lançados + redução de preço feita no caixa.
        const catalogGross = input.items.reduce((a, it) => a + it.quantity * effectivePrice(byId.get(it.variantId)!), 0);
        const effectiveDiscount = Math.max(0, catalogGross - totals.totalCents);
        const pct = discountPercent(catalogGross, effectiveDiscount);
        let needsReview = false;
        let approvedById: string | null = null;
        if (pct > user.maxDiscountPct + 0.001) {
          const approval = verifyApproval(input.approvalToken, user.companyId, 'desconto');
          if (approval && approval.maxPct >= pct) approvedById = approval.uid;
          else if (input.offline) needsReview = true; // venda já aconteceu; vai para revisão do gerente
          else throw forbidden(`Desconto de ${pct.toFixed(1)}% exige autorização do gerente`, 'AUTORIZACAO_NECESSARIA');
        }

        // Crediário exige cliente e respeita o limite de crédito.
        const crediario = input.payments.filter((p) => p.method === 'CREDIARIO');
        let customerId = input.customerId ?? null;
        if (customerId) {
          const c = await tx.customer.findFirst({ where: { id: customerId, companyId: user.companyId } });
          if (!c) throw notFound('Cliente');
          if (crediario.length) {
            const open = await tx.installment.aggregate({
              where: { customerId, status: 'ABERTA' },
              _sum: { amountCents: true, paidCents: true },
            });
            const used = (open._sum.amountCents ?? 0) - (open._sum.paidCents ?? 0);
            const wanted = crediario.reduce((a, p) => a + p.amountCents, 0);
            if (used + wanted > c.creditLimitCents) {
              if (input.offline) needsReview = true;
              else throw badRequest('Limite de crediário do cliente excedido', 'LIMITE_EXCEDIDO');
            }
          }
        } else if (crediario.length) {
          throw badRequest('Selecione o cliente para vender no crediário', 'CLIENTE_OBRIGATORIO');
        }

        // Vale-troca: debita o saldo do vale.
        for (const p of input.payments.filter((p) => p.method === 'VALE_TROCA')) {
          if (!p.voucherCode) throw badRequest('Informe o código do vale-troca');
          const v = await tx.voucher.findUnique({ where: { companyId_code: { companyId: user.companyId, code: p.voucherCode } } });
          if (!v || v.balanceCents < p.amountCents) throw badRequest(`Vale-troca ${p.voucherCode} sem saldo suficiente`, 'VALE_SEM_SALDO');
          await tx.voucher.update({ where: { id: v.id }, data: { balanceCents: { decrement: p.amountCents } } });
        }

        const number = await nextNumber(tx, user.companyId, 'sale');
        const costCents = input.items.reduce((a, it) => a + it.quantity * byId.get(it.variantId)!.avgCostCents, 0);
        const createdAt = new Date(input.createdAt);

        await tx.sale.create({
          data: {
            id: input.id,
            companyId: user.companyId,
            storeId: register.storeId,
            registerId: register.id,
            cashSessionId: session.id,
            number,
            customerId,
            userId: user.id,
            cpfNaNota: input.cpfNaNota ? onlyDigits(input.cpfNaNota) : null,
            grossCents: totals.grossCents,
            discountCents: totals.itemDiscountCents + totals.saleDiscountCents,
            totalCents: totals.totalCents,
            costCents,
            changeCents,
            offline: input.offline,
            needsReview,
            approvedById,
            notes: input.notes,
            createdAt,
            items: {
              create: input.items.map((it, k) => {
                const v = byId.get(it.variantId)!;
                const desc = [v.product.name, v.color, v.size].filter(Boolean).join(' ');
                return {
                  variantId: v.id,
                  description: desc,
                  quantity: it.quantity,
                  unitPriceCents: it.unitPriceCents,
                  discountCents: totals.lineDiscounts[k],
                  totalCents: it.quantity * it.unitPriceCents - totals.lineDiscounts[k],
                  unitCostCents: v.avgCostCents,
                };
              }),
            },
            payments: {
              create: input.payments.map((p) => ({
                method: p.method,
                amountCents: p.amountCents,
                installments: p.installments,
                voucherCode: p.voucherCode,
              })),
            },
          },
        });

        for (const p of crediario) {
          const parts = splitInstallments(p.amountCents, p.installments);
          const first = p.firstDueDate ? new Date(`${p.firstDueDate}T12:00:00`) : addMonths(createdAt, 1);
          await tx.installment.createMany({
            data: parts.map((amountCents, i) => ({
              saleId: input.id,
              customerId: customerId!,
              number: i + 1,
              of: parts.length,
              amountCents,
              dueDate: addMonths(first, i),
            })),
          });
        }

        for (const it of input.items) {
          await moveStock(tx, {
            companyId: user.companyId,
            storeId: register.storeId,
            variantId: it.variantId,
            type: 'VENDA',
            quantity: -it.quantity,
            unitCostCents: byId.get(it.variantId)!.avgCostCents,
            refType: 'sale',
            refId: input.id,
            userId: user.id,
            allowNegative: company.allowNegativeStock || input.offline,
          });
        }

        if (input.issueFiscal) await enqueueFiscal(tx, company, input.id, number, 'NFCE');
        if (needsReview) await audit(tx, user.companyId, user.id, 'venda.revisao', 'Sale', input.id, { pct });
        return input.id;
      },
      { timeout: 20_000 },
    );
    return { sale: (await getSale(user.companyId, saleId))!, duplicate: false };
  } catch (err: any) {
    // Corrida: o mesmo envio chegou duas vezes ao mesmo tempo.
    if (err?.code === 'P2002' && String(err?.meta?.target ?? '').includes('id')) {
      const sale = await getSale(user.companyId, input.id);
      if (sale) return { sale, duplicate: true };
    }
    throw err;
  }
}

export const cancelInput = z.object({ reason: z.string().min(15, 'Justificativa precisa ter ao menos 15 caracteres') });

export async function cancelSale(user: AuthUser, saleId: string, reason: string) {
  assertCan(user, 'venda:cancelar');
  return prisma.$transaction(async (tx) => {
    const sale = await tx.sale.findFirst({ where: { id: saleId, companyId: user.companyId }, include: { items: true, payments: true, returns: true } });
    if (!sale) throw notFound('Venda');
    if (sale.status === 'CANCELADA') throw badRequest('Venda já cancelada');
    if (sale.returns.length) throw badRequest('Venda com devolução não pode ser cancelada; faça a devolução dos itens restantes');
    const paidInstallment = await tx.installment.findFirst({ where: { saleId, paidCents: { gt: 0 } } });
    if (paidInstallment) throw badRequest('Venda com parcela de crediário já paga não pode ser cancelada');

    await tx.sale.update({
      where: { id: saleId },
      data: { status: 'CANCELADA', cancelReason: reason, canceledAt: new Date(), canceledById: user.id },
    });
    await tx.installment.updateMany({ where: { saleId }, data: { status: 'CANCELADA' } });
    for (const p of sale.payments.filter((p) => p.method === 'VALE_TROCA' && p.voucherCode)) {
      await tx.voucher.update({
        where: { companyId_code: { companyId: user.companyId, code: p.voucherCode! } },
        data: { balanceCents: { increment: p.amountCents } },
      });
    }
    for (const it of sale.items) {
      await moveStock(tx, {
        companyId: user.companyId,
        storeId: sale.storeId,
        variantId: it.variantId,
        type: 'CANCELAMENTO',
        quantity: it.quantity,
        refType: 'sale',
        refId: sale.id,
        reason,
        userId: user.id,
        allowNegative: true,
      });
    }
    await audit(tx, user.companyId, user.id, 'venda.cancelar', 'Sale', sale.id, { reason });
    return sale.id;
  });
}

export const returnInput = z.object({
  items: z.array(z.object({ saleItemId: z.string(), quantity: z.number().int().positive(), backToStock: z.boolean().default(true) })).min(1),
  refundMethod: z.enum(['DINHEIRO', 'VALE_TROCA']),
  cashSessionId: z.string().nullish(),
  reason: z.string().nullish(),
});

/** Devolução/troca parcial. Reembolso em dinheiro (sai do caixa) ou vale-troca. */
export async function returnItems(user: AuthUser, saleId: string, input: z.infer<typeof returnInput>) {
  assertCan(user, 'venda:devolver');
  return prisma.$transaction(async (tx: Tx) => {
    const sale = await tx.sale.findFirst({
      where: { id: saleId, companyId: user.companyId },
      include: { items: true, returns: { include: { items: true } } },
    });
    if (!sale) throw notFound('Venda');
    if (sale.status === 'CANCELADA') throw badRequest('Venda cancelada não aceita devolução');

    const refunded = new Map<string, number>();
    for (const r of sale.returns) for (const ri of r.items) refunded.set(ri.saleItemId, (refunded.get(ri.saleItemId) ?? 0) + ri.totalCents);

    let total = 0;
    const lines: { saleItemId: string; quantity: number; totalCents: number; backToStock: boolean; variantId: string }[] = [];
    for (const r of input.items) {
      const item = sale.items.find((i) => i.id === r.saleItemId);
      if (!item) throw badRequest('Item não pertence à venda');
      if (item.returnedQty + r.quantity > item.quantity) throw badRequest(`Quantidade a devolver maior que a vendida: ${item.description}`);
      // Última unidade devolvida leva o centavo restante, para fechar exatamente o valor pago.
      const lineTotal =
        item.returnedQty + r.quantity === item.quantity
          ? item.totalCents - (refunded.get(item.id) ?? 0)
          : Math.round((item.totalCents * r.quantity) / item.quantity);
      total += lineTotal;
      lines.push({ saleItemId: item.id, quantity: r.quantity, totalCents: lineTotal, backToStock: r.backToStock, variantId: item.variantId });
    }

    let voucherCode: string | null = null;
    if (input.refundMethod === 'VALE_TROCA') {
      voucherCode = 'VT' + randomBytes(4).toString('hex').toUpperCase();
    } else {
      if (!input.cashSessionId) throw badRequest('Informe o caixa aberto para devolver em dinheiro');
      const s = await tx.cashSession.findFirst({ where: { id: input.cashSessionId, status: 'ABERTO', register: { store: { companyId: user.companyId } } } });
      if (!s) throw badRequest('Caixa não está aberto', 'CAIXA_FECHADO');
    }

    const ret = await tx.return.create({
      data: {
        saleId,
        totalCents: total,
        refundMethod: input.refundMethod,
        voucherCode,
        reason: input.reason,
        userId: user.id,
        items: { create: lines.map(({ variantId, ...l }) => l) },
      },
    });
    if (voucherCode) {
      await tx.voucher.create({
        data: { companyId: user.companyId, code: voucherCode, customerId: sale.customerId, amountCents: total, balanceCents: total, returnId: ret.id },
      });
    } else {
      await tx.cashMovement.create({
        data: { sessionId: input.cashSessionId!, type: 'DEVOLUCAO', amountCents: total, reason: `Devolução venda ${sale.number}`, userId: user.id },
      });
    }
    for (const l of lines) {
      await tx.saleItem.update({ where: { id: l.saleItemId }, data: { returnedQty: { increment: l.quantity } } });
      if (l.backToStock) {
        await moveStock(tx, {
          companyId: user.companyId,
          storeId: sale.storeId,
          variantId: l.variantId,
          type: 'DEVOLUCAO',
          quantity: l.quantity,
          refType: 'return',
          refId: ret.id,
          userId: user.id,
          allowNegative: true,
        });
      }
    }
    await audit(tx, user.companyId, user.id, 'venda.devolver', 'Return', ret.id, { saleId, total });
    return { returnId: ret.id, totalCents: total, voucherCode };
  });
}

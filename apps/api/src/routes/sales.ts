import type { FastifyInstance } from 'fastify';
import { saleInput, type SaleInput } from '@concept/shared';
import { z } from 'zod';
import { prisma } from '../db';
import { assertCan, can, guard, requireAuth } from '../lib/auth';
import { AppError, notFound } from '../lib/errors';
import { dateRange, parse } from '../lib/http';
import { cancelInput, cancelSale, createSale, getSale, returnInput, returnItems } from '../services/sales';
import { addMovement, closeInput, closeSession, installmentPayInput, movementInput, openInput, openSession, payInstallment, sessionSummary } from '../services/cash';
import { cancelFiscal, processDocument } from '../fiscal/queue';
import { effectivePrice } from '../services/sales';

/** Emite a nota logo após a venda, sem segurar o caixa mais que alguns segundos. */
async function tryIssueNow(saleId: string, ms = 8000) {
  const doc = await prisma.fiscalDocument.findFirst({ where: { saleId, status: 'PENDENTE' }, orderBy: { createdAt: 'desc' } });
  if (!doc) return;
  await Promise.race([processDocument(doc.id).catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
}

export default async function salesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ---------------- Dados para o caixa trabalhar offline ----------------
  app.get('/sync/catalog', async (req) => {
    const { storeId } = req.query as { storeId?: string };
    const [products, customers, company] = await Promise.all([
      prisma.product.findMany({
        where: { companyId: req.user.companyId, active: true },
        include: { variants: { where: { active: true }, include: { balances: storeId ? { where: { storeId } } : true } } },
      }),
      prisma.customer.findMany({
        where: { companyId: req.user.companyId, active: true },
        select: { id: true, name: true, document: true, phone: true, creditLimitCents: true },
        orderBy: { name: 'asc' },
        take: 5000,
      }),
      prisma.company.findUniqueOrThrow({ where: { id: req.user.companyId } }),
    ]);
    const variants = products.flatMap((p) =>
      p.variants.map((v) => ({
        id: v.id,
        productId: p.id,
        name: p.name,
        brand: p.brand,
        color: v.color,
        size: v.size,
        sku: v.sku,
        barcode: v.barcode,
        unit: p.unit,
        priceCents: effectivePrice(v),
        listPriceCents: v.priceCents,
        stock: v.balances.reduce((a, b) => a + b.quantity, 0),
      })),
    );
    return {
      generatedAt: new Date().toISOString(),
      variants,
      customers,
      receipt: {
        name: company.tradeName,
        cnpj: company.cnpj,
        ie: company.ie,
        phone: company.phone,
        address: [company.street, company.number, company.district, company.city && `${company.city}/${company.uf}`].filter(Boolean).join(', '),
        footer: company.receiptFooter,
      },
    };
  });

  /** Recebe vendas feitas no caixa (online ou da fila offline). Cada uma é processada isoladamente. */
  app.post('/sync/sales', async (req) => {
    const body = z.object({ sales: z.array(z.unknown()).max(200) }).parse(req.body);
    const results = [];
    for (const raw of body.sales) {
      const id = (raw as { id?: string })?.id ?? null;
      try {
        const input = parse(saleInput, raw) as SaleInput;
        const { sale, duplicate } = await createSale(req.user, input);
        results.push({ id, ok: true, duplicate, number: sale.number });
      } catch (err) {
        const e = err as AppError;
        // Erros de validação (4xx) não se resolvem sozinhos: o caixa mostra para o operador.
        results.push({ id, ok: false, permanent: (e.status ?? 500) < 500, code: e.code ?? 'ERRO', error: e.message });
      }
    }
    return { results };
  });

  // ---------------- Vendas ----------------
  app.post('/sales', async (req, reply) => {
    const input = parse(saleInput, req.body) as SaleInput;
    const { sale, duplicate } = await createSale(req.user, input);
    if (!duplicate && input.issueFiscal) await tryIssueNow(sale.id);
    reply.code(duplicate ? 200 : 201);
    return getSale(req.user.companyId, sale.id);
  });

  app.get('/sales', async (req) => {
    const q = req.query as { from?: string; to?: string; status?: string; q?: string; review?: string; channel?: string };
    const { from, to } = dateRange(q);
    const mineOnly = !can(req.user, 'relatorio:ver');
    const n = Number(q.q);
    return prisma.sale.findMany({
      where: {
        companyId: req.user.companyId,
        createdAt: { gte: from, lte: to },
        ...(mineOnly ? { userId: req.user.id } : {}),
        ...(q.status ? { status: q.status as 'CONCLUIDA' | 'CANCELADA' } : {}),
        ...(q.channel ? { channel: q.channel as 'PDV' | 'ONLINE' } : {}),
        ...(q.review ? { needsReview: true } : {}),
        ...(q.q ? { OR: [...(Number.isInteger(n) ? [{ number: n }] : []), { customer: { name: { contains: q.q, mode: 'insensitive' as const } } }] } : {}),
      },
      include: {
        payments: true,
        customer: { select: { name: true } },
        fiscalDocuments: { select: { id: true, status: true, model: true, number: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  });

  app.get('/sales/:id', async (req) => {
    const sale = await getSale(req.user.companyId, (req.params as { id: string }).id);
    if (!sale) throw notFound('Venda');
    return sale;
  });

  app.post('/sales/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = parse(cancelInput, req.body);
    await cancelSale(req.user, id, reason);
    const authorized = await prisma.fiscalDocument.findMany({ where: { saleId: id, status: 'AUTORIZADA' } });
    for (const d of authorized) await cancelFiscal(req.user.companyId, d.id, reason);
    await prisma.fiscalDocument.updateMany({ where: { saleId: id, status: { in: ['PENDENTE', 'ERRO', 'REJEITADA'] } }, data: { status: 'CANCELADA', message: 'Venda cancelada antes da emissão' } });
    return getSale(req.user.companyId, id);
  });

  app.post('/sales/:id/returns', async (req) => {
    const { id } = req.params as { id: string };
    return returnItems(req.user, id, parse(returnInput, req.body));
  });

  app.post('/sales/:id/review', { preHandler: guard('venda:cancelar') }, async (req) => {
    const { id } = req.params as { id: string };
    const sale = await prisma.sale.findFirst({ where: { id, companyId: req.user.companyId } });
    if (!sale) throw notFound('Venda');
    return prisma.sale.update({ where: { id }, data: { needsReview: false, approvedById: req.user.id } });
  });

  // ---------------- Caixa ----------------
  app.get('/cash/current', async (req) => {
    const { registerId } = req.query as { registerId: string };
    const s = await prisma.cashSession.findFirst({ where: { registerId, status: 'ABERTO', register: { store: { companyId: req.user.companyId } } } });
    return s ?? null;
  });
  app.get('/cash/sessions', async (req) => {
    assertCan(req.user, 'caixa:ver-esperado');
    return prisma.cashSession.findMany({
      where: { register: { store: { companyId: req.user.companyId } } },
      include: { register: { select: { name: true } } },
      orderBy: { openedAt: 'desc' },
      take: 100,
    });
  });
  app.post('/cash/open', async (req) => openSession(req.user, parse(openInput, req.body)));
  app.get('/cash/:id', async (req) => sessionSummary(req.user, (req.params as { id: string }).id));
  app.post('/cash/:id/movements', async (req) => addMovement(req.user, (req.params as { id: string }).id, parse(movementInput, req.body)));
  app.post('/cash/:id/close', async (req) => closeSession(req.user, (req.params as { id: string }).id, parse(closeInput, req.body)));

  // ---------------- Crediário ----------------
  app.get('/installments', async (req) => {
    const q = req.query as { customerId?: string; overdue?: string };
    return prisma.installment.findMany({
      where: {
        customer: { companyId: req.user.companyId },
        status: 'ABERTA',
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(q.overdue ? { dueDate: { lt: new Date() } } : {}),
      },
      include: { customer: { select: { name: true, phone: true } }, sale: { select: { number: true } } },
      orderBy: { dueDate: 'asc' },
      take: 500,
    });
  });
  app.post('/installments/:id/pay', async (req) => payInstallment(req.user, (req.params as { id: string }).id, parse(installmentPayInput, req.body)));

  // ---------------- Vale-troca ----------------
  app.get('/vouchers/:code', async (req) => {
    const v = await prisma.voucher.findUnique({ where: { companyId_code: { companyId: req.user.companyId, code: (req.params as { code: string }).code.toUpperCase() } } });
    if (!v) throw notFound('Vale-troca');
    return v;
  });
}

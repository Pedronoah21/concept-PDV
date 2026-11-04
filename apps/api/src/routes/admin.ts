import type { FastifyInstance } from 'fastify';
import { isValidCNPJ, onlyDigits } from '@concept/shared';
import { z } from 'zod';
import { audit, prisma } from '../db';
import { guard, hashPassword, requireAuth } from '../lib/auth';
import { badRequest, notFound } from '../lib/errors';
import { dateRange, parse } from '../lib/http';

const companyInput = z.object({
  legalName: z.string().min(2),
  tradeName: z.string().min(2),
  cnpj: z.string(),
  ie: z.string().nullish(),
  crt: z.number().int().min(1).max(3),
  phone: z.string().nullish(),
  email: z.string().nullish(),
  zip: z.string().nullish(),
  street: z.string().nullish(),
  number: z.string().nullish(),
  district: z.string().nullish(),
  city: z.string().nullish(),
  cityCode: z.string().nullish(),
  uf: z.string().length(2).nullish(),
  receiptFooter: z.string().max(200).nullish(),
  onlineStoreOn: z.boolean(),
  allowNegativeStock: z.boolean(),
  fiscalProvider: z.enum(['mock', 'focusnfe']),
  fiscalEnv: z.enum(['HOMOLOGACAO', 'PRODUCAO']),
  /** Enviado só quando trocado; nunca é devolvido pela API. */
  fiscalToken: z.string().nullish(),
});

const userInput = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8).optional(),
  role: z.enum(['ADMIN', 'GERENTE', 'CAIXA', 'VENDEDOR']),
  maxDiscountPct: z.number().int().min(0).max(100),
  active: z.boolean().default(true),
  /** Loja do usuário (vazio = todas) e caixa que abre direto ao entrar */
  storeId: z.string().nullish(),
  registerId: z.string().nullish(),
});

/** Confere loja e caixa do usuário: precisam ser da empresa, e o caixa da loja escolhida. */
async function userStoreData(companyId: string, body: { role: string; storeId?: string | null; registerId?: string | null }) {
  const storeId = body.storeId || null;
  const registerId = body.registerId || null;
  if (!storeId && ['CAIXA', 'VENDEDOR'].includes(body.role)) throw badRequest('Escolha a loja do operador de caixa ou vendedor');
  if (storeId && !(await prisma.store.findFirst({ where: { id: storeId, companyId } }))) throw badRequest('Loja inválida');
  if (registerId) {
    const r = await prisma.register.findFirst({ where: { id: registerId, store: { companyId } } });
    if (!r || (storeId && r.storeId !== storeId)) throw badRequest('O caixa padrão precisa ser da loja do usuário');
    if (!storeId) throw badRequest('Escolha a loja antes do caixa padrão');
  }
  return { storeId, registerId };
}

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ---------------- Empresa ----------------
  app.get('/company', async (req) => {
    const { fiscalToken, ...c } = await prisma.company.findUniqueOrThrow({ where: { id: req.user.companyId } });
    return { ...c, hasFiscalToken: !!fiscalToken };
  });
  app.put('/company', { preHandler: guard('config:editar') }, async (req) => {
    const body = parse(companyInput, req.body);
    const cnpj = onlyDigits(body.cnpj);
    if (!isValidCNPJ(cnpj)) throw badRequest('CNPJ inválido');
    const { fiscalToken, ...rest } = body;
    const updated = await prisma.company.update({
      where: { id: req.user.companyId },
      data: { ...rest, cnpj, ...(fiscalToken ? { fiscalToken } : {}) },
    });
    await audit(prisma, req.user.companyId, req.user.id, 'empresa.editar', 'Company', updated.id);
    return { ok: true };
  });

  // ---------------- Lojas e caixas ----------------
  app.get('/stores', async (req) =>
    prisma.store.findMany({ where: { companyId: req.user.companyId }, include: { registers: true }, orderBy: { name: 'asc' } }),
  );
  app.post('/stores', { preHandler: guard('config:editar') }, async (req) => {
    const body = parse(z.object({ name: z.string().min(2), isOnline: z.boolean().default(false) }), req.body);
    return prisma.$transaction(async (tx) => {
      if (body.isOnline) await tx.store.updateMany({ where: { companyId: req.user.companyId }, data: { isOnline: false } });
      return tx.store.create({ data: { ...body, companyId: req.user.companyId } });
    });
  });
  app.post('/stores/:id/registers', { preHandler: guard('config:editar') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ name: z.string().min(2), code: z.string().min(2).max(8) }), req.body);
    const store = await prisma.store.findFirst({ where: { id, companyId: req.user.companyId } });
    if (!store) throw notFound('Loja');
    return prisma.register.create({ data: { storeId: id, name: body.name, code: body.code.toUpperCase() } });
  });

  // ---------------- Usuários ----------------
  app.get('/users', { preHandler: guard('config:editar') }, async (req) =>
    prisma.user.findMany({
      where: { companyId: req.user.companyId },
      select: { id: true, name: true, email: true, role: true, maxDiscountPct: true, active: true, createdAt: true, storeId: true, registerId: true, store: { select: { name: true } }, register: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
  );
  app.post('/users', { preHandler: guard('config:editar') }, async (req) => {
    const body = parse(userInput, req.body);
    if (!body.password) throw badRequest('Defina uma senha com ao menos 8 caracteres');
    const { password, storeId: _s, registerId: _r, ...data } = body;
    const link = await userStoreData(req.user.companyId, body);
    return prisma.user.create({
      data: { ...data, ...link, email: data.email.toLowerCase(), passwordHash: await hashPassword(password), companyId: req.user.companyId },
      select: { id: true, name: true, email: true, role: true },
    });
  });
  app.put('/users/:id', { preHandler: guard('config:editar') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(userInput, req.body);
    const u = await prisma.user.findFirst({ where: { id, companyId: req.user.companyId } });
    if (!u) throw notFound('Usuário');
    if (id === req.user.id && (body.role !== 'ADMIN' || !body.active)) throw badRequest('Você não pode remover o próprio acesso de administrador');
    const { password, storeId: _s, registerId: _r, ...data } = body;
    const link = await userStoreData(req.user.companyId, body);
    await prisma.user.update({
      where: { id },
      data: { ...data, ...link, email: data.email.toLowerCase(), ...(password ? { passwordHash: await hashPassword(password) } : {}) },
    });
    if (!body.active || password) await prisma.session.deleteMany({ where: { userId: id } });
    return { ok: true };
  });

  // ---------------- Relatórios ----------------
  app.get('/reports/summary', { preHandler: guard('relatorio:ver') }, async (req) => {
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    const where = { companyId: req.user.companyId, status: 'CONCLUIDA' as const, createdAt: { gte: from, lte: to } };
    const [totals, byPayment, byDay, topProducts, byChannel, review, pendingFiscal] = await Promise.all([
      prisma.sale.aggregate({ where, _sum: { totalCents: true, costCents: true, discountCents: true, changeCents: true }, _count: true }),
      prisma.salePayment.groupBy({ by: ['method'], where: { sale: where }, _sum: { amountCents: true } }),
      prisma.$queryRaw<{ day: Date; total: bigint; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, SUM("totalCents")::bigint AS total, COUNT(*)::bigint AS count
        FROM "Sale" WHERE "companyId" = ${req.user.companyId} AND status = 'CONCLUIDA' AND "createdAt" BETWEEN ${from} AND ${to}
        GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<{ description: string; qty: bigint; total: bigint; cost: bigint }[]>`
        SELECT i.description, SUM(i.quantity - i."returnedQty")::bigint AS qty, SUM(i."totalCents")::bigint AS total,
               SUM(i."unitCostCents" * i.quantity)::bigint AS cost
        FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
        WHERE s."companyId" = ${req.user.companyId} AND s.status = 'CONCLUIDA' AND s."createdAt" BETWEEN ${from} AND ${to}
        GROUP BY i.description ORDER BY total DESC LIMIT 20`,
      prisma.sale.groupBy({ by: ['channel'], where, _sum: { totalCents: true }, _count: true }),
      prisma.sale.count({ where: { companyId: req.user.companyId, needsReview: true } }),
      prisma.fiscalDocument.count({ where: { companyId: req.user.companyId, status: { in: ['PENDENTE', 'ERRO', 'REJEITADA'] } } }),
    ]);
    const revenue = totals._sum.totalCents ?? 0;
    const cost = totals._sum.costCents ?? 0;
    return {
      from,
      to,
      salesCount: totals._count,
      revenueCents: revenue,
      costCents: cost,
      grossProfitCents: revenue - cost,
      marginPct: revenue ? ((revenue - cost) / revenue) * 100 : 0,
      ticketCents: totals._count ? Math.round(revenue / totals._count) : 0,
      discountCents: totals._sum.discountCents ?? 0,
      // Dinheiro líquido: o troco devolvido não é receita.
      byPayment: byPayment.map((p) => ({
        method: p.method,
        totalCents: (p._sum.amountCents ?? 0) - (p.method === 'DINHEIRO' ? totals._sum.changeCents ?? 0 : 0),
      })),
      byDay: byDay.map((d) => ({ day: d.day, totalCents: Number(d.total), count: Number(d.count) })),
      byChannel: byChannel.map((c) => ({ channel: c.channel, totalCents: c._sum.totalCents ?? 0, count: c._count })),
      topProducts: topProducts.map((t) => ({ description: t.description, quantity: Number(t.qty), totalCents: Number(t.total), profitCents: Number(t.total) - Number(t.cost) })),
      alerts: { needsReview: review, pendingFiscal },
    };
  });

  /** Curva ABC: A = produtos que somam 80% do faturamento, B = próximos 15%, C = restante. */
  app.get('/reports/abc', { preHandler: guard('relatorio:ver') }, async (req) => {
    const { from, to } = dateRange(req.query as { from?: string; to?: string });
    const rows = await prisma.$queryRaw<{ productId: string; name: string; total: bigint; qty: bigint }[]>`
      SELECT p.id AS "productId", p.name, SUM(i."totalCents")::bigint AS total, SUM(i.quantity)::bigint AS qty
      FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId" JOIN "Variant" v ON v.id = i."variantId" JOIN "Product" p ON p.id = v."productId"
      WHERE s."companyId" = ${req.user.companyId} AND s.status = 'CONCLUIDA' AND s."createdAt" BETWEEN ${from} AND ${to}
      GROUP BY p.id, p.name ORDER BY total DESC`;
    const grand = rows.reduce((a, r) => a + Number(r.total), 0);
    let acc = 0;
    return rows.map((r) => {
      // A classe vem da participação acumulada ANTES do item: o maior vendedor é sempre A.
      const before = grand ? acc / grand : 0;
      acc += Number(r.total);
      const share = grand ? acc / grand : 0;
      return { productId: r.productId, name: r.name, totalCents: Number(r.total), quantity: Number(r.qty), cumulativePct: share * 100, class: before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C' };
    });
  });

  /** Produtos parados: com estoque e sem venda no período. */
  app.get('/reports/stale', { preHandler: guard('relatorio:ver') }, async (req) => {
    const days = Number((req.query as { days?: string }).days) || 60;
    const since = new Date(Date.now() - days * 86_400_000);
    return prisma.$queryRaw<unknown[]>`
      SELECT v.id AS "variantId", p.name, v.color, v.size, b.qty AS quantity, v."avgCostCents", ls.last AS "lastSale"
      FROM "Variant" v
      JOIN "Product" p ON p.id = v."productId"
      JOIN (SELECT "variantId", SUM(quantity)::int AS qty FROM "StockBalance" GROUP BY 1) b ON b."variantId" = v.id
      LEFT JOIN (
        SELECT i."variantId", MAX(s."createdAt") AS last
        FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId" AND s.status = 'CONCLUIDA'
        GROUP BY 1
      ) ls ON ls."variantId" = v.id
      WHERE p."companyId" = ${req.user.companyId} AND v.active AND b.qty > 0 AND (ls.last IS NULL OR ls.last < ${since})
      ORDER BY b.qty * v."avgCostCents" DESC LIMIT 200`;
  });

  app.get('/audit', { preHandler: guard('config:editar') }, async (req) =>
    prisma.auditLog.findMany({ where: { companyId: req.user.companyId }, orderBy: { createdAt: 'desc' }, take: 300 }),
  );
}


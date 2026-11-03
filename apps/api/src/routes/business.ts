import type { FastifyInstance } from 'fastify';
import { isValidCpfCnpj, onlyDigits } from '@concept/shared';
import { z } from 'zod';
import { prisma } from '../db';
import { guard, requireAuth } from '../lib/auth';
import { badRequest, notFound } from '../lib/errors';
import { parse } from '../lib/http';
import { createPurchase, previewNfeImport, purchaseInput } from '../services/purchases';
import { invoiceOrder, orderStatusInput, updateOrderStatus } from '../services/orders';
import { cancelFiscal, processDocument } from '../fiscal/queue';

const customerInput = z.object({
  name: z.string().min(2),
  document: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  phone: z.string().nullish(),
  birthDate: z.string().nullish(),
  zip: z.string().nullish(),
  street: z.string().nullish(),
  number: z.string().nullish(),
  complement: z.string().nullish(),
  district: z.string().nullish(),
  city: z.string().nullish(),
  cityCode: z.string().nullish(),
  uf: z.string().max(2).nullish(),
  creditLimitCents: z.number().int().nonnegative().default(0),
  notes: z.string().nullish(),
});

function customerData(body: z.infer<typeof customerInput>) {
  const document = body.document ? onlyDigits(body.document) : null;
  if (document && !isValidCpfCnpj(document)) throw badRequest('CPF/CNPJ inválido');
  return { ...body, email: body.email || null, document, birthDate: body.birthDate ? new Date(body.birthDate) : null };
}

export default async function businessRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ---------------- Clientes ----------------
  app.get('/customers', async (req) => {
    const { q } = req.query as { q?: string };
    const digits = q ? onlyDigits(q) : '';
    return prisma.customer.findMany({
      where: {
        companyId: req.user.companyId,
        active: true,
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, ...(digits ? [{ document: { startsWith: digits } }, { phone: { contains: digits } }] : [])] } : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
    });
  });
  app.get('/customers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const c = await prisma.customer.findFirst({
      where: { id, companyId: req.user.companyId },
      include: {
        sales: { orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, number: true, totalCents: true, createdAt: true, status: true } },
        installments: { where: { status: 'ABERTA' }, orderBy: { dueDate: 'asc' } },
      },
    });
    if (!c) throw notFound('Cliente');
    const openCents = c.installments.reduce((a, i) => a + i.amountCents - i.paidCents, 0);
    return { ...c, openCents, availableCreditCents: Math.max(0, c.creditLimitCents - openCents) };
  });
  app.post('/customers', { preHandler: guard('cliente:editar') }, async (req) =>
    prisma.customer.create({ data: { ...customerData(parse(customerInput, req.body)), companyId: req.user.companyId } }),
  );
  app.put('/customers/:id', { preHandler: guard('cliente:editar') }, async (req) => {
    const { id } = req.params as { id: string };
    const exists = await prisma.customer.findFirst({ where: { id, companyId: req.user.companyId } });
    if (!exists) throw notFound('Cliente');
    return prisma.customer.update({ where: { id }, data: customerData(parse(customerInput, req.body)) });
  });

  // ---------------- Compras / entrada de mercadoria ----------------
  app.get('/purchases', { preHandler: guard('compra:lancar') }, async (req) =>
    prisma.purchase.findMany({
      where: { companyId: req.user.companyId },
      include: { supplier: { select: { name: true } }, _count: { select: { items: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  );
  app.post('/purchases', { preHandler: guard('compra:lancar') }, async (req) => createPurchase(req.user, parse(purchaseInput, req.body)));
  /** Lê o XML da NF-e do fornecedor e sugere os itens da entrada. */
  app.post('/purchases/parse-xml', { preHandler: guard('compra:lancar'), bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const { xml } = parse(z.object({ xml: z.string().min(50) }), req.body);
    return previewNfeImport(req.user.companyId, xml);
  });
  app.get('/payables', { preHandler: guard('compra:lancar') }, async (req) =>
    prisma.payable.findMany({ where: { companyId: req.user.companyId, paidAt: null }, orderBy: { dueDate: 'asc' }, take: 300 }),
  );
  app.post('/payables/:id/pay', { preHandler: guard('compra:lancar') }, async (req) => {
    const { id } = req.params as { id: string };
    const p = await prisma.payable.findFirst({ where: { id, companyId: req.user.companyId } });
    if (!p) throw notFound('Conta');
    return prisma.payable.update({ where: { id }, data: { paidAt: new Date() } });
  });

  // ---------------- Pedidos online (painel) ----------------
  app.get('/orders', { preHandler: guard('pedido:gerir') }, async (req) => {
    const { status } = req.query as { status?: string };
    return prisma.order.findMany({
      where: { companyId: req.user.companyId, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });
  app.patch('/orders/:id', async (req) => updateOrderStatus(req.user, (req.params as { id: string }).id, parse(orderStatusInput, req.body)));
  app.post('/orders/:id/invoice', async (req) => {
    const result = await invoiceOrder(req.user, (req.params as { id: string }).id);
    const doc = await prisma.fiscalDocument.findFirst({ where: { saleId: result.saleId } });
    if (doc) await processDocument(doc.id).catch(() => undefined);
    return result;
  });

  // ---------------- Documentos fiscais ----------------
  app.get('/fiscal', { preHandler: guard('fiscal:gerir') }, async (req) => {
    const { status } = req.query as { status?: string };
    return prisma.fiscalDocument.findMany({
      where: { companyId: req.user.companyId, ...(status ? { status: status as never } : {}) },
      include: { sale: { select: { number: true, totalCents: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  });
  app.post('/fiscal/:id/retry', { preHandler: guard('fiscal:gerir') }, async (req) => {
    const { id } = req.params as { id: string };
    const doc = await prisma.fiscalDocument.findFirst({ where: { id, companyId: req.user.companyId } });
    if (!doc) throw notFound('Documento fiscal');
    if (['AUTORIZADA', 'CANCELADA'].includes(doc.status)) throw badRequest('Documento já finalizado');
    return processDocument(id);
  });
  app.post('/fiscal/:id/cancel', { preHandler: guard('fiscal:gerir') }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = parse(z.object({ reason: z.string().min(15) }), req.body);
    const doc = await cancelFiscal(req.user.companyId, id, reason);
    if (!doc) throw notFound('Documento fiscal');
    return doc;
  });
}

import { randomUUID } from 'node:crypto';
import { onlyDigits } from '@concept/shared';
import { z } from 'zod';
import { audit, nextNumber, prisma } from '../db';
import { badRequest, notFound } from '../lib/errors';
import { assertCan, type AuthUser } from '../lib/auth';
import { moveStock, reserveStock } from './stock';
import { effectivePrice } from './sales';
import { enqueueFiscal } from '../fiscal/queue';

export const orderInput = z.object({
  customer: z.object({
    name: z.string().min(3),
    email: z.string().email(),
    phone: z.string().min(8),
    document: z.string().nullish(),
  }),
  delivery: z.enum(['RETIRADA', 'ENTREGA']),
  address: z
    .object({
      zip: z.string(),
      street: z.string(),
      number: z.string(),
      complement: z.string().nullish(),
      district: z.string(),
      city: z.string(),
      uf: z.string().length(2),
    })
    .nullish(),
  paymentMethod: z.enum(['PIX', 'CREDITO', 'DEBITO', 'DINHEIRO']),
  items: z.array(z.object({ variantId: z.string(), quantity: z.number().int().positive().max(99) })).min(1),
  notes: z.string().max(500).nullish(),
});

type OrderItem = { variantId: string; description: string; quantity: number; unitPriceCents: number };

/** Catálogo público da loja online (só produtos visíveis e com estoque). */
export async function publicCatalog(slug: string) {
  const company = await prisma.company.findUnique({ where: { slug } });
  if (!company || !company.onlineStoreOn) throw notFound('Loja');
  const store = await prisma.store.findFirst({ where: { companyId: company.id, isOnline: true, active: true } });
  if (!store) throw notFound('Loja online');
  const products = await prisma.product.findMany({
    where: { companyId: company.id, active: true, onlineVisible: true },
    include: {
      category: { select: { name: true } },
      variants: { where: { active: true }, include: { balances: { where: { storeId: store.id } } } },
    },
    orderBy: { name: 'asc' },
  });
  return {
    company: { name: company.tradeName, phone: company.phone, city: company.city, uf: company.uf },
    products: products
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        brand: p.brand,
        category: p.category?.name ?? null,
        imageUrl: p.imageUrl,
        variants: p.variants.map((v) => ({
          id: v.id,
          color: v.color,
          size: v.size,
          priceCents: v.priceCents,
          finalPriceCents: effectivePrice(v),
          available: Math.max(0, (v.balances[0]?.quantity ?? 0) - (v.balances[0]?.reserved ?? 0)),
        })),
      }))
      .filter((p) => p.variants.some((v) => v.available > 0)),
  };
}

export async function createOrder(slug: string, input: z.infer<typeof orderInput>) {
  if (input.delivery === 'ENTREGA' && !input.address) throw badRequest('Informe o endereço de entrega');
  return prisma.$transaction(async (tx) => {
    const company = await tx.company.findUnique({ where: { slug } });
    if (!company || !company.onlineStoreOn) throw notFound('Loja');
    const store = await tx.store.findFirst({ where: { companyId: company.id, isOnline: true, active: true } });
    if (!store) throw notFound('Loja online');
    const variants = await tx.variant.findMany({
      where: { id: { in: input.items.map((i) => i.variantId) }, active: true, product: { companyId: company.id, active: true, onlineVisible: true } },
      include: { product: true },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    const items: OrderItem[] = input.items.map((i) => {
      const v = byId.get(i.variantId);
      if (!v) throw badRequest('Produto indisponível');
      return { variantId: v.id, description: [v.product.name, v.color, v.size].filter(Boolean).join(' '), quantity: i.quantity, unitPriceCents: effectivePrice(v) };
    });
    for (const i of items) await reserveStock(tx, store.id, i.variantId, i.quantity);
    const subtotal = items.reduce((a, i) => a + i.quantity * i.unitPriceCents, 0);
    const number = await nextNumber(tx, company.id, 'order');
    const order = await tx.order.create({
      data: {
        companyId: company.id,
        storeId: store.id,
        number,
        customerName: input.customer.name,
        customerEmail: input.customer.email.toLowerCase(),
        customerPhone: input.customer.phone,
        customerDoc: input.customer.document ? onlyDigits(input.customer.document) : null,
        addressJson: input.address ?? {},
        itemsJson: items,
        subtotalCents: subtotal,
        shippingCents: 0, // frete a combinar; configurável pela loja no painel
        totalCents: subtotal,
        paymentMethod: input.paymentMethod,
        delivery: input.delivery,
        notes: input.notes,
      },
    });
    return { id: order.id, number: order.number, totalCents: order.totalCents, status: order.status };
  });
}

export const orderStatusInput = z.object({
  status: z.enum(['PAGO', 'SEPARACAO', 'ENVIADO', 'ENTREGUE', 'CANCELADO']),
  shippingCents: z.number().int().nonnegative().optional(),
});

export async function updateOrderStatus(user: AuthUser, id: string, input: z.infer<typeof orderStatusInput>) {
  assertCan(user, 'pedido:gerir');
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id, companyId: user.companyId } });
    if (!order) throw notFound('Pedido');
    if (order.status === 'CANCELADO') throw badRequest('Pedido cancelado');
    if (input.status === 'CANCELADO') {
      if (order.saleId) throw badRequest('Pedido já faturado: cancele a venda correspondente');
      for (const i of order.itemsJson as OrderItem[]) await reserveStock(tx, order.storeId, i.variantId, -i.quantity);
    }
    const shipping = input.shippingCents ?? order.shippingCents;
    await audit(tx, user.companyId, user.id, 'pedido.status', 'Order', id, input);
    return tx.order.update({
      where: { id },
      data: { status: input.status, shippingCents: shipping, totalCents: order.subtotalCents + shipping },
    });
  });
}

/**
 * Fatura o pedido: vira venda do canal ONLINE, baixa o estoque reservado e pede a nota.
 * NFC-e (entrega no mesmo estado ou retirada) ou NF-e (outro estado).
 */
export async function invoiceOrder(user: AuthUser, id: string) {
  assertCan(user, 'pedido:gerir');
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id, companyId: user.companyId } });
    if (!order) throw notFound('Pedido');
    if (order.saleId) throw badRequest('Pedido já faturado');
    if (order.status === 'CANCELADO' || order.status === 'PENDENTE') throw badRequest('Confirme o pagamento do pedido antes de faturar');
    const company = await tx.company.findUniqueOrThrow({ where: { id: user.companyId } });
    const items = order.itemsJson as OrderItem[];
    const variants = await tx.variant.findMany({ where: { id: { in: items.map((i) => i.variantId) } } });
    const cost = new Map(variants.map((v) => [v.id, v.avgCostCents]));
    const address = order.addressJson as Record<string, string>;

    let customerId: string | null = null;
    if (order.customerDoc) {
      const c = await tx.customer.upsert({
        where: { companyId_document: { companyId: company.id, document: order.customerDoc } },
        create: { companyId: company.id, name: order.customerName, document: order.customerDoc, email: order.customerEmail, phone: order.customerPhone, ...address },
        update: {},
      });
      customerId = c.id;
    }

    const saleId = randomUUID();
    const number = await nextNumber(tx, company.id, 'sale');
    const gross = items.reduce((a, i) => a + i.quantity * i.unitPriceCents, 0);
    await tx.sale.create({
      data: {
        id: saleId,
        companyId: company.id,
        storeId: order.storeId,
        number,
        channel: 'ONLINE',
        customerId,
        userId: user.id,
        cpfNaNota: order.customerDoc,
        grossCents: gross,
        discountCents: 0,
        totalCents: gross,
        shippingCents: order.shippingCents,
        costCents: items.reduce((a, i) => a + i.quantity * (cost.get(i.variantId) ?? 0), 0),
        createdAt: new Date(),
        notes: `Pedido online #${order.number}`,
        items: {
          create: items.map((i) => ({
            variantId: i.variantId,
            description: i.description,
            quantity: i.quantity,
            unitPriceCents: i.unitPriceCents,
            discountCents: 0,
            totalCents: i.quantity * i.unitPriceCents,
            unitCostCents: cost.get(i.variantId) ?? 0,
          })),
        },
        payments: { create: [{ method: order.paymentMethod, amountCents: order.totalCents }] },
      },
    });
    for (const i of items) {
      await reserveStock(tx, order.storeId, i.variantId, -i.quantity);
      await moveStock(tx, {
        companyId: company.id,
        storeId: order.storeId,
        variantId: i.variantId,
        type: 'VENDA',
        quantity: -i.quantity,
        unitCostCents: cost.get(i.variantId),
        refType: 'order',
        refId: order.id,
        userId: user.id,
        allowNegative: true,
      });
    }
    await tx.order.update({ where: { id }, data: { saleId } });

    const dest = {
      name: order.customerName,
      document: order.customerDoc,
      email: order.customerEmail,
      phone: order.customerPhone,
      ...address,
    };
    const interstate = order.delivery === 'ENTREGA' && address.uf && company.uf && address.uf !== company.uf;
    if (interstate) {
      if (!order.customerDoc) throw badRequest('Venda para outro estado exige CPF/CNPJ do cliente (NF-e)');
      await enqueueFiscal(tx, company, saleId, number, 'NFE', { dest });
    } else {
      await enqueueFiscal(tx, company, saleId, number, 'NFCE', { presenca: order.delivery === 'ENTREGA' ? '4' : '1', dest });
    }
    await audit(tx, user.companyId, user.id, 'pedido.faturar', 'Order', id, { saleId });
    return { saleId, number };
  });
}

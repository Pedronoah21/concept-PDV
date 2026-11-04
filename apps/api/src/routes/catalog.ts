import type { FastifyInstance } from 'fastify';
import { internalEAN13, onlyDigits } from '@concept/shared';
import { z } from 'zod';
import { audit, nextNumber, prisma, type Tx } from '../db';
import { can, guard, requireAuth, soldInStore } from '../lib/auth';
import { badRequest, conflict, notFound } from '../lib/errors';
import { parse } from '../lib/http';
import { moveStock } from '../services/stock';

const variantInput = z.object({
  id: z.string().optional(),
  sku: z.string().optional(),
  barcode: z.string().nullish(),
  color: z.string().nullish(),
  size: z.string().nullish(),
  priceCents: z.number().int().nonnegative(),
  promoPriceCents: z.number().int().nonnegative().nullish(),
  minStock: z.number().int().nonnegative().default(0),
  active: z.boolean().default(true),
  /** Saldo inicial (só na criação) */
  initialStock: z.number().int().nonnegative().optional(),
  initialCostCents: z.number().int().nonnegative().optional(),
});

const productInput = z.object({
  code: z
    .string()
    .trim()
    .max(30)
    .regex(/^[A-Za-z0-9._/-]*$/, 'Código: use só letras, números, ponto, barra, traço ou sublinhado')
    .nullish()
    .transform((c) => (c ? c.toUpperCase() : null)),
  name: z.string().min(2),
  description: z.string().nullish(),
  brand: z.string().nullish(),
  categoryId: z.string().nullish(),
  unit: z.string().default('UN'),
  imageUrl: z.string().url().nullish(),
  onlineVisible: z.boolean().default(true),
  active: z.boolean().default(true),
  ncm: z.string().regex(/^\d{8}$/, 'NCM deve ter 8 dígitos'),
  cest: z.string().regex(/^\d{7}$/).nullish(),
  origin: z.number().int().min(0).max(8).default(0),
  cfop: z.string().regex(/^\d{4}$/).default('5102'),
  csosn: z.string().nullish(),
  cstIcms: z.string().nullish(),
  icmsRate: z.number().int().nonnegative().default(0),
  cstPis: z.string().default('49'),
  cstCofins: z.string().default('49'),
  variants: z.array(variantInput).min(1),
  storeId: z.string().optional(),
  /** Lojas onde o produto é vendido. Vazio = todas. */
  storeIds: z.array(z.string()).max(200).default([]),
});

const adjustInput = z.object({
  variantId: z.string(),
  storeId: z.string(),
  type: z.enum(['AJUSTE', 'PERDA', 'INVENTARIO']),
  /** AJUSTE/PERDA: quantidade a somar (negativa para tirar). INVENTARIO: saldo contado. */
  quantity: z.number().int(),
  reason: z.string().min(3),
});

const minStockInput = z.object({
  minStock: z.number().int().min(0).max(100_000),
  variantIds: z.array(z.string()).max(2000).optional(),
  categoryId: z.string().optional(),
});

const transferInput = z.object({
  variantId: z.string(),
  fromStoreId: z.string(),
  toStoreId: z.string(),
  quantity: z.number().int().positive(),
});

/** Próximo código livre no formato 00001, pulando os que a loja já usou manualmente. */
async function freeProductCode(tx: Tx, companyId: string) {
  for (;;) {
    const code = String(await nextNumber(tx, companyId, 'product')).padStart(5, '0');
    if (!(await tx.product.findFirst({ where: { companyId, code }, select: { id: true } }))) return code;
  }
}

async function assertStores(tx: Tx, companyId: string, storeIds: string[]) {
  if (!storeIds.length) return;
  const n = await tx.store.count({ where: { id: { in: storeIds }, companyId } });
  if (n !== new Set(storeIds).size) throw badRequest('Loja inválida no produto');
}

async function assertCodeFree(tx: Tx, companyId: string, code: string, exceptId?: string) {
  const other = await tx.product.findFirst({ where: { companyId, code, ...(exceptId ? { NOT: { id: exceptId } } : {}) }, select: { name: true } });
  if (other) throw conflict(`O código ${code} já é do produto "${other.name}"`, 'CODIGO_DUPLICADO');
}

export default async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ---------------- Categorias e fornecedores ----------------
  app.get('/categories', async (req) => prisma.category.findMany({ where: { companyId: req.user.companyId }, orderBy: { name: 'asc' } }));
  app.post('/categories', { preHandler: guard('produto:editar') }, async (req) => {
    const { name } = parse(z.object({ name: z.string().min(2) }), req.body);
    return prisma.category.upsert({
      where: { companyId_name: { companyId: req.user.companyId, name } },
      create: { companyId: req.user.companyId, name },
      update: {},
    });
  });

  app.get('/suppliers', async (req) =>
    prisma.supplier.findMany({ where: { companyId: req.user.companyId, active: true }, orderBy: { name: 'asc' } }),
  );
  app.post('/suppliers', { preHandler: guard('compra:lancar') }, async (req) => {
    const body = parse(
      z.object({ name: z.string().min(2), document: z.string().nullish(), phone: z.string().nullish(), email: z.string().nullish(), notes: z.string().nullish() }),
      req.body,
    );
    const document = body.document ? onlyDigits(body.document) : null;
    if (document) {
      const exists = await prisma.supplier.findFirst({ where: { companyId: req.user.companyId, document } });
      if (exists) return exists;
    }
    return prisma.supplier.create({ data: { ...body, document, companyId: req.user.companyId } });
  });

  // ---------------- Produtos ----------------
  app.get('/products', async (req) => {
    const q = req.query as { q?: string; storeId?: string; categoryId?: string; inactive?: string; soldIn?: string };
    const term = q.q?.trim();
    const soldIn = req.user.storeId ?? q.soldIn;
    const products = await prisma.product.findMany({
      where: {
        AND: soldIn ? [soldInStore(soldIn)] : [],
        companyId: req.user.companyId,
        ...(q.inactive ? {} : { active: true }),
        ...(q.categoryId ? { categoryId: q.categoryId } : {}),
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { code: { equals: term, mode: 'insensitive' } },
                { brand: { contains: term, mode: 'insensitive' } },
                { variants: { some: { OR: [{ barcode: term }, { sku: { equals: term, mode: 'insensitive' } }] } } },
              ],
            }
          : {}),
      },
      include: {
        category: true,
        stores: { select: { storeId: true, store: { select: { name: true } } } },
        variants: { include: { balances: true }, orderBy: [{ color: 'asc' }, { size: 'asc' }] },
      },
      orderBy: { name: 'asc' },
      take: 500,
    });
    const showCost = can(req.user, 'custo:ver');
    return products.map((p) => ({
      ...p,
      variants: p.variants.map(({ avgCostCents, ...v }) => ({
        ...v,
        ...(showCost ? { avgCostCents } : {}),
        stock: v.balances.filter((b) => !q.storeId || b.storeId === q.storeId).reduce((a, b) => a + b.quantity, 0),
      })),
    }));
  });

  app.get('/products/:id', async (req) => {
    const { id } = req.params as { id: string };
    const p = await prisma.product.findFirst({
      where: { id, companyId: req.user.companyId },
      include: { category: true, stores: { select: { storeId: true } }, variants: { include: { balances: { include: { store: { select: { name: true } } } } } } },
    });
    if (!p) throw notFound('Produto');
    return p;
  });

  app.post('/products', { preHandler: guard('produto:editar') }, async (req) => {
    const body = parse(productInput, req.body);
    const { variants, storeId, storeIds, code: wanted, ...data } = body;
    return prisma.$transaction(async (tx) => {
      await assertStores(tx, req.user.companyId, storeIds);
      const code = wanted ?? (await freeProductCode(tx, req.user.companyId));
      await assertCodeFree(tx, req.user.companyId, code);
      const product = await tx.product.create({
        data: { ...data, code, companyId: req.user.companyId, stores: { create: storeIds.map((sid) => ({ storeId: sid })) } },
      });
      for (const [i, v] of variants.entries()) {
        if (v.barcode) {
          const dup = await tx.variant.findFirst({ where: { barcode: v.barcode, product: { companyId: req.user.companyId } } });
          if (dup) throw conflict(`Código de barras ${v.barcode} já cadastrado`, 'CODIGO_DUPLICADO');
        }
        const barcode = v.barcode || internalEAN13(await nextNumber(tx, req.user.companyId, 'ean'));
        const created = await tx.variant.create({
          data: {
            productId: product.id,
            sku: v.sku || `${code}${variants.length > 1 ? '-' + (i + 1) : ''}`,
            barcode,
            color: v.color,
            size: v.size,
            priceCents: v.priceCents,
            promoPriceCents: v.promoPriceCents,
            minStock: v.minStock,
            active: v.active,
            avgCostCents: v.initialCostCents ?? 0,
          },
        });
        if (v.initialStock && storeId) {
          await moveStock(tx, {
            companyId: req.user.companyId,
            storeId,
            variantId: created.id,
            type: 'AJUSTE',
            quantity: v.initialStock,
            unitCostCents: v.initialCostCents,
            reason: 'Saldo inicial',
            userId: req.user.id,
          });
        }
      }
      await audit(tx, req.user.companyId, req.user.id, 'produto.criar', 'Product', product.id);
      return tx.product.findUnique({ where: { id: product.id }, include: { variants: true } });
    });
  });

  app.put('/products/:id', { preHandler: guard('produto:editar') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(productInput, req.body);
    const { variants, storeId: _s, storeIds, code: wanted, ...data } = body;
    return prisma.$transaction(async (tx) => {
      await assertStores(tx, req.user.companyId, storeIds);
      const current = await tx.product.findFirst({ where: { id, companyId: req.user.companyId }, include: { variants: true } });
      if (!current) throw notFound('Produto');
      const oldCode = current.code ?? current.variants[0]?.sku.split('-')[0] ?? null;
      const code = wanted ?? oldCode ?? (await freeProductCode(tx, req.user.companyId));
      if (code !== current.code) await assertCodeFree(tx, req.user.companyId, code, id);
      await tx.product.update({ where: { id }, data: { ...data, code } });
      await tx.productStore.deleteMany({ where: { productId: id } });
      if (storeIds.length) await tx.productStore.createMany({ data: storeIds.map((sid) => ({ productId: id, storeId: sid })) });
      // Trocou o código do produto: as variações que seguiam o código antigo acompanham.
      if (oldCode && code !== oldCode) {
        for (const cv of current.variants) {
          if (cv.sku === oldCode || cv.sku.startsWith(oldCode + '-')) {
            await tx.variant.update({ where: { id: cv.id }, data: { sku: code + cv.sku.slice(oldCode.length) } });
          }
        }
      }
      const used = new Set(current.variants.map((cv) => cv.sku.replace(oldCode ?? '', code)));
      let nextSuffix = current.variants.length + 1;
      const nextSku = () => {
        while (used.has(`${code}-${nextSuffix}`)) nextSuffix++;
        const s = `${code}-${nextSuffix++}`;
        used.add(s);
        return s;
      };
      for (const v of variants) {
        if (v.barcode) {
          const dup = await tx.variant.findFirst({ where: { barcode: v.barcode, product: { companyId: req.user.companyId }, NOT: v.id ? { id: v.id } : undefined } });
          if (dup) throw conflict(`Código de barras ${v.barcode} já cadastrado`, 'CODIGO_DUPLICADO');
        }
        const fields = { color: v.color, size: v.size, priceCents: v.priceCents, promoPriceCents: v.promoPriceCents ?? null, minStock: v.minStock, active: v.active };
        if (v.id) {
          if (!current.variants.some((cv) => cv.id === v.id)) throw badRequest('Variação inválida');
          await tx.variant.update({ where: { id: v.id }, data: { ...fields, ...(v.barcode ? { barcode: v.barcode } : {}), ...(v.sku ? { sku: v.sku } : {}) } });
        } else {
          await tx.variant.create({
            data: {
              ...fields,
              productId: id,
              sku: v.sku || nextSku(),
              barcode: v.barcode || internalEAN13(await nextNumber(tx, req.user.companyId, 'ean')),
            },
          });
        }
      }
      // Variações removidas da tela são desativadas (nunca apagadas: há histórico de vendas).
      const keep = new Set(variants.map((v) => v.id).filter(Boolean));
      for (const cv of current.variants) if (!keep.has(cv.id)) await tx.variant.update({ where: { id: cv.id }, data: { active: false } });
      await audit(tx, req.user.companyId, req.user.id, 'produto.editar', 'Product', id);
      return tx.product.findUnique({ where: { id }, include: { variants: true } });
    });
  });

  // ---------------- Estoque ----------------
  app.get('/stock', async (req) => {
    const q = req.query as { storeId?: string; low?: string; q?: string; categoryId?: string };
    if (req.user.storeId) q.storeId = req.user.storeId;
    const variants = await prisma.variant.findMany({
      where: {
        active: true,
        product: {
          ...(q.storeId ? soldInStore(q.storeId) : {}),
          companyId: req.user.companyId,
          active: true,
          ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
          ...(q.categoryId ? { categoryId: q.categoryId } : {}),
        },
      },
      include: { product: { select: { name: true, brand: true, categoryId: true, category: { select: { name: true } } } }, balances: q.storeId ? { where: { storeId: q.storeId } } : true },
      orderBy: { product: { name: 'asc' } },
      take: 1000,
    });
    const showCost = can(req.user, 'custo:ver');
    const rows = variants.map((v) => {
      const quantity = v.balances.reduce((a, b) => a + b.quantity, 0);
      const reserved = v.balances.reduce((a, b) => a + b.reserved, 0);
      return {
        variantId: v.id,
        name: v.product.name,
        brand: v.product.brand,
        categoryId: v.product.categoryId,
        category: v.product.category?.name ?? null,
        color: v.color,
        size: v.size,
        sku: v.sku,
        barcode: v.barcode,
        quantity,
        reserved,
        minStock: v.minStock,
        low: quantity <= v.minStock,
        priceCents: v.priceCents,
        ...(showCost ? { avgCostCents: v.avgCostCents, valueCents: Math.max(0, quantity) * v.avgCostCents } : {}),
      };
    });
    return q.low ? rows.filter((r) => r.low) : rows;
  });

  app.get('/stock/movements', async (req) => {
    const q = req.query as { variantId?: string; limit?: string };
    return prisma.stockMovement.findMany({
      where: { companyId: req.user.companyId, ...(q.variantId ? { variantId: q.variantId } : {}) },
      include: { variant: { select: { sku: true, color: true, size: true, product: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(q.limit) || 200, 1000),
    });
  });

  /**
   * Define o estoque mínimo de uma ou várias variações de uma vez:
   * pelos IDs escolhidos na tela ou por categoria inteira.
   */
  app.post('/stock/min', { preHandler: guard('estoque:ajustar') }, async (req) => {
    const body = parse(minStockInput, req.body);
    if (!body.variantIds?.length && !body.categoryId) throw badRequest('Escolha os itens ou uma categoria');
    const where = {
      active: true,
      product: { companyId: req.user.companyId, ...(body.categoryId ? { categoryId: body.categoryId } : {}) },
      ...(body.variantIds?.length ? { id: { in: body.variantIds } } : {}),
    };
    const { count } = await prisma.variant.updateMany({ where, data: { minStock: body.minStock } });
    await audit(prisma, req.user.companyId, req.user.id, 'estoque.minimo', 'Variant', body.categoryId ?? undefined, { ...body, count });
    return { updated: count };
  });

  app.post('/stock/adjust', { preHandler: guard('estoque:ajustar') }, async (req) => {
    const body = parse(adjustInput, req.body);
    return prisma.$transaction(async (tx) => {
      const variant = await tx.variant.findFirst({ where: { id: body.variantId, product: { companyId: req.user.companyId } } });
      const store = await tx.store.findFirst({ where: { id: body.storeId, companyId: req.user.companyId } });
      if (!variant || !store) throw notFound('Produto ou loja');
      let delta = body.quantity;
      if (body.type === 'INVENTARIO') {
        const bal = await tx.stockBalance.findUnique({ where: { variantId_storeId: { variantId: variant.id, storeId: store.id } } });
        delta = body.quantity - (bal?.quantity ?? 0);
      } else if (body.type === 'PERDA') {
        delta = -Math.abs(body.quantity);
      }
      const mv = await moveStock(tx, {
        companyId: req.user.companyId,
        storeId: store.id,
        variantId: variant.id,
        type: body.type,
        quantity: delta,
        unitCostCents: variant.avgCostCents,
        reason: body.reason,
        userId: req.user.id,
        allowNegative: false,
      });
      await audit(tx, req.user.companyId, req.user.id, 'estoque.ajustar', 'Variant', variant.id, { delta, type: body.type });
      return mv ?? { quantity: 0 };
    });
  });

  app.post('/stock/transfer', { preHandler: guard('estoque:ajustar') }, async (req) => {
    const body = parse(transferInput, req.body);
    if (body.fromStoreId === body.toStoreId) throw badRequest('Escolha lojas diferentes');
    return prisma.$transaction(async (tx) => {
      const stores = await tx.store.count({ where: { id: { in: [body.fromStoreId, body.toStoreId] }, companyId: req.user.companyId } });
      const variant = await tx.variant.findFirst({ where: { id: body.variantId, product: { companyId: req.user.companyId } } });
      if (stores !== 2 || !variant) throw notFound('Produto ou loja');
      const base = { companyId: req.user.companyId, variantId: variant.id, type: 'TRANSFERENCIA' as const, userId: req.user.id, unitCostCents: variant.avgCostCents };
      await moveStock(tx, { ...base, storeId: body.fromStoreId, quantity: -body.quantity, reason: 'Transferência (saída)', refType: 'store', refId: body.toStoreId });
      await moveStock(tx, { ...base, storeId: body.toStoreId, quantity: body.quantity, reason: 'Transferência (entrada)', refType: 'store', refId: body.fromStoreId });
      return { ok: true };
    });
  });
}

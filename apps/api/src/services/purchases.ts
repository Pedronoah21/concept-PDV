import { XMLParser } from 'fast-xml-parser';
import { isValidEAN13, onlyDigits, toCents } from '@concept/shared';
import { z } from 'zod';
import { audit, prisma } from '../db';
import { badRequest, conflict, notFound } from '../lib/errors';
import type { AuthUser } from '../lib/auth';
import { moveStock } from './stock';
import { landedCosts, weightedAverage } from './costing';

export { landedCosts, weightedAverage };

export const purchaseInput = z.object({
  storeId: z.string(),
  supplierId: z.string().nullish(),
  invoiceNumber: z.string().nullish(),
  accessKey: z.string().length(44).nullish(),
  issuedAt: z.string().datetime().nullish(),
  freightCents: z.number().int().nonnegative().default(0),
  otherCents: z.number().int().nonnegative().default(0),
  discountCents: z.number().int().nonnegative().default(0),
  notes: z.string().nullish(),
  items: z
    .array(z.object({ variantId: z.string(), quantity: z.number().int().positive(), unitCostCents: z.number().int().nonnegative() }))
    .min(1),
  /** Contas a pagar (parcelas da compra). Vazio = compra paga à vista fora do sistema. */
  payables: z.array(z.object({ dueDate: z.string(), amountCents: z.number().int().positive() })).default([]),
});
export type PurchaseInput = z.infer<typeof purchaseInput>;

export async function createPurchase(user: AuthUser, input: PurchaseInput) {
  return prisma.$transaction(async (tx) => {
    const store = await tx.store.findFirst({ where: { id: input.storeId, companyId: user.companyId } });
    if (!store) throw notFound('Loja');
    if (input.accessKey) {
      const dup = await tx.purchase.findFirst({ where: { companyId: user.companyId, accessKey: input.accessKey } });
      if (dup) throw conflict('Esta nota fiscal de compra já foi lançada', 'COMPRA_DUPLICADA');
    }
    const variants = await tx.variant.findMany({
      where: { id: { in: input.items.map((i) => i.variantId) }, product: { companyId: user.companyId } },
      include: { balances: true },
    });
    if (variants.length !== new Set(input.items.map((i) => i.variantId)).size) throw badRequest('Produto inválido na compra');

    const landed = landedCosts(input.items, input.freightCents, input.otherCents, input.discountCents);
    const productsCents = input.items.reduce((a, i) => a + i.quantity * i.unitCostCents, 0);
    const totalCents = productsCents + input.freightCents + input.otherCents - input.discountCents;
    if (input.payables.length) {
      const sum = input.payables.reduce((a, p) => a + p.amountCents, 0);
      if (sum !== totalCents) throw badRequest('A soma das parcelas a pagar deve ser igual ao total da compra');
    }

    const purchase = await tx.purchase.create({
      data: {
        companyId: user.companyId,
        storeId: store.id,
        supplierId: input.supplierId ?? null,
        invoiceNumber: input.invoiceNumber,
        accessKey: input.accessKey,
        issuedAt: input.issuedAt ? new Date(input.issuedAt) : null,
        productsCents,
        freightCents: input.freightCents,
        otherCents: input.otherCents,
        discountCents: input.discountCents,
        totalCents,
        notes: input.notes,
        userId: user.id,
        items: {
          create: input.items.map((i, k) => ({
            variantId: i.variantId,
            quantity: i.quantity,
            unitCostCents: i.unitCostCents,
            landedCostCents: landed[k],
          })),
        },
        payables: {
          create: input.payables.map((p, k) => ({
            companyId: user.companyId,
            description: `Compra ${input.invoiceNumber ?? ''} parcela ${k + 1}/${input.payables.length}`.trim(),
            amountCents: p.amountCents,
            dueDate: new Date(p.dueDate),
          })),
        },
      },
    });

    // Atualiza custo médio (considerando o saldo de todas as lojas) e dá entrada no estoque.
    const running = new Map(variants.map((v) => [v.id, { qty: v.balances.reduce((a, b) => a + b.quantity, 0), avg: v.avgCostCents }]));
    for (const [k, item] of input.items.entries()) {
      const cur = running.get(item.variantId)!;
      const avg = weightedAverage(cur.qty, cur.avg, item.quantity, landed[k]);
      running.set(item.variantId, { qty: cur.qty + item.quantity, avg });
      await tx.variant.update({ where: { id: item.variantId }, data: { avgCostCents: avg } });
      await moveStock(tx, {
        companyId: user.companyId,
        storeId: store.id,
        variantId: item.variantId,
        type: 'COMPRA',
        quantity: item.quantity,
        unitCostCents: landed[k],
        refType: 'purchase',
        refId: purchase.id,
        userId: user.id,
      });
    }
    await audit(tx, user.companyId, user.id, 'compra.lancar', 'Purchase', purchase.id, { totalCents });
    return purchase;
  });
}

// ---------------------------------------------------------------------------
// Importação do XML da NF-e do fornecedor: preenche a entrada automaticamente.
// ---------------------------------------------------------------------------
export interface ParsedNfeItem {
  supplierCode: string;
  barcode: string | null;
  description: string;
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  unit: string;
  quantity: number;
  fractional: boolean;
  unitCostCents: number;
  totalCents: number;
}

export interface ParsedNfe {
  accessKey: string | null;
  number: string | null;
  issuedAt: string | null;
  supplier: { document: string; name: string; tradeName: string | null };
  items: ParsedNfeItem[];
  freightCents: number;
  otherCents: number;
  discountCents: number;
  totalCents: number;
}

const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

export function parseNfeXml(xml: string): ParsedNfe {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, removeNSPrefix: true });
  const doc = parser.parse(xml);
  const nfe = doc?.nfeProc?.NFe ?? doc?.NFe;
  const inf = nfe?.infNFe;
  if (!inf) throw badRequest('Arquivo não é um XML de NF-e válido', 'XML_INVALIDO');
  const key = (doc?.nfeProc?.protNFe?.infProt?.chNFe as string) ?? (inf['@Id'] as string | undefined)?.replace(/^NFe/, '') ?? null;
  const emit = inf.emit ?? {};
  const tot = inf.total?.ICMSTot ?? {};
  const items = asArray(inf.det).map((d: any): ParsedNfeItem => {
    const p = d.prod;
    const ean = String(p.cEAN ?? '').trim();
    const q = Number(p.qCom);
    return {
      supplierCode: String(p.cProd),
      barcode: isValidEAN13(ean) || /^\d{8}$|^\d{12,14}$/.test(ean) ? ean : null,
      description: String(p.xProd),
      ncm: p.NCM ? String(p.NCM) : null,
      cest: p.CEST ? String(p.CEST) : null,
      cfop: p.CFOP ? String(p.CFOP) : null,
      unit: String(p.uCom ?? 'UN'),
      quantity: Math.max(1, Math.round(q)),
      fractional: !Number.isInteger(q),
      unitCostCents: toCents(Number(p.vUnCom)),
      totalCents: toCents(Number(p.vProd)),
    };
  });
  return {
    accessKey: key && key.length === 44 ? key : null,
    number: inf.ide?.nNF ? String(inf.ide.nNF) : null,
    issuedAt: inf.ide?.dhEmi ? new Date(String(inf.ide.dhEmi)).toISOString() : null,
    supplier: {
      document: onlyDigits(String(emit.CNPJ ?? emit.CPF ?? '')),
      name: String(emit.xNome ?? ''),
      tradeName: emit.xFant ? String(emit.xFant) : null,
    },
    items,
    freightCents: toCents(Number(tot.vFrete ?? 0)),
    otherCents: toCents(Number(tot.vOutro ?? 0)) + toCents(Number(tot.vIPI ?? 0)) + toCents(Number(tot.vST ?? 0)),
    discountCents: toCents(Number(tot.vDesc ?? 0)),
    totalCents: toCents(Number(tot.vNF ?? 0)),
  };
}

/** Lê o XML e casa cada item com um produto já cadastrado (pelo código de barras). */
export async function previewNfeImport(companyId: string, xml: string) {
  const parsed = parseNfeXml(xml);
  const supplier = parsed.supplier.document
    ? await prisma.supplier.findFirst({ where: { companyId, document: parsed.supplier.document } })
    : null;
  const barcodes = parsed.items.map((i) => i.barcode).filter(Boolean) as string[];
  const matches = barcodes.length
    ? await prisma.variant.findMany({
        where: { barcode: { in: barcodes }, product: { companyId } },
        include: { product: { select: { name: true } } },
      })
    : [];
  const byBarcode = new Map(matches.map((v) => [v.barcode, v]));
  const already = parsed.accessKey
    ? await prisma.purchase.findFirst({ where: { companyId, accessKey: parsed.accessKey }, select: { id: true } })
    : null;
  return {
    ...parsed,
    alreadyImported: !!already,
    supplierId: supplier?.id ?? null,
    items: parsed.items.map((i) => {
      const v = i.barcode ? byBarcode.get(i.barcode) : undefined;
      return { ...i, variantId: v?.id ?? null, matchedName: v ? v.product.name : null };
    }),
  };
}

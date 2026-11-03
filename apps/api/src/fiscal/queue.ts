import type { Company, FiscalModel } from '@prisma/client';
import { prisma, type Tx, Prisma } from '../db';
import { buildNfce, buildNfe, type Destination } from './payload';
import { getProvider } from './providers';
import type { FiscalResult } from './types';

const MAX_ATTEMPTS = 12;

export interface FiscalOptions {
  presenca?: '1' | '4';
  dest?: Destination;
}

/** Coloca a emissão na fila. Feito dentro da transação da venda: nunca há venda sem pedido de nota. */
export async function enqueueFiscal(tx: Tx, company: Company, saleId: string, saleNumber: number, model: FiscalModel, opts: FiscalOptions = {}) {
  const count = await tx.fiscalDocument.count({ where: { saleId } });
  const ref = `${company.slug}-${model.toLowerCase()}-${saleNumber}${count ? '-' + (count + 1) : ''}`;
  return tx.fiscalDocument.create({
    data: { companyId: company.id, saleId, model, ref, payload: opts as Prisma.InputJsonValue },
  });
}

function applyResult(r: FiscalResult) {
  return {
    status: r.status === 'ERRO' && r.retry ? ('PENDENTE' as const) : r.status,
    number: r.number,
    serie: r.serie,
    accessKey: r.accessKey,
    protocol: r.protocol,
    xmlUrl: r.xmlUrl,
    danfeUrl: r.danfeUrl,
    qrcodeUrl: r.qrcodeUrl,
    consultUrl: r.consultUrl,
    message: r.message,
  };
}

/** Processa um documento da fila. Retorna o documento atualizado. */
export async function processDocument(id: string) {
  // Reivindica o documento (evita processar duas vezes com dois servidores).
  const claimed = await prisma.fiscalDocument.updateMany({
    where: { id, status: { in: ['PENDENTE', 'PROCESSANDO', 'ERRO', 'REJEITADA'] } },
    data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 60_000) },
  });
  if (!claimed.count) return prisma.fiscalDocument.findUnique({ where: { id } });
  const doc = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id } });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: doc.companyId } });
  const provider = getProvider(company.fiscalProvider);
  const cfg = { token: company.fiscalToken, env: company.fiscalEnv };

  let result: FiscalResult;
  try {
    if (doc.status === 'PROCESSANDO') {
      result = await provider.status(doc.model, doc.ref, cfg);
    } else {
      const sale = await prisma.sale.findUniqueOrThrow({
        where: { id: doc.saleId },
        include: { items: { include: { variant: { include: { product: true } } } }, payments: true, customer: true },
      });
      const opts = (doc.payload ?? {}) as FiscalOptions;
      const payload = doc.model === 'NFCE' ? buildNfce(company, sale, opts.presenca ?? '1', opts.dest) : buildNfe(company, sale, opts.dest ?? {});
      result = await provider.issue(doc.model, doc.ref, payload, cfg);
    }
  } catch (err: any) {
    result = { status: 'ERRO', message: `Falha de comunicação: ${err?.message ?? err}`, retry: true };
  }

  const attempts = doc.attempts;
  const giveUp = result.retry && attempts >= MAX_ATTEMPTS;
  // Espera crescente: 30s, 1min, 2min, 4min... até 1h.
  const delay = Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return prisma.fiscalDocument.update({
    where: { id },
    data: {
      ...applyResult(result),
      ...(giveUp ? { status: 'ERRO' as const, message: `${result.message ?? ''} (tentativas esgotadas)`.trim() } : {}),
      nextAttemptAt: new Date(Date.now() + (result.status === 'PROCESSANDO' ? 5_000 : delay)),
    },
  });
}

let running = false;

/** Varre a fila: chamado periodicamente pelo servidor. */
export async function processFiscalQueue(limit = 10) {
  if (running) return 0;
  running = true;
  try {
    const docs = await prisma.fiscalDocument.findMany({
      where: { status: { in: ['PENDENTE', 'PROCESSANDO'] }, nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    for (const d of docs) await processDocument(d.id);
    return docs.length;
  } finally {
    running = false;
  }
}

export async function cancelFiscal(companyId: string, id: string, reason: string) {
  const doc = await prisma.fiscalDocument.findFirst({ where: { id, companyId } });
  if (!doc) return null;
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const r = await getProvider(company.fiscalProvider).cancel(doc.model, doc.ref, reason, { token: company.fiscalToken, env: company.fiscalEnv });
  return prisma.fiscalDocument.update({ where: { id }, data: { status: r.status === 'CANCELADA' ? 'CANCELADA' : doc.status, message: r.message } });
}

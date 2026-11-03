/**
 * Teste ponta a ponta das regras de negócio contra um PostgreSQL real.
 * Cria uma empresa isolada a cada execução. Rode com `pnpm --filter @concept/api test`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { prisma } from './db';
import { processFiscalQueue } from './fiscal/queue';

let app: FastifyInstance;
const slug = 'teste-' + randomUUID().slice(0, 8);
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

async function call(who: string, method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url: '/api' + url, payload: payload as never, headers: cookies[who] ? { cookie: cookies[who] } : {} });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function login(who: string, email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'senha-forte-1', companySlug: slug } });
  assert.equal(res.statusCode, 200, res.body);
  const c = res.cookies.find((x) => x.name === 'cpdv_session')!;
  assert.ok(c.httpOnly, 'cookie de sessão deve ser HttpOnly');
  cookies[who] = `cpdv_session=${c.value}`;
}

function sale(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    registerId: ids.register,
    cashSessionId: ids.session,
    items: [{ variantId: ids.vM, quantity: 2, unitPriceCents: 5000, discountCents: 0 }],
    discountCents: 0,
    payments: [{ method: 'DINHEIRO', amountCents: 10000 }],
    createdAt: new Date().toISOString(),
    issueFiscal: true,
    ...over,
  };
}

const stockOf = async (variantId: string) =>
  (await prisma.stockBalance.findUnique({ where: { variantId_storeId: { variantId, storeId: ids.store } } }))!;

before(async () => {
  app = await buildApp();
  const company = await prisma.company.create({
    data: { slug, cnpj: String(Date.now()).padStart(14, '0').slice(-14), legalName: 'Teste Ltda', tradeName: 'Loja Teste', uf: 'AM', city: 'Manaus' },
  });
  ids.company = company.id;
  const store = await prisma.store.create({ data: { companyId: company.id, name: 'Centro', isOnline: true } });
  ids.store = store.id;
  ids.register = (await prisma.register.create({ data: { storeId: store.id, code: 'CX01', name: 'Caixa 01' } })).id;
  const hash = await bcrypt.hash('senha-forte-1', 4);
  for (const [role, email, pct] of [['ADMIN', 'admin', 100], ['GERENTE', 'gerente', 30], ['CAIXA', 'caixa', 5]] as const) {
    await prisma.user.create({ data: { companyId: company.id, name: role, email: `${email}@${slug}.com`, passwordHash: hash, role, maxDiscountPct: pct } });
  }
  await login('admin', `admin@${slug}.com`);
  await login('caixa', `caixa@${slug}.com`);
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('fluxo completo do Concept PDV', () => {
  it('cadastra produto com grade e saldo inicial', async () => {
    const r = await call('admin', 'POST', '/products', {
      name: 'Camiseta Teste',
      ncm: '61091000',
      storeId: ids.store,
      variants: [
        { color: 'Preta', size: 'M', priceCents: 5000, initialStock: 10, initialCostCents: 2000 },
        { color: 'Preta', size: 'G', priceCents: 5000, initialStock: 1, initialCostCents: 2000 },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ids.vM = r.body.variants.find((v: any) => v.size === 'M').id;
    ids.vG = r.body.variants.find((v: any) => v.size === 'G').id;
    assert.match(r.body.variants[0].barcode, /^2\d{12}$/, 'gera EAN interno');
    assert.equal((await stockOf(ids.vM)).quantity, 10);
  });

  it('operador de caixa não pode ajustar estoque', async () => {
    const r = await call('caixa', 'POST', '/stock/adjust', { variantId: ids.vM, storeId: ids.store, type: 'AJUSTE', quantity: 5, reason: 'teste' });
    assert.equal(r.status, 403);
  });

  it('entrada de compra rateia frete e recalcula custo médio', async () => {
    const r = await call('admin', 'POST', '/purchases', {
      storeId: ids.store,
      items: [{ variantId: ids.vM, quantity: 10, unitCostCents: 2800 }],
      freightCents: 2000,
      payables: [{ dueDate: new Date().toISOString(), amountCents: 30000 }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const v = await prisma.variant.findUniqueOrThrow({ where: { id: ids.vM } });
    // (10 × 20,00 + 10 × 30,00) / 20 = 25,00
    assert.equal(v.avgCostCents, 2500);
    assert.equal((await stockOf(ids.vM)).quantity, 20);
  });

  it('abre o caixa e não permite abrir duas vezes', async () => {
    const r = await call('caixa', 'POST', '/cash/open', { registerId: ids.register, openingCents: 10000 });
    assert.equal(r.status, 200);
    ids.session = r.body.id;
    assert.equal((await call('caixa', 'POST', '/cash/open', { registerId: ids.register, openingCents: 0 })).status, 409);
  });

  it('vende com troco, baixa estoque e emite NFC-e (simulador)', async () => {
    const s = sale({ payments: [{ method: 'DINHEIRO', amountCents: 15000 }], cpfNaNota: '529.982.247-25' });
    const r = await call('caixa', 'POST', '/sales', s);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.totalCents, 10000);
    assert.equal(r.body.changeCents, 5000);
    assert.equal(r.body.costCents, 5000);
    assert.equal(r.body.fiscalDocuments[0].status, 'AUTORIZADA');
    assert.equal(r.body.fiscalDocuments[0].accessKey.length, 44);
    assert.equal((await stockOf(ids.vM)).quantity, 18);
    ids.sale1 = s.id;

    // Reenvio da mesma venda (internet caiu na resposta): não duplica
    const again = await call('caixa', 'POST', '/sales', s);
    assert.equal(again.status, 200);
    assert.equal(again.body.number, r.body.number);
    assert.equal((await stockOf(ids.vM)).quantity, 18);
  });

  it('recusa troco em PIX e pagamento insuficiente', async () => {
    assert.equal((await call('caixa', 'POST', '/sales', sale({ payments: [{ method: 'PIX', amountCents: 12000 }] }))).status, 400);
    assert.equal((await call('caixa', 'POST', '/sales', sale({ payments: [{ method: 'DINHEIRO', amountCents: 9000 }] }))).status, 400);
  });

  it('desconto acima do limite exige gerente; com autorização passa', async () => {
    const s = sale({ discountCents: 2000, payments: [{ method: 'PIX', amountCents: 8000 }] });
    const denied = await call('caixa', 'POST', '/sales', s);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'AUTORIZACAO_NECESSARIA');

    // Baixar o preço no caixa também conta como desconto
    const cheaper = sale({ items: [{ variantId: ids.vM, quantity: 1, unitPriceCents: 1000, discountCents: 0 }], payments: [{ method: 'PIX', amountCents: 1000 }] });
    assert.equal((await call('caixa', 'POST', '/sales', cheaper)).status, 403);

    const wrong = await call('caixa', 'POST', '/auth/approve', { email: `caixa@${slug}.com`, password: 'senha-forte-1', scope: 'desconto' });
    assert.equal(wrong.status, 403, 'operador não autoriza a si mesmo');
    const ok = await call('caixa', 'POST', '/auth/approve', { email: `gerente@${slug}.com`, password: 'senha-forte-1', scope: 'desconto', maxPct: 20 });
    assert.equal(ok.status, 200);
    const approved = await call('caixa', 'POST', '/sales', { ...s, approvalToken: ok.body.token });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
  });

  it('venda offline chega pela fila: desconto alto vira revisão, não erro', async () => {
    const s = sale({ offline: true, discountCents: 3000, payments: [{ method: 'DINHEIRO', amountCents: 7000 }], createdAt: new Date(Date.now() - 3_600_000).toISOString() });
    const r = await call('caixa', 'POST', '/sync/sales', { sales: [s, s, { id: 'x' }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].ok, true);
    assert.equal(r.body.results[1].duplicate, true);
    assert.equal(r.body.results[2].ok, false);
    assert.equal(r.body.results[2].permanent, true);
    const saved = await prisma.sale.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(saved.needsReview, true);
    assert.equal(saved.offline, true);
  });

  it('crediário exige cliente, respeita limite e gera parcelas', async () => {
    const c = await call('admin', 'POST', '/customers', { name: 'Maria Teste', document: '529.982.247-25', creditLimitCents: 15000 });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    ids.customer = c.body.id;
    assert.equal((await call('caixa', 'POST', '/sales', sale({ payments: [{ method: 'CREDIARIO', amountCents: 10000, installments: 3 }] }))).status, 400);
    const r = await call('caixa', 'POST', '/sales', sale({ customerId: ids.customer, payments: [{ method: 'CREDIARIO', amountCents: 10000, installments: 3 }] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.installments.map((i: any) => i.amountCents).sort((a: number, b: number) => b - a), [3334, 3333, 3333]);
    const over = await call('caixa', 'POST', '/sales', sale({ customerId: ids.customer, payments: [{ method: 'CREDIARIO', amountCents: 10000 }] }));
    assert.equal(over.body.code, 'LIMITE_EXCEDIDO');
    ids.installment = r.body.installments.find((i: any) => i.number === 1).id;
    const paid = await call('caixa', 'POST', `/installments/${ids.installment}/pay`, { amountCents: 3334, method: 'PIX', cashSessionId: ids.session });
    assert.equal(paid.body.status, 'PAGA');
  });

  it('devolução gera vale-troca que paga outra venda', async () => {
    const detail = await call('caixa', 'GET', `/sales/${ids.sale1}`);
    const item = detail.body.items[0];
    const r = await call('caixa', 'POST', `/sales/${ids.sale1}/returns`, { items: [{ saleItemId: item.id, quantity: 1 }], refundMethod: 'VALE_TROCA' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.totalCents, 5000);
    const before = (await stockOf(ids.vM)).quantity;
    const tooMany = await call('caixa', 'POST', `/sales/${ids.sale1}/returns`, { items: [{ saleItemId: item.id, quantity: 2 }], refundMethod: 'VALE_TROCA' });
    assert.equal(tooMany.status, 400);
    const use = await call('caixa', 'POST', '/sales', sale({ items: [{ variantId: ids.vM, quantity: 1, unitPriceCents: 5000, discountCents: 0 }], payments: [{ method: 'VALE_TROCA', amountCents: 5000, voucherCode: r.body.voucherCode }] }));
    assert.equal(use.status, 201, JSON.stringify(use.body));
    const reuse = await call('caixa', 'POST', '/sales', sale({ payments: [{ method: 'VALE_TROCA', amountCents: 10000, voucherCode: r.body.voucherCode }] }));
    assert.equal(reuse.body.code, 'VALE_SEM_SALDO');
    assert.equal((await stockOf(ids.vM)).quantity, before - 1);
  });

  it('cancelamento devolve estoque e cancela a NFC-e; exige gerente', async () => {
    const s = sale();
    await call('caixa', 'POST', '/sales', s);
    const before = (await stockOf(ids.vM)).quantity;
    assert.equal((await call('caixa', 'POST', `/sales/${s.id}/cancel`, { reason: 'Cliente desistiu da compra' })).status, 403);
    const r = await call('admin', 'POST', `/sales/${s.id}/cancel`, { reason: 'Cliente desistiu da compra' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'CANCELADA');
    assert.equal(r.body.fiscalDocuments[0].status, 'CANCELADA');
    assert.equal((await stockOf(ids.vM)).quantity, before + 2);
  });

  it('fechamento cego: operador não vê o esperado; diferença é calculada', async () => {
    const view = await call('caixa', 'GET', `/cash/${ids.session}`);
    assert.equal(view.body.expected, null);
    await call('caixa', 'POST', `/cash/${ids.session}/movements`, { type: 'SANGRIA', amountCents: 5000, reason: 'cofre' });
    const mgr = await call('admin', 'GET', `/cash/${ids.session}`);
    const expectedCash = mgr.body.expected.DINHEIRO;
    // fundo 100 + venda 1 (100) + venda offline (70) - sangria 50 = 220,00 (vendas canceladas não contam)
    assert.equal(expectedCash, 22000);
    const closed = await call('caixa', 'POST', `/cash/${ids.session}/close`, { counted: { DINHEIRO: expectedCash - 100, PIX: mgr.body.expected.PIX } });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.differenceCents, -100);
    assert.equal((await call('caixa', 'POST', '/sales', sale())).body.code, 'CAIXA_FECHADO');
  });

  it('loja online: reserva estoque, não vende além do disponível e fatura com nota', async () => {
    const cat = await call('anon', 'GET', `/public/${slug}/catalog`);
    assert.equal(cat.status, 200);
    const g = cat.body.products[0].variants.find((v: any) => v.id === ids.vG);
    assert.equal(g.available, 1);
    const order = { customer: { name: 'Ana Online', email: 'ana@exemplo.com', phone: '92999990000', document: '52998224725' }, delivery: 'ENTREGA', paymentMethod: 'PIX', address: { zip: '01001000', street: 'Praça da Sé', number: '1', district: 'Sé', city: 'São Paulo', uf: 'SP' }, items: [{ variantId: ids.vG, quantity: 1 }] };
    const o = await call('anon', 'POST', `/public/${slug}/orders`, order);
    assert.equal(o.status, 201, JSON.stringify(o.body));
    assert.equal((await stockOf(ids.vG)).reserved, 1);
    const second = await call('anon', 'POST', `/public/${slug}/orders`, order);
    assert.equal(second.body.code, 'ESTOQUE_INSUFICIENTE');

    assert.equal((await call('admin', 'POST', `/orders/${o.body.id}/invoice`)).status, 400, 'não fatura antes de pago');
    await call('admin', 'PATCH', `/orders/${o.body.id}`, { status: 'PAGO', shippingCents: 2500 });
    const inv = await call('admin', 'POST', `/orders/${o.body.id}/invoice`);
    assert.equal(inv.status, 200, JSON.stringify(inv.body));
    const bal = await stockOf(ids.vG);
    assert.equal(bal.reserved, 0);
    assert.equal(bal.quantity, 0);
    const doc = await prisma.fiscalDocument.findFirstOrThrow({ where: { saleId: inv.body.saleId } });
    assert.equal(doc.model, 'NFE', 'outro estado usa NF-e');
    assert.equal(doc.status, 'AUTORIZADA');
    const s = await prisma.sale.findUniqueOrThrow({ where: { id: inv.body.saleId }, include: { payments: true } });
    assert.equal(s.shippingCents, 2500);
    assert.equal(s.payments[0].amountCents, 7500);
  });

  it('fila fiscal reprocessa nota pendente', async () => {
    const pending = await prisma.fiscalDocument.updateMany({ where: { companyId: ids.company, status: 'AUTORIZADA', model: 'NFCE' }, data: { status: 'PENDENTE', nextAttemptAt: new Date(0) } });
    assert.ok(pending.count > 0);
    await processFiscalQueue(50);
    const left = await prisma.fiscalDocument.count({ where: { companyId: ids.company, status: 'PENDENTE' } });
    assert.equal(left, 0);
  });

  it('relatórios somam só vendas concluídas', async () => {
    const r = await call('admin', 'GET', '/reports/summary');
    assert.equal(r.status, 200);
    const sum = await prisma.sale.aggregate({ where: { companyId: ids.company, status: 'CONCLUIDA' }, _sum: { totalCents: true } });
    assert.equal(r.body.revenueCents, sum._sum.totalCents);
    assert.equal(r.body.alerts.needsReview, 1);
    assert.equal((await call('caixa', 'GET', '/reports/summary')).status, 403);
    const abc = await call('admin', 'GET', '/reports/abc');
    assert.equal(abc.body[0].class, 'A');
    assert.equal((await call('admin', 'GET', '/reports/stale')).status, 200);
  });

  it('estoque nunca diverge do livro de movimentos', async () => {
    for (const v of [ids.vM, ids.vG]) {
      const sum = await prisma.stockMovement.aggregate({ where: { variantId: v, storeId: ids.store }, _sum: { quantity: true } });
      assert.equal((await stockOf(v)).quantity, sum._sum.quantity);
    }
  });

  it('bloqueia o usuário após 5 senhas erradas', async () => {
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `gerente@${slug}.com`, password: 'errada', companySlug: slug } });
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `gerente@${slug}.com`, password: 'senha-forte-1', companySlug: slug } });
    assert.equal(r.statusCode, 423);
  });
});

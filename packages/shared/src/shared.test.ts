import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate,
  buildCashReport,
  encodeCP850,
  formatBRL,
  receiptToText,
  buildReceipt,
  checkPayments,
  computeCart,
  EscPos,
  internalEAN13,
  isValidCNPJ,
  isValidCPF,
  isValidEAN13,
  splitInstallments,
  toCents,
} from './index';

describe('dinheiro', () => {
  it('converte formatos brasileiros para centavos', () => {
    assert.equal(toCents('1.234,56'), 123456);
    assert.equal(toCents('R$ 10,1'), 1010);
    assert.equal(toCents(0.1 + 0.2), 30);
  });
  it('rateia sem perder centavos', () => {
    const parts = allocate(100, [1, 1, 1]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 100);
    assert.deepEqual(parts, [34, 33, 33]);
  });
  it('divide parcelas com a sobra na primeira', () => {
    assert.deepEqual(splitInstallments(1000, 3), [334, 333, 333]);
  });
});

describe('carrinho', () => {
  it('rateia o desconto da venda pelos itens', () => {
    const t = computeCart(
      [
        { quantity: 2, unitPriceCents: 5000, discountCents: 0 },
        { quantity: 1, unitPriceCents: 10000, discountCents: 1000 },
      ],
      1900,
    );
    assert.equal(t.grossCents, 20000);
    assert.equal(t.totalCents, 17100);
    assert.equal(t.lineDiscounts.reduce((a, b) => a + b, 0), 2900);
  });
  it('recusa desconto maior que a venda', () => {
    assert.throws(() => computeCart([{ quantity: 1, unitPriceCents: 100, discountCents: 0 }], 200));
  });
  it('troco só sai do dinheiro', () => {
    assert.equal(checkPayments(1000, [{ method: 'DINHEIRO', amountCents: 2000 }]).changeCents, 1000);
    assert.throws(() => checkPayments(1000, [{ method: 'PIX', amountCents: 2000 }]));
    assert.throws(() => checkPayments(1000, [{ method: 'PIX', amountCents: 500 }]));
  });
});

describe('validadores', () => {
  it('CPF, CNPJ e EAN-13', () => {
    assert.equal(isValidCPF('529.982.247-25'), true);
    assert.equal(isValidCPF('111.111.111-11'), false);
    assert.equal(isValidCNPJ('11.222.333/0001-81'), true);
    assert.equal(isValidEAN13('7891000315507'), true);
    assert.equal(isValidEAN13(internalEAN13(42)), true);
  });
});

describe('cupom', () => {
  it('gera bytes ESC/POS com corte', () => {
    const lines = buildReceipt({
      company: { name: 'Loja Ação', cnpj: '11222333000181' },
      saleNumber: '1',
      date: new Date().toISOString(),
      items: [{ code: '1', description: 'Camiseta', quantity: 1, unitPriceCents: 5000, discountCents: 0, totalCents: 5000 }],
      grossCents: 5000,
      discountCents: 0,
      totalCents: 5000,
      payments: [{ method: 'DINHEIRO', amountCents: 5000 }],
      changeCents: 0,
    });
    const bytes = new EscPos().lines(lines).cut().build();
    assert.equal(bytes[0], 0x1b);
    assert.deepEqual(Array.from(bytes.slice(-4)), [0x1d, 0x56, 0x42, 0x00]);
    assert.ok(Array.from(bytes).includes(0xc6)); // "ã" de "Ação" em PC850
  });
});

describe('vias e fechamento', () => {
  const venda = {
    company: { name: 'Loja', cnpj: '11222333000181' },
    saleNumber: '7',
    date: new Date().toISOString(),
    customer: { name: 'Maria', document: '52998224725' },
    items: [{ code: '1', description: 'Camiseta', quantity: 1, unitPriceCents: 5000, discountCents: 0, totalCents: 5000 }],
    grossCents: 5000,
    discountCents: 0,
    totalCents: 5000,
    payments: [{ method: 'CREDIARIO' as const, amountCents: 5000, installments: 2 }],
    changeCents: 0,
    footer: 'Volte sempre',
  };
  it('marca a via e põe assinatura do crediário só na via da loja', () => {
    const cliente = receiptToText(buildReceipt({ ...venda, copy: 'CLIENTE' }));
    const loja = receiptToText(buildReceipt({ ...venda, copy: 'LOJA' }));
    assert.match(cliente, /VIA DO CLIENTE/);
    assert.match(loja, /VIA DA LOJA/);
    assert.doesNotMatch(cliente, /Assinatura/);
    assert.match(loja, /Assinatura Maria/);
    assert.match(cliente, /Volte sempre/);
  });
  it('relatório de fechamento cabe na bobina e mostra a diferença', () => {
    const data = {
      company: 'Loja',
      register: 'Centro — Caixa 01',
      openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      openedBy: 'Ana',
      closedBy: 'Ana',
      openingCents: 10000,
      salesCount: 3,
      salesTotalCents: 25000,
      canceledCount: 1,
      salesByMethod: { DINHEIRO: 15000, PIX: 10000 },
      changeCents: 2000,
      movements: [{ type: 'SANGRIA', amountCents: 5000, reason: 'cofre', at: new Date().toISOString() }],
      expected: { DINHEIRO: 18000, PIX: 10000 },
      counted: { DINHEIRO: 17900, PIX: 10000 },
      differenceCents: -100,
    };
    for (const width of [48, 32]) {
      const text = receiptToText(buildCashReport(data, width), width);
      assert.match(text, /FECHAMENTO DE CAIXA/);
      assert.match(text, /FALTA DE R\$\s1,00/);
      assert.match(text, /Sangria/);
      for (const line of text.split('\n')) assert.ok(line.length <= width, `linha maior que ${width}: "${line}"`);
    }
  });
});

describe('codificação para a térmica', () => {
  it('não vira "?" em valores em reais nem no travessão', () => {
    const bytes = encodeCP850(`${formatBRL(100)} — ok`);
    assert.ok(!bytes.includes(0x3f), 'sem ponto de interrogação');
    assert.deepEqual(bytes.slice(0, 3), [0x52, 0x24, 0x20]); // "R$ "
  });
});

describe('quebra de linha do cupom', () => {
  it('não corta palavras e respeita a largura', async () => {
    const { wrap } = await import('./receipt');
    const lines = wrap('Trocas em até 30 dias com a etiqueta. Obrigado pela preferência!', 32);
    assert.ok(lines.every((l) => l.length <= 32));
    assert.ok(lines.join(' ').includes('Obrigado pela'), 'palavra inteira');
    const key = '1187 9029 8180 8013 0186 2596 2871 0807 9953 8605 4485';
    assert.ok(wrap(key, 48).every((l) => l.split(' ').every((b) => b.length === 4)), 'blocos da chave inteiros');
  });
});

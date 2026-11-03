import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate,
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

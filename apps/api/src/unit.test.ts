import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { landedCosts, weightedAverage } from './services/costing';
import { buildNfce, buildNfe } from './fiscal/payload';

describe('custo de entrada', () => {
  it('rateia frete e desconto proporcionalmente', () => {
    const c = landedCosts(
      [
        { quantity: 10, unitCostCents: 1000 },
        { quantity: 5, unitCostCents: 4000 },
      ],
      3000,
      0,
      1000,
    );
    // 10.000 + 20.000 = 30.000; +3.000 -1.000 => 32.000 rateado 1/3 e 2/3
    assert.equal(c[0], 1067);
    assert.equal(c[1], 4267);
  });
  it('custo médio ponderado', () => {
    assert.equal(weightedAverage(10, 2000, 10, 3000), 2500);
    assert.equal(weightedAverage(-2, 2000, 5, 3000), 3000);
  });
});

const company: any = { id: 'c', slug: 'demo', cnpj: '11222333000181', crt: 1, uf: 'AM' };
const product: any = { ncm: '61091000', cfop: '5102', unit: 'UN', origin: 0, csosn: '102', cstIcms: null, icmsRate: 0, cstPis: '49', cstCofins: '49' };
const sale: any = {
  grossCents: 20000,
  discountCents: 1000,
  totalCents: 19000,
  changeCents: 1000,
  shippingCents: 0,
  cpfNaNota: '52998224725',
  customer: null,
  items: [
    { description: 'Camiseta Preta M', quantity: 2, unitPriceCents: 10000, discountCents: 1000, totalCents: 19000, variant: { sku: '00001-1', barcode: '7891000315507', product } },
  ],
  payments: [
    { method: 'DINHEIRO', amountCents: 10000 },
    { method: 'PIX', amountCents: 10000 },
  ],
};

describe('NFC-e', () => {
  it('monta itens, pagamentos e troco', () => {
    const p: any = buildNfce(company, sale);
    assert.equal(p.cnpj_emitente, '11222333000181');
    assert.equal(p.valor_total, '190.00');
    assert.equal(p.valor_troco, '10.00');
    assert.equal(p.cpf_destinatario, '52998224725');
    assert.equal(p.items[0].valor_bruto, '200.00');
    assert.equal(p.items[0].valor_desconto, '10.00');
    assert.equal(p.items[0].icms_situacao_tributaria, '102');
    assert.equal(p.items[0].codigo_barras_comercial, '7891000315507');
    assert.deepEqual(p.formas_pagamento.map((f: any) => f.forma_pagamento), ['01', '17']);
    assert.equal(p.formas_pagamento[1].tipo_integracao, '2');
    assert.match(p.data_emissao, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
  it('regime normal calcula ICMS', () => {
    const p: any = buildNfce({ ...company, crt: 3 }, { ...sale, items: [{ ...sale.items[0], variant: { ...sale.items[0].variant, product: { ...product, cstIcms: '00', icmsRate: 2000 } } }] });
    assert.equal(p.items[0].icms_aliquota, '20.00');
    assert.equal(p.items[0].icms_valor, '38.00');
  });
});

describe('NF-e', () => {
  it('venda para outro estado usa CFOP 6108 e destino interestadual', () => {
    const p: any = buildNfe(company, { ...sale, shippingCents: 1500 }, { name: 'Ana', document: '52998224725', uf: 'SP', zip: '01001-000', street: 'Praça da Sé', number: '1', district: 'Sé', city: 'São Paulo' });
    assert.equal(p.local_destino, '2');
    assert.equal(p.items[0].cfop, '6108');
    assert.equal(p.valor_total, '205.00');
    assert.equal(p.items[0].valor_frete, '15.00');
    assert.equal(p.cep_destinatario, '01001000');
  });
  it('exige documento do destinatário', () => {
    assert.throws(() => buildNfe(company, sale, { name: 'Sem doc' }));
  });
});

describe('importação do XML da NF-e do fornecedor', async () => {
  const { readFileSync } = await import('node:fs');
  const { parseNfeXml } = await import('./services/purchases');
  it('lê fornecedor, itens, frete e desconto', () => {
    const n = parseNfeXml(readFileSync(new URL('../test/fixtures/nfe-fornecedor.xml', import.meta.url), 'utf8'));
    assert.equal(n.accessKey, '13261111222333000181550010000012341000012345');
    assert.equal(n.number, '1234');
    assert.equal(n.supplier.document, '11222333000181');
    assert.equal(n.items.length, 2);
    assert.equal(n.items[0].barcode, '7891000315507');
    assert.equal(n.items[0].quantity, 10);
    assert.equal(n.items[0].unitCostCents, 2500);
    assert.equal(n.items[1].barcode, null, 'SEM GTIN vira nulo');
    assert.equal(n.items[1].unitCostCents, 1850);
    assert.equal(n.freightCents, 2000);
    assert.equal(n.discountCents, 250);
    assert.equal(n.totalCents, 36000);
  });
  it('recusa arquivo que não é NF-e', () => {
    assert.throws(() => parseNfeXml('<html><body>oi</body></html>'));
  });
});

import { allocate, FISCAL_PAYMENT_CODE, onlyDigits, type PaymentMethod } from '@concept/shared';
import type { Company, Customer, Product, Sale, SaleItem, SalePayment, Variant } from '@prisma/client';

/**
 * Monta os dados da NFC-e (modelo 65) e NF-e (modelo 55) no formato da API Focus NFe v2.
 * O formato é isolado aqui para que outro provedor só precise de um novo mapeamento.
 *
 * IMPORTANTE: valide sempre em HOMOLOGAÇÃO antes de produção. A tributação (CSOSN/CST,
 * CFOP, PIS/COFINS) vem do cadastro do produto e deve ser definida pelo contador da loja.
 */
type SaleFull = Sale & {
  items: (SaleItem & { variant: Variant & { product: Product } })[];
  payments: SalePayment[];
  customer: Customer | null;
};

export interface Destination {
  name?: string;
  document?: string | null;
  email?: string;
  phone?: string;
  street?: string;
  number?: string;
  complement?: string | null;
  district?: string;
  city?: string;
  cityCode?: string | null;
  uf?: string;
  zip?: string;
}

const dec = (cents: number) => (cents / 100).toFixed(2);

function localIso(d: Date) {
  // Data com fuso; a SEFAZ rejeita horário no futuro ou sem fuso.
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offset) % 60).padStart(2, '0');
  const local = new Date(d.getTime() + offset * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

function itemTaxes(company: Company, p: Product, totalCents: number) {
  const base: Record<string, string> = {
    icms_origem: String(p.origin),
    pis_situacao_tributaria: p.cstPis,
    cofins_situacao_tributaria: p.cstCofins,
  };
  if (company.crt === 3) {
    base.icms_situacao_tributaria = p.cstIcms ?? '00';
    if ((p.cstIcms ?? '00') === '00') {
      base.icms_modalidade_base_calculo = '3';
      base.icms_base_calculo = dec(totalCents);
      base.icms_aliquota = (p.icmsRate / 100).toFixed(2);
      base.icms_valor = dec(Math.round((totalCents * p.icmsRate) / 10000));
    }
  } else {
    base.icms_situacao_tributaria = p.csosn ?? '102';
  }
  return base;
}

function payments(sale: SaleFull) {
  return sale.payments.map((pm) => {
    const code = FISCAL_PAYMENT_CODE[pm.method as PaymentMethod] ?? '99';
    const out: Record<string, string> = { forma_pagamento: code, valor_pagamento: dec(pm.amountCents) };
    if (['03', '04', '17'].includes(code)) out.tipo_integracao = '2'; // pagamento não integrado ao sistema
    if (code === '99') out.descricao_pagamento = pm.method === 'VALE_TROCA' ? 'Vale-troca' : 'Outros';
    return out;
  });
}

function items(company: Company, sale: SaleFull, cfopOverride?: string) {
  const freight = allocate(sale.shippingCents, sale.items.map((it) => it.totalCents));
  return sale.items.map((it, i) => {
    const p = it.variant.product;
    const gross = it.quantity * it.unitPriceCents;
    const barcode = it.variant.barcode && !it.variant.barcode.startsWith('2') ? it.variant.barcode : 'SEM GTIN';
    return {
      numero_item: String(i + 1),
      codigo_produto: it.variant.sku,
      descricao: it.description.slice(0, 120),
      codigo_ncm: p.ncm,
      ...(p.cest ? { cest: p.cest } : {}),
      cfop: cfopOverride ?? p.cfop,
      unidade_comercial: p.unit,
      unidade_tributavel: p.unit,
      quantidade_comercial: it.quantity.toFixed(4),
      quantidade_tributavel: it.quantity.toFixed(4),
      valor_unitario_comercial: dec(it.unitPriceCents),
      valor_unitario_tributavel: dec(it.unitPriceCents),
      valor_bruto: dec(gross),
      ...(it.discountCents > 0 ? { valor_desconto: dec(it.discountCents) } : {}),
      ...(freight[i] > 0 ? { valor_frete: dec(freight[i]) } : {}),
      codigo_barras_comercial: barcode,
      codigo_barras_tributavel: barcode,
      ...itemTaxes(company, p, it.totalCents),
    };
  });
}

/** presenca: 1 presencial, 4 entrega a domicílio (pedido online dentro do estado) */
export function buildNfce(company: Company, sale: SaleFull, presenca: '1' | '4' = '1', dest?: Destination) {
  const doc = onlyDigits(sale.cpfNaNota ?? dest?.document ?? sale.customer?.document ?? '');
  const payload: Record<string, unknown> = {
    cnpj_emitente: company.cnpj,
    data_emissao: localIso(new Date()),
    natureza_operacao: 'VENDA AO CONSUMIDOR',
    presenca_comprador: presenca,
    modalidade_frete: sale.shippingCents > 0 ? '0' : '9',
    local_destino: '1',
    indicador_inscricao_estadual_destinatario: '9',
    valor_produtos: dec(sale.grossCents),
    valor_desconto: dec(sale.discountCents),
    ...(sale.shippingCents > 0 ? { valor_frete: dec(sale.shippingCents) } : {}),
    valor_total: dec(sale.totalCents + sale.shippingCents),
    items: items(company, sale),
    formas_pagamento: payments(sale),
  };
  if (sale.changeCents > 0) payload.valor_troco = dec(sale.changeCents);
  if (doc.length === 11) payload.cpf_destinatario = doc;
  if (doc.length === 14) payload.cnpj_destinatario = doc;
  const name = dest?.name ?? sale.customer?.name;
  if (doc && name) payload.nome_destinatario = name.slice(0, 60);
  return payload;
}

/** NF-e modelo 55 para venda pela internet a consumidor final (inclusive outro estado). */
export function buildNfe(company: Company, sale: SaleFull, dest: Destination) {
  const doc = onlyDigits(dest.document ?? '');
  if (![11, 14].includes(doc.length)) throw new Error('NF-e exige CPF/CNPJ do destinatário');
  const interstate = !!dest.uf && dest.uf !== company.uf;
  return {
    natureza_operacao: 'VENDA DE MERCADORIA',
    data_emissao: localIso(new Date()),
    tipo_documento: '1',
    finalidade_emissao: '1',
    consumidor_final: '1',
    presenca_comprador: '2', // operação pela internet
    local_destino: interstate ? '2' : '1',
    cnpj_emitente: company.cnpj,
    [doc.length === 11 ? 'cpf_destinatario' : 'cnpj_destinatario']: doc,
    nome_destinatario: dest.name,
    logradouro_destinatario: dest.street,
    numero_destinatario: dest.number,
    complemento_destinatario: dest.complement ?? undefined,
    bairro_destinatario: dest.district,
    municipio_destinatario: dest.city,
    uf_destinatario: dest.uf,
    cep_destinatario: onlyDigits(dest.zip ?? ''),
    telefone_destinatario: dest.phone ? onlyDigits(dest.phone) : undefined,
    email_destinatario: dest.email,
    indicador_inscricao_estadual_destinatario: '9',
    modalidade_frete: sale.shippingCents > 0 ? '0' : '9',
    valor_produtos: dec(sale.grossCents),
    valor_desconto: dec(sale.discountCents),
    ...(sale.shippingCents > 0 ? { valor_frete: dec(sale.shippingCents) } : {}),
    valor_total: dec(sale.totalCents + sale.shippingCents),
    items: items(company, sale, interstate ? '6108' : undefined),
    formas_pagamento: payments(sale),
  };
}

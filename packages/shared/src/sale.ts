import { z } from 'zod';
import { allocate, type Cents } from './money';

export const PAYMENT_METHODS = [
  'DINHEIRO',
  'PIX',
  'DEBITO',
  'CREDITO',
  'CREDIARIO',
  'VALE_TROCA',
  'OUTRO',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  DINHEIRO: 'Dinheiro',
  PIX: 'PIX',
  DEBITO: 'Cartão de débito',
  CREDITO: 'Cartão de crédito',
  CREDIARIO: 'Crediário',
  VALE_TROCA: 'Vale-troca',
  OUTRO: 'Outro',
};

/** Código da forma de pagamento na NFC-e/NF-e (tag tPag). */
export const FISCAL_PAYMENT_CODE: Record<PaymentMethod, string> = {
  DINHEIRO: '01',
  CREDITO: '03',
  DEBITO: '04',
  CREDIARIO: '05',
  VALE_TROCA: '99',
  PIX: '17',
  OUTRO: '99',
};

export const saleItemInput = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative().default(0),
});

export const salePaymentInput = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountCents: z.number().int().positive(),
  installments: z.number().int().min(1).max(24).default(1),
  /** Código do vale-troca, quando method = VALE_TROCA */
  voucherCode: z.string().optional(),
  /** Primeiro vencimento do crediário (AAAA-MM-DD) */
  firstDueDate: z.string().optional(),
});

/** Venda como sai do caixa — pode ter sido feita offline e chegar horas depois. */
export const saleInput = z.object({
  /** UUID gerado no próprio caixa: garante que reenviar a venda não a duplica. */
  id: z.string().uuid(),
  registerId: z.string().min(1),
  cashSessionId: z.string().min(1),
  customerId: z.string().nullish(),
  cpfNaNota: z.string().nullish(),
  items: z.array(saleItemInput).min(1),
  discountCents: z.number().int().nonnegative().default(0),
  payments: z.array(salePaymentInput).min(1),
  /** Token emitido quando um gerente autoriza desconto acima do limite do operador. */
  approvalToken: z.string().nullish(),
  /** Emitir NFC-e para esta venda */
  issueFiscal: z.boolean().default(true),
  createdAt: z.string().datetime(),
  offline: z.boolean().default(false),
  notes: z.string().max(500).nullish(),
});
export type SaleInput = z.infer<typeof saleInput>;

export interface CartLine {
  quantity: number;
  unitPriceCents: Cents;
  discountCents: Cents;
}

export interface CartTotals {
  grossCents: Cents;
  itemDiscountCents: Cents;
  saleDiscountCents: Cents;
  /** Desconto total por linha (item + rateio do desconto da venda), usado na nota fiscal. */
  lineDiscounts: Cents[];
  totalCents: Cents;
}

export function computeCart(lines: CartLine[], saleDiscountCents: Cents = 0): CartTotals {
  const grossLines = lines.map((l) => l.quantity * l.unitPriceCents);
  const grossCents = grossLines.reduce((a, b) => a + b, 0);
  const itemDiscountCents = lines.reduce((a, l) => a + l.discountCents, 0);
  lines.forEach((l, i) => {
    if (l.discountCents > grossLines[i]) throw new Error('Desconto do item maior que o valor do item');
  });
  const afterItems = grossCents - itemDiscountCents;
  if (saleDiscountCents > afterItems) throw new Error('Desconto maior que o valor da venda');
  const rateio = allocate(
    saleDiscountCents,
    lines.map((l, i) => grossLines[i] - l.discountCents),
  );
  const lineDiscounts = lines.map((l, i) => l.discountCents + rateio[i]);
  return {
    grossCents,
    itemDiscountCents,
    saleDiscountCents,
    lineDiscounts,
    totalCents: afterItems - saleDiscountCents,
  };
}

export interface PaymentCheck {
  paidCents: Cents;
  changeCents: Cents;
}

/** Valida pagamentos: precisam cobrir o total, e só dinheiro gera troco. */
export function checkPayments(
  totalCents: Cents,
  payments: { method: PaymentMethod; amountCents: Cents }[],
): PaymentCheck {
  const paidCents = payments.reduce((a, p) => a + p.amountCents, 0);
  if (paidCents < totalCents) throw new Error('Pagamento insuficiente');
  const changeCents = paidCents - totalCents;
  const cash = payments.filter((p) => p.method === 'DINHEIRO').reduce((a, p) => a + p.amountCents, 0);
  if (changeCents > cash) throw new Error('Troco só pode sair de pagamento em dinheiro');
  return { paidCents, changeCents };
}

export function discountPercent(grossCents: Cents, discountCents: Cents) {
  return grossCents === 0 ? 0 : (discountCents / grossCents) * 100;
}

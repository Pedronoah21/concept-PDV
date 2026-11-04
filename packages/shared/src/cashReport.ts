import { formatBRL, type Cents } from './money';
import { PAYMENT_LABELS, type PaymentMethod } from './sale';
import type { ReceiptLine } from './receipt';

/** Dados do relatório de fechamento de caixa impresso. */
export interface CashReportData {
  company: string;
  register: string;
  openedAt: string;
  closedAt: string | null;
  openedBy?: string | null;
  closedBy?: string | null;
  openingCents: Cents;
  salesCount: number;
  salesTotalCents: Cents;
  canceledCount: number;
  salesByMethod: Partial<Record<PaymentMethod, Cents>>;
  changeCents: Cents;
  movements: { type: string; amountCents: Cents; reason?: string | null; method?: string; at: string }[];
  expected: Partial<Record<PaymentMethod, Cents>>;
  counted: Partial<Record<PaymentMethod, Cents>> | null;
  differenceCents: Cents | null;
  notes?: string | null;
}

const MOV_LABEL: Record<string, string> = {
  SANGRIA: 'Sangria',
  SUPRIMENTO: 'Suprimento',
  DEVOLUCAO: 'Devolucao em dinheiro',
  RECEBIMENTO_CREDIARIO: 'Receb. crediario',
};
const COUNTED: PaymentMethod[] = ['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO', 'OUTRO'];
const SHORT: Record<string, string> = { DINHEIRO: 'Dinheiro', PIX: 'PIX', DEBITO: 'Debito', CREDITO: 'Credito', OUTRO: 'Outro' };
const dt = (s: string) => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

export function buildCashReport(r: CashReportData, width = 48): ReceiptLine[] {
  const L: ReceiptLine[] = [];
  const rule = () => L.push({ kind: 'rule' });
  const pair = (left: string, right: string, bold = false) => L.push({ kind: 'pair', left, right, bold });
  L.push({ kind: 'text', align: 'center', bold: true, text: r.company });
  L.push({ kind: 'text', align: 'center', bold: true, text: 'FECHAMENTO DE CAIXA' });
  L.push({ kind: 'text', align: 'center', text: r.register });
  rule();
  pair('Abertura', dt(r.openedAt));
  if (r.openedBy) pair('Aberto por', r.openedBy);
  pair('Fechamento', r.closedAt ? dt(r.closedAt) : 'em aberto');
  if (r.closedBy) pair('Fechado por', r.closedBy);
  rule();
  L.push({ kind: 'text', bold: true, text: 'VENDAS' });
  pair('Quantidade', String(r.salesCount));
  pair('Total vendido', formatBRL(r.salesTotalCents), true);
  if (r.canceledCount) pair('Canceladas (fora do total)', String(r.canceledCount));
  for (const [m, v] of Object.entries(r.salesByMethod)) if (v) pair(`  ${PAYMENT_LABELS[m as PaymentMethod]}`, formatBRL(v));
  if (r.changeCents) pair('  Troco devolvido', '-' + formatBRL(r.changeCents));
  rule();
  L.push({ kind: 'text', bold: true, text: 'MOVIMENTOS DO CAIXA' });
  pair('Fundo de troco', formatBRL(r.openingCents));
  if (!r.movements.length) L.push({ kind: 'text', text: 'Nenhuma sangria ou suprimento' });
  for (const m of r.movements) {
    const out = m.type === 'SANGRIA' || m.type === 'DEVOLUCAO';
    const label = `${new Date(m.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} ${MOV_LABEL[m.type] ?? m.type}`;
    pair(label.slice(0, width - 14), (out ? '-' : '+') + formatBRL(m.amountCents));
    if (m.reason) L.push({ kind: 'text', text: `   ${m.reason}`.slice(0, width) });
  }
  rule();
  L.push({ kind: 'text', bold: true, text: 'CONFERENCIA' });
  const wide = width >= 46;
  if (wide) L.push({ kind: 'text', text: 'Forma'.padEnd(10) + 'Esperado'.padStart(12) + 'Contado'.padStart(12) + 'Diferenca'.padStart(12) });
  let totalDiff = 0;
  for (const m of COUNTED) {
    const e = r.expected[m] ?? 0;
    const c = r.counted?.[m] ?? 0;
    if (!e && !c) continue;
    totalDiff += c - e;
    const col = (s: string, n: number) => s.padStart(n);
    const name = SHORT[m].padEnd(10);
    if (wide) L.push({ kind: 'text', text: name + col(formatBRL(e), 12) + col(formatBRL(c), 12) + col(formatBRL(c - e), 12) });
    else {
      L.push({ kind: 'text', bold: true, text: SHORT[m] });
      L.push({ kind: 'pair', left: '  Esperado', right: formatBRL(e) });
      L.push({ kind: 'pair', left: '  Contado', right: formatBRL(c) });
      L.push({ kind: 'pair', left: '  Diferenca', right: formatBRL(c - e) });
    }
  }
  rule();
  const diff = r.differenceCents ?? totalDiff;
  L.push({ kind: 'text', align: 'center', bold: true, text: diff === 0 ? 'CAIXA CONFERIDO SEM DIFERENCA' : diff < 0 ? `FALTA DE ${formatBRL(-diff)}` : `SOBRA DE ${formatBRL(diff)}` });
  if (r.notes) L.push({ kind: 'text', text: `Obs.: ${r.notes}` });
  L.push({ kind: 'feed', lines: 3 });
  L.push({ kind: 'text', align: 'center', text: '_'.repeat(Math.min(36, width - 4)) });
  L.push({ kind: 'text', align: 'center', text: 'Operador' });
  L.push({ kind: 'feed', lines: 2 });
  L.push({ kind: 'text', align: 'center', text: '_'.repeat(Math.min(36, width - 4)) });
  L.push({ kind: 'text', align: 'center', text: 'Conferido por (gerente)' });
  L.push({ kind: 'text', align: 'center', text: `Impresso em ${dt(new Date().toISOString())}` });
  L.push({ kind: 'feed', lines: 3 });
  return L;
}

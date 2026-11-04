import { formatBRL, type Cents } from './money';
import { PAYMENT_LABELS, type PaymentMethod } from './sale';
import { formatCpfCnpj } from './validators';

/** Dados de um cupom, independentes do meio de impressão (HTML ou ESC/POS). */
export interface ReceiptData {
  company: { name: string; cnpj: string; address?: string; phone?: string; ie?: string };
  saleNumber: string;
  date: string; // ISO
  operator?: string;
  customer?: { name?: string; document?: string | null };
  items: { code: string; description: string; quantity: number; unitPriceCents: Cents; discountCents: Cents; totalCents: Cents }[];
  grossCents: Cents;
  discountCents: Cents;
  totalCents: Cents;
  payments: { method: PaymentMethod; amountCents: Cents; installments?: number }[];
  changeCents: Cents;
  fiscal?: {
    model: 'NFCE' | 'NFE';
    number?: number | null;
    serie?: number | null;
    accessKey?: string | null;
    protocol?: string | null;
    qrcodeUrl?: string | null;
    consultUrl?: string | null;
    status: string;
  } | null;
  footer?: string;
  offline?: boolean;
  /** Via impressa: do cliente ou da loja (a da loja leva assinatura no crediário). */
  copy?: 'CLIENTE' | 'LOJA';
}

export type ReceiptLine =
  | { kind: 'text'; text: string; align?: 'left' | 'center' | 'right'; bold?: boolean; big?: boolean }
  | { kind: 'pair'; left: string; right: string; bold?: boolean }
  | { kind: 'rule' }
  | { kind: 'qr'; data: string }
  | { kind: 'feed'; lines: number };

/** Quebra o texto em linhas da largura da bobina sem cortar palavras (só as maiores que a linha). */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > width) {
      if (line) out.push(line);
      for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
      line = out.pop() ?? '';
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** Monta as linhas do cupom. `width` = colunas da bobina (48 para 80 mm, 32 para 58 mm). */
export function buildReceipt(r: ReceiptData, width = 48): ReceiptLine[] {
  const L: ReceiptLine[] = [];
  const fiscal = r.fiscal && r.fiscal.status === 'AUTORIZADA' ? r.fiscal : null;
  L.push({ kind: 'text', text: r.company.name, align: 'center', bold: true });
  L.push({ kind: 'text', text: `CNPJ ${formatCpfCnpj(r.company.cnpj)}${r.company.ie ? ' IE ' + r.company.ie : ''}`, align: 'center' });
  if (r.company.address) wrap(r.company.address, width).forEach((t) => L.push({ kind: 'text', text: t, align: 'center' }));
  L.push({ kind: 'rule' });
  L.push({
    kind: 'text',
    align: 'center',
    bold: true,
    text: fiscal ? 'DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletronica' : 'CUPOM NAO FISCAL',
  });
  if (r.copy) L.push({ kind: 'text', align: 'center', bold: true, text: r.copy === 'CLIENTE' ? 'VIA DO CLIENTE' : 'VIA DA LOJA' });
  L.push({ kind: 'rule' });
  L.push({ kind: 'text', text: '#  DESCRICAO' });
  L.push({ kind: 'text', text: '   QTD x UNIT                          TOTAL', align: 'left' });
  r.items.forEach((it, idx) => {
    wrap(`${String(idx + 1).padStart(2, '0')} ${it.code} ${it.description}`, width).forEach((t) => L.push({ kind: 'text', text: t }));
    L.push({ kind: 'pair', left: `   ${it.quantity} x ${formatBRL(it.unitPriceCents)}`, right: formatBRL(it.quantity * it.unitPriceCents) });
    if (it.discountCents > 0) L.push({ kind: 'pair', left: '   desconto', right: '-' + formatBRL(it.discountCents) });
  });
  L.push({ kind: 'rule' });
  L.push({ kind: 'pair', left: `Qtd. total de itens`, right: String(r.items.reduce((a, i) => a + i.quantity, 0)) });
  L.push({ kind: 'pair', left: 'Valor total', right: formatBRL(r.grossCents) });
  if (r.discountCents > 0) L.push({ kind: 'pair', left: 'Descontos', right: '-' + formatBRL(r.discountCents) });
  L.push({ kind: 'pair', left: 'VALOR A PAGAR', right: formatBRL(r.totalCents), bold: true });
  L.push({ kind: 'text', text: 'FORMA DE PAGAMENTO' });
  r.payments.forEach((p) =>
    L.push({
      kind: 'pair',
      left: PAYMENT_LABELS[p.method] + (p.installments && p.installments > 1 ? ` ${p.installments}x` : ''),
      right: formatBRL(p.amountCents),
    }),
  );
  if (r.changeCents > 0) L.push({ kind: 'pair', left: 'Troco', right: formatBRL(r.changeCents) });
  L.push({ kind: 'rule' });
  const doc = r.customer?.document;
  L.push({
    kind: 'text',
    align: 'center',
    text: doc ? `CONSUMIDOR ${formatCpfCnpj(doc)}${r.customer?.name ? ' ' + r.customer.name : ''}` : 'CONSUMIDOR NAO IDENTIFICADO',
  });
  if (fiscal) {
    L.push({ kind: 'text', align: 'center', text: `NFC-e n ${fiscal.number ?? '-'} Serie ${fiscal.serie ?? '-'} ${new Date(r.date).toLocaleString('pt-BR')}` });
    if (fiscal.protocol) L.push({ kind: 'text', align: 'center', text: `Protocolo de autorizacao ${fiscal.protocol}` });
    if (fiscal.consultUrl) L.push({ kind: 'text', align: 'center', text: `Consulte pela chave de acesso em ${fiscal.consultUrl}` });
    if (fiscal.accessKey) wrap(fiscal.accessKey.replace(/(\d{4})/g, '$1 ').trim(), width).forEach((t) => L.push({ kind: 'text', align: 'center', text: t }));
    if (fiscal.qrcodeUrl) L.push({ kind: 'qr', data: fiscal.qrcodeUrl });
  } else {
    L.push({ kind: 'text', align: 'center', text: `Venda ${r.saleNumber} - ${new Date(r.date).toLocaleString('pt-BR')}` });
    if (r.offline) L.push({ kind: 'text', align: 'center', text: 'Registrada sem internet - nota fiscal sera emitida na sincronizacao' });
  }
  if (r.operator) L.push({ kind: 'text', align: 'center', text: `Operador: ${r.operator}` });
  if (r.copy === 'LOJA' && r.payments.some((p) => p.method === 'CREDIARIO')) {
    L.push({ kind: 'feed', lines: 3 });
    L.push({ kind: 'text', align: 'center', text: '_'.repeat(Math.min(40, width - 4)) });
    L.push({ kind: 'text', align: 'center', text: `Assinatura ${r.customer?.name ?? 'do cliente'}` });
    L.push({ kind: 'text', align: 'center', text: 'Reconheco a divida do crediario acima' });
  }
  if (r.footer && r.copy !== 'LOJA') wrap(r.footer, width).forEach((t) => L.push({ kind: 'text', align: 'center', text: t }));
  L.push({ kind: 'feed', lines: 3 });
  return L;
}

/** Texto puro do cupom (útil para pré-visualização e testes). */
export function receiptToText(lines: ReceiptLine[], width = 48): string {
  return lines
    .map((l) => {
      switch (l.kind) {
        case 'rule':
          return '-'.repeat(width);
        case 'pair': {
          const space = Math.max(1, width - l.left.length - l.right.length);
          return (l.left + ' '.repeat(space) + l.right).slice(0, Math.max(width, l.left.length + l.right.length + 1));
        }
        case 'qr':
          return '[QR CODE]';
        case 'feed':
          return '\n'.repeat(l.lines - 1);
        default: {
          if (l.align === 'center') {
            const pad = Math.max(0, Math.floor((width - l.text.length) / 2));
            return ' '.repeat(pad) + l.text;
          }
          if (l.align === 'right') return l.text.padStart(width);
          return l.text;
        }
      }
    })
    .join('\n');
}

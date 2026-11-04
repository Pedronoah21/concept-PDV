import { buildCashReport, buildReceipt, EscPos, type CashReportData, type ReceiptData, type ReceiptLine } from '@concept/shared';

export type PrinterMode = 'navegador' | 'serial';
export interface PrinterSettings {
  mode: PrinterMode;
  paper: 80 | 58;
  autoPrint: boolean;
  openDrawer: boolean;
  /** Imprime a venda em duas vias: do cliente e da loja. */
  twoCopies: boolean;
}

const DEFAULTS: PrinterSettings = { mode: 'navegador', paper: 80, autoPrint: true, openDrawer: false, twoCopies: true };

export function getPrinterSettings(): PrinterSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('cpdv:printer') ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrinterSettings(s: PrinterSettings) {
  localStorage.setItem('cpdv:printer', JSON.stringify(s));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function linesToHtml(lines: ReceiptLine[], fiscalQrUrl?: string | null) {
  return lines
    .map((l) => {
      switch (l.kind) {
        case 'rule':
          return '<hr>';
        case 'pair':
          return `<div class="pair${l.bold ? ' b' : ''}"><span>${esc(l.left)}</span><span>${esc(l.right)}</span></div>`;
        case 'qr':
          return fiscalQrUrl ? `<div class="c small">Consulta via QR Code: ${esc(fiscalQrUrl)}</div>` : '';
        case 'feed':
          return `<div style="height:${l.lines * 1.2}em"></div>`;
        default:
          return `<div class="${l.align === 'center' ? 'c' : l.align === 'right' ? 'r' : ''}${l.bold ? ' b' : ''}">${esc(l.text)}</div>`;
      }
    })
    .join('');
}

/**
 * Impressão pelo driver do Windows/Linux (qualquer térmica instalada como impressora).
 * Cada documento (via) sai numa página própria, para o driver cortar entre elas.
 */
function printViaBrowser(docs: ReceiptLine[][], paper: 80 | 58, title: string, qrUrl?: string | null) {
  const pages = docs.map((lines) => `<section>${linesToHtml(lines, qrUrl)}</section>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { size: ${paper}mm auto; margin: 0 }
    body { width: ${paper - 8}mm; margin: 0 4mm; font-family: 'Courier New', monospace; color: #000;
      /* Fonte calculada para caber exatamente ${paper === 80 ? 48 : 32} colunas na largura útil da bobina. */
      font-size: calc(${paper - 8}mm / ${(paper === 80 ? 48 : 32) * 0.6}); line-height: 1.3 }
    div { white-space: pre-wrap }
    section + section { break-before: page; page-break-before: always }
    .c { text-align: center } .r { text-align: right } .b { font-weight: 700 } .small { font-size: 0.85em; word-break: break-all }
    .pair { display: flex; justify-content: space-between; gap: 8px }
    hr { border: 0; border-top: 1px dashed #000; margin: 4px 0 }
  </style></head><body>${pages}</body></html>`;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 2000);
  }, 150);
}

// Web Serial (Chrome/Edge): envia ESC/POS direto à térmica USB/serial, com QR Code nativo.
let port: any = null;
async function getPort() {
  const serial = (navigator as any).serial;
  if (!serial) throw new Error('Este navegador não suporta impressão direta. Use Chrome ou Edge, ou o modo "navegador".');
  if (!port) {
    const granted = await serial.getPorts();
    port = granted[0] ?? (await serial.requestPort());
  }
  if (!port.writable) await port.open({ baudRate: 9600 });
  return port;
}

export async function connectSerialPrinter() {
  port = null;
  await getPort();
}

/** Envia vários documentos de uma vez, com corte de papel entre eles. */
async function printViaSerial(docs: ReceiptLine[][], paper: 80 | 58, openDrawer: boolean) {
  const enc = new EscPos(paper === 80 ? 48 : 32);
  if (openDrawer) enc.openDrawer();
  for (const lines of docs) enc.lines(lines).cut();
  const p = await getPort();
  const writer = p.writable.getWriter();
  try {
    await writer.write(enc.build());
  } finally {
    writer.releaseLock();
  }
}

async function printDocs(docs: ReceiptLine[][], title: string, opts: { qrUrl?: string | null; drawer?: boolean } = {}) {
  const s = getPrinterSettings();
  if (s.mode === 'serial') return printViaSerial(docs, s.paper, !!opts.drawer && s.openDrawer);
  return printViaBrowser(docs, s.paper, title, opts.qrUrl);
}

/**
 * Cupom da venda. Com "duas vias" ligado, sai a via do cliente e a via da loja
 * (a da loja leva linha de assinatura quando há crediário).
 * `copies` força uma via só (ex.: reimpressão escolhida pelo operador).
 */
export async function printReceipt(data: ReceiptData, copies?: ('CLIENTE' | 'LOJA')[]) {
  const s = getPrinterSettings();
  const width = s.paper === 80 ? 48 : 32;
  const which = copies ?? (s.twoCopies ? (['CLIENTE', 'LOJA'] as const) : ([] as const));
  const docs = which.length ? which.map((copy) => buildReceipt({ ...data, copy }, width)) : [buildReceipt(data, width)];
  return printDocs(docs, `Cupom ${data.saleNumber}`, {
    qrUrl: data.fiscal?.qrcodeUrl,
    drawer: data.payments.some((p) => p.method === 'DINHEIRO'),
  });
}

/** Relatório de fechamento de caixa. */
export async function printCashReport(data: CashReportData) {
  const s = getPrinterSettings();
  return printDocs([buildCashReport(data, s.paper === 80 ? 48 : 32)], `Fechamento ${data.register}`);
}

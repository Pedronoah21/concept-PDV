import { buildReceipt, EscPos, type ReceiptData, type ReceiptLine } from '@concept/shared';

export type PrinterMode = 'navegador' | 'serial';
export interface PrinterSettings {
  mode: PrinterMode;
  paper: 80 | 58;
  autoPrint: boolean;
  openDrawer: boolean;
}

export function getPrinterSettings(): PrinterSettings {
  try {
    return { mode: 'navegador', paper: 80, autoPrint: true, openDrawer: false, ...JSON.parse(localStorage.getItem('cpdv:printer') ?? '{}') };
  } catch {
    return { mode: 'navegador', paper: 80, autoPrint: true, openDrawer: false };
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
          return '';
        default:
          return `<div class="${l.align === 'center' ? 'c' : l.align === 'right' ? 'r' : ''}${l.bold ? ' b' : ''}">${esc(l.text)}</div>`;
      }
    })
    .join('');
}

/** Impressão pelo driver do Windows/Linux (qualquer térmica instalada como impressora). */
function printViaBrowser(data: ReceiptData, paper: 80 | 58) {
  const lines = buildReceipt(data, paper === 80 ? 48 : 32);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cupom</title><style>
    @page { size: ${paper}mm auto; margin: 0 }
    body { width: ${paper - 8}mm; margin: 0 4mm; font: 11px/1.35 'Courier New', monospace; color: #000 }
    .c { text-align: center } .r { text-align: right } .b { font-weight: 700 } .small { font-size: 9px; word-break: break-all }
    .pair { display: flex; justify-content: space-between; gap: 8px }
    hr { border: 0; border-top: 1px dashed #000; margin: 4px 0 }
  </style></head><body>${linesToHtml(lines, data.fiscal?.qrcodeUrl)}</body></html>`;
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

async function printViaSerial(data: ReceiptData, paper: 80 | 58, openDrawer: boolean) {
  const width = paper === 80 ? 48 : 32;
  const enc = new EscPos(width).lines(buildReceipt(data, width)).cut();
  if (openDrawer) enc.openDrawer();
  const p = await getPort();
  const writer = p.writable.getWriter();
  try {
    await writer.write(enc.build());
  } finally {
    writer.releaseLock();
  }
}

export async function printReceipt(data: ReceiptData) {
  const s = getPrinterSettings();
  if (s.mode === 'serial') return printViaSerial(data, s.paper, s.openDrawer && data.payments.some((p) => p.method === 'DINHEIRO'));
  return printViaBrowser(data, s.paper);
}

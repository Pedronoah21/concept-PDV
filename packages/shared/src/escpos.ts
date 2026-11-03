import type { ReceiptLine } from './receipt';

/**
 * Gerador ESC/POS mínimo, compatível com Epson, Elgin, Bematech, Daruma, Tanca e afins.
 * Gera os bytes do cupom; o envio pode ser feito pela Web Serial/WebUSB do navegador
 * ou por um agente local de impressão.
 */
const ESC = 0x1b;
const GS = 0x1d;

// Página de código PC850 (ESC t 2): cobre os acentos do português.
const CP850: Record<string, number> = {
  'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'à': 0x85, 'ç': 0x87, 'ê': 0x88, 'É': 0x90,
  'ô': 0x93, 'á': 0xa0, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ª': 0xa6, 'º': 0xa7, 'Á': 0xb5,
  'Â': 0xb6, 'À': 0xb7, 'ã': 0xc6, 'Ã': 0xc7, 'Ê': 0xd2, 'Í': 0xd6, 'Ó': 0xe0, 'Ô': 0xe2,
  'õ': 0xe4, 'Õ': 0xe5, 'Ú': 0xe9,
};

export function encodeCP850(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) out.push(code);
    else out.push(CP850[ch] ?? 0x3f); // '?'
  }
  return out;
}

export class EscPos {
  private bytes: number[] = [];
  constructor(private width = 48) {
    this.raw(ESC, 0x40); // inicializa
    this.raw(ESC, 0x74, 2); // PC850
  }
  raw(...b: number[]) {
    this.bytes.push(...b);
    return this;
  }
  align(a: 'left' | 'center' | 'right') {
    return this.raw(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
  }
  bold(on: boolean) {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }
  size(big: boolean) {
    return this.raw(GS, 0x21, big ? 0x11 : 0x00);
  }
  text(t: string) {
    this.bytes.push(...encodeCP850(t), 0x0a);
    return this;
  }
  feed(n = 1) {
    return this.raw(ESC, 0x64, n);
  }
  qr(data: string, moduleSize = 5) {
    const d = encodeCP850(data);
    const len = d.length + 3;
    this.raw(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00); // modelo 2
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, moduleSize); // tamanho do módulo
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31); // correção de erro M
    this.raw(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...d);
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30); // imprime
    return this.raw(0x0a);
  }
  cut() {
    return this.raw(GS, 0x56, 0x42, 0x00);
  }
  /** Abre a gaveta de dinheiro ligada à impressora (pino 2). */
  openDrawer() {
    return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa);
  }
  lines(lines: ReceiptLine[]) {
    for (const l of lines) {
      switch (l.kind) {
        case 'rule':
          this.align('left').text('-'.repeat(this.width));
          break;
        case 'pair': {
          const space = Math.max(1, this.width - l.left.length - l.right.length);
          this.align('left').bold(!!l.bold).text(l.left + ' '.repeat(space) + l.right).bold(false);
          break;
        }
        case 'qr':
          this.align('center').qr(l.data);
          break;
        case 'feed':
          this.feed(l.lines);
          break;
        default:
          this.align(l.align ?? 'left').bold(!!l.bold).size(!!l.big).text(l.text).size(false).bold(false);
      }
    }
    return this;
  }
  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

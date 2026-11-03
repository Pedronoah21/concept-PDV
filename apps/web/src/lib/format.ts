export { formatBRL, toCents, formatCpfCnpj, onlyDigits } from '@concept/shared';

export const fmtDate = (d: string | Date) => new Date(d).toLocaleDateString('pt-BR');
export const fmtDateTime = (d: string | Date) =>
  new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
export const today = () => new Date().toISOString().slice(0, 10);
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** "12,50" → 1250 sem lançar erro (para campos digitados). */
export function parseMoney(input: string): number {
  const clean = input.replace(/[^\d,.-]/g, '');
  if (!clean) return 0;
  const n = Number(clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export const centsToInput = (c: number) => (c / 100).toFixed(2).replace('.', ',');

export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const variantLabel = (v: { color?: string | null; size?: string | null }) => [v.color, v.size].filter(Boolean).join(' / ');

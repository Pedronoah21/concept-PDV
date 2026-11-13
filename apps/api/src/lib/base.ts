/**
 * Caminho em que o sistema é servido, ex.: "/pdv" para cedcci.com.br/pdv.
 * Vazio = raiz do domínio. Definido por BASE_PATH (o build do app usa o mesmo valor).
 */
export function normalizeBase(raw: string | undefined) {
  const s = (raw ?? '').trim().replace(/\/+$/, '');
  if (!s || s === '/') return '';
  return s.startsWith('/') ? s : `/${s}`;
}

export const BASE = normalizeBase(process.env.BASE_PATH);

/** Caminho onde o app está publicado (ex.: "/pdv"); vazio na raiz do domínio. */
export const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** Endereço completo dentro do app: withBase('/loja/x') → '/pdv/loja/x'. */
export const withBase = (path: string) => `${BASE}${path.startsWith('/') ? path : `/${path}`}`;

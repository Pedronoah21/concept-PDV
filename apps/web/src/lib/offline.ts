import { useEffect, useState } from 'react';
import type { SaleInput } from '@concept/shared';
import { api, ApiError } from './api';
import { kv, outbox } from './idb';

export interface CatalogVariant {
  id: string;
  productId: string;
  name: string;
  brand: string | null;
  color: string | null;
  size: string | null;
  sku: string;
  barcode: string | null;
  unit: string;
  priceCents: number;
  listPriceCents: number;
  stock: number;
}

export interface Catalog {
  generatedAt: string;
  variants: CatalogVariant[];
  customers: { id: string; name: string; document: string | null; phone: string | null; creditLimitCents: number }[];
  receipt: { name: string; cnpj: string; ie: string | null; phone: string | null; address: string; footer: string | null };
}

export interface OutboxSale {
  id: string;
  localNumber: string;
  payload: SaleInput;
  createdAt: string;
  error?: string;
  permanent?: boolean;
}

// --------------------------------------------------------------------------
// Estado de sincronização observável pelas telas
// --------------------------------------------------------------------------
type SyncState = { online: boolean; pending: number; failed: number; syncing: boolean; lastSync: string | null };
let state: SyncState = { online: navigator.onLine, pending: 0, failed: 0, syncing: false, lastSync: null };
const subs = new Set<(s: SyncState) => void>();
const emit = (patch: Partial<SyncState>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f(state));
};

export function useSync() {
  const [s, set] = useState(state);
  useEffect(() => {
    subs.add(set);
    return () => void subs.delete(set);
  }, []);
  return s;
}

async function refreshCounts() {
  const all = await outbox.all<OutboxSale>();
  emit({ pending: all.filter((s) => !s.permanent).length, failed: all.filter((s) => s.permanent).length });
}

export async function loadCatalog(storeId: string): Promise<Catalog | null> {
  try {
    const cat = await api<Catalog>(`/sync/catalog?storeId=${storeId}`);
    await kv.set(`catalog:${storeId}`, cat);
    emit({ online: true });
    return cat;
  } catch (e) {
    if (e instanceof ApiError && e.offline) emit({ online: false });
    return (await kv.get<Catalog>(`catalog:${storeId}`)) ?? null;
  }
}

/** Baixa o estoque local depois de uma venda, para o caixa offline não vender o que já saiu. */
export async function decrementLocalStock(storeId: string, items: { variantId: string; quantity: number }[]) {
  const cat = await kv.get<Catalog>(`catalog:${storeId}`);
  if (!cat) return;
  for (const it of items) {
    const v = cat.variants.find((x) => x.id === it.variantId);
    if (v) v.stock -= it.quantity;
  }
  await kv.set(`catalog:${storeId}`, cat);
}

/** Próximo número provisório deste caixa (ex.: CX01-000123). */
export async function nextLocalNumber(registerCode: string) {
  const n = ((await kv.get<number>(`seq:${registerCode}`)) ?? 0) + 1;
  await kv.set(`seq:${registerCode}`, n);
  return `${registerCode}-${String(n).padStart(6, '0')}`;
}

export async function enqueueSale(sale: OutboxSale) {
  await outbox.put(sale);
  await refreshCounts();
}

/** Envia a fila de vendas. Seguro para chamar várias vezes: o servidor ignora repetidas. */
export async function flushOutbox() {
  if (state.syncing) return;
  const all = (await outbox.all<OutboxSale>()).filter((s) => !s.permanent);
  if (!all.length) {
    await refreshCounts();
    return;
  }
  emit({ syncing: true });
  try {
    for (let i = 0; i < all.length; i += 50) {
      const batch = all.slice(i, i + 50);
      const { results } = await api<{ results: { id: string; ok: boolean; permanent?: boolean; error?: string }[] }>('/sync/sales', {
        body: { sales: batch.map((s) => s.payload) },
      });
      for (const r of results) {
        if (r.ok) await outbox.del(r.id);
        else if (r.permanent) {
          const item = batch.find((b) => b.id === r.id);
          if (item) await outbox.put({ ...item, error: r.error, permanent: true });
        }
      }
    }
    emit({ online: true, lastSync: new Date().toISOString() });
  } catch (e) {
    if (e instanceof ApiError && e.offline) emit({ online: false });
  } finally {
    emit({ syncing: false });
    await refreshCounts();
  }
}

export async function retryFailed(id: string) {
  const all = await outbox.all<OutboxSale>();
  const item = all.find((s) => s.id === id);
  if (item) await outbox.put({ ...item, permanent: false, error: undefined });
  await flushOutbox();
}

export function startSyncLoop() {
  refreshCounts();
  window.addEventListener('online', () => {
    emit({ online: true });
    flushOutbox();
  });
  window.addEventListener('offline', () => emit({ online: false }));
  setInterval(() => {
    if (navigator.onLine) flushOutbox();
  }, 15_000);
  flushOutbox();
}

export const markOffline = () => emit({ online: false });

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { fmtDateTime, formatBRL } from '../lib/format';
import { Field, Input, Loading, Modal, toast, useAction, useLoad } from '../components/ui';

const TYPE_LABEL: Record<string, string> = {
  COMPRA: 'Entrada de compra',
  VENDA: 'Venda',
  DEVOLUCAO: 'Devolução',
  CANCELAMENTO: 'Cancelamento de venda',
  AJUSTE: 'Ajuste',
  PERDA: 'Perda',
  INVENTARIO: 'Inventário',
  TRANSFERENCIA: 'Transferência',
};

export function StockPage() {
  const { store, can, me } = useSession();
  const manager = can('gerencia');
  const [storeId, setStoreId] = useState(store?.id ?? me!.stores[0]?.id ?? '');
  const [q, setQ] = useState('');
  const [low, setLow] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const categories = useLoad<any[]>('/categories');
  const { data, error, loading, reload, setData } = useLoad<any[]>(
    `/stock?storeId=${storeId}&q=${encodeURIComponent(q)}${low ? '&low=1' : ''}${categoryId ? `&categoryId=${categoryId}` : ''}`,
    [storeId, q, low, categoryId],
  );
  const [adjust, setAdjust] = useState<any | null>(null);
  const [history, setHistory] = useState<any | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const totalValue = data?.reduce((a, r) => a + (r.valueCents ?? 0), 0) ?? 0;
  const allSelected = !!data?.length && data.every((r) => selected.has(r.variantId));

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  /** Atualiza a linha na tela sem recarregar a lista inteira. */
  const applyLocal = (ids: Set<string> | null, minStock: number) =>
    setData((rows) => rows?.map((r) => (!ids || ids.has(r.variantId) ? { ...r, minStock, low: r.quantity <= minStock } : r)) ?? rows);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Estoque</h1>
        <div className="row">
          {me!.stores.length > 1 && (
            <select className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)} style={{ width: 200 }} aria-label="Loja">
              {me!.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <select className="input" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setSelected(new Set()); }} style={{ width: 200 }} aria-label="Categoria">
            <option value="">Todas as categorias</option>
            {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Input placeholder="Buscar produto" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
          <label className="check"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Só abaixo do mínimo</label>
        </div>
      </div>
      {manager && data && <p className="muted">Valor do estoque a custo médio: <b className="num">{formatBRL(totalValue)}</b></p>}
      {manager && (selected.size > 0 || categoryId) && (
        <div className="notice go spread">
          <span>
            {selected.size > 0
              ? `${selected.size} item(ns) selecionado(s)`
              : `Categoria ${categories.data?.find((c) => c.id === categoryId)?.name ?? ''}: ${data?.length ?? 0} item(ns)`}
          </span>
          <div className="row">
            {selected.size > 0 && <button className="btn sm ghost" onClick={() => setSelected(new Set())}>Limpar seleção</button>}
            <button className="btn sm primary" onClick={() => setBulk(true)}>Definir estoque mínimo</button>
          </div>
        </div>
      )}
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="panel flush table-wrap">
          <table className="table">
            <thead>
              <tr>
                {manager && (
                  <th style={{ width: 36 }}>
                    <input type="checkbox" aria-label="Selecionar todos" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(data.map((r) => r.variantId)))} />
                  </th>
                )}
                <th>Produto</th><th>Variação</th><th>Código</th><th className="r">Saldo</th><th className="r">Reservado</th><th className="r">Mínimo</th>
                {manager && <th className="r">Custo médio</th>}<th />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.variantId}>
                  {manager && <td><input type="checkbox" aria-label={`Selecionar ${r.name}`} checked={selected.has(r.variantId)} onChange={() => toggle(r.variantId)} /></td>}
                  <td>{r.name}{r.category && <div className="muted small">{r.category}</div>}</td>
                  <td>{[r.color, r.size].filter(Boolean).join(' / ') || '—'}</td>
                  <td className="muted">{r.barcode}</td>
                  <td className="r num">{r.low ? <span className="tag danger">{r.quantity}</span> : r.quantity}</td>
                  <td className="r num">{r.reserved || '—'}</td>
                  <td className="r">{manager ? <MinCell row={r} onSaved={(v) => applyLocal(new Set([r.variantId]), v)} /> : <span className="num">{r.minStock}</span>}</td>
                  {manager && <td className="r num">{formatBRL(r.avgCostCents ?? 0)}</td>}
                  <td className="r">
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm" onClick={() => setHistory(r)}>Histórico</button>
                      {manager && <button className="btn sm" onClick={() => setAdjust(r)}>Ajustar</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {!data.length && <tr><td colSpan={9} className="empty">Nenhum item neste filtro.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {adjust && <AdjustModal row={adjust} storeId={storeId} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); reload(); }} />}
      {history && <HistoryModal row={history} onClose={() => setHistory(null)} />}
      {bulk && (
        <BulkMinModal
          variantIds={selected.size ? [...selected] : null}
          categoryId={selected.size ? null : categoryId}
          categoryName={categories.data?.find((c) => c.id === categoryId)?.name ?? null}
          onClose={() => setBulk(false)}
          onDone={(minStock) => {
            applyLocal(selected.size ? selected : null, minStock);
            setSelected(new Set());
            setBulk(false);
            if (low) reload();
          }}
        />
      )}
    </div>
  );
}

/** Mínimo editável na própria linha: salva ao sair do campo ou ao apertar Enter. */
function MinCell({ row, onSaved }: { row: any; onSaved: (v: number) => void }) {
  const [value, setValue] = useState(String(row.minStock));
  const [saving, setSaving] = useState(false);
  // Acompanha mudanças vindas de fora (definição em lote, recarga da lista).
  useEffect(() => setValue(String(row.minStock)), [row.minStock]);
  const save = async () => {
    const n = Math.max(0, Math.floor(Number(value)));
    if (!Number.isFinite(n) || n === row.minStock) return setValue(String(row.minStock));
    setSaving(true);
    try {
      await api('/stock/min', { body: { minStock: n, variantIds: [row.variantId] } });
      onSaved(n);
      setValue(String(n));
    } catch (e) {
      toast((e as Error).message);
      setValue(String(row.minStock));
    } finally {
      setSaving(false);
    }
  };
  return (
    <input
      className="input num"
      style={{ width: 72, minHeight: 32, padding: '4px 8px', textAlign: 'right', opacity: saving ? 0.5 : 1 }}
      type="number"
      min={0}
      inputMode="numeric"
      aria-label={`Estoque mínimo de ${row.name} ${[row.color, row.size].filter(Boolean).join(' ')}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setValue(String(row.minStock));
      }}
    />
  );
}

function BulkMinModal({ variantIds, categoryId, categoryName, onClose, onDone }: { variantIds: string[] | null; categoryId: string | null; categoryName: string | null; onClose: () => void; onDone: (v: number) => void }) {
  const [value, setValue] = useState(2);
  const [run, busy] = useAction(async () => {
    const r = await api<{ updated: number }>('/stock/min', { body: { minStock: value, ...(variantIds ? { variantIds } : { categoryId }) } });
    toast(`Estoque mínimo definido em ${r.updated} item(ns)`);
    onDone(value);
  });
  return (
    <Modal title="Definir estoque mínimo" onClose={onClose} footer={<button className="btn primary" disabled={busy || value < 0} onClick={() => run()}>Aplicar a {variantIds ? `${variantIds.length} item(ns)` : `toda a categoria`}</button>}>
      <p>
        {variantIds
          ? `O mínimo dos ${variantIds.length} item(ns) selecionado(s) será substituído.`
          : `Todas as variações da categoria ${categoryName}, inclusive as que não aparecem no filtro atual, receberão este mínimo.`}
      </p>
      <Field label="Estoque mínimo" hint="Quando o saldo chegar a este número, o item aparece em vermelho e entra em Estoque baixo no Painel.">
        <Input type="number" min={0} value={value} onChange={(e) => setValue(Number(e.target.value))} autoFocus onKeyDown={(e) => e.key === 'Enter' && run()} />
      </Field>
    </Modal>
  );
}

function AdjustModal({ row, storeId, onClose, onDone }: { row: any; storeId: string; onClose: () => void; onDone: () => void }) {
  const { me } = useSession();
  const [type, setType] = useState<'INVENTARIO' | 'AJUSTE' | 'PERDA' | 'TRANSFERENCIA'>('INVENTARIO');
  const [quantity, setQuantity] = useState(row.quantity);
  const [reason, setReason] = useState('');
  const [toStore, setToStore] = useState(me!.stores.find((s) => s.id !== storeId)?.id ?? '');
  const [run, busy] = useAction(async () => {
    if (type === 'TRANSFERENCIA') await api('/stock/transfer', { body: { variantId: row.variantId, fromStoreId: storeId, toStoreId: toStore, quantity } });
    else await api('/stock/adjust', { body: { variantId: row.variantId, storeId, type, quantity, reason } });
    toast('Estoque atualizado');
    onDone();
  });
  return (
    <Modal title={`Ajustar ${row.name} ${[row.color, row.size].filter(Boolean).join(' / ')}`} onClose={onClose}
      footer={<button className="btn primary" disabled={busy || (type !== 'TRANSFERENCIA' && reason.length < 3)} onClick={() => run()}>Confirmar</button>}>
      <p>Saldo atual: <b className="num">{row.quantity}</b></p>
      <Field label="Tipo">
        <select className="input" value={type} onChange={(e) => { const t = e.target.value as typeof type; setType(t); setQuantity(t === 'INVENTARIO' ? row.quantity : 1); }}>
          <option value="INVENTARIO">Contagem de inventário (informar o saldo contado)</option>
          <option value="AJUSTE">Ajuste (somar ou subtrair)</option>
          <option value="PERDA">Perda, avaria ou furto</option>
          {me!.stores.length > 1 && <option value="TRANSFERENCIA">Transferir para outra loja</option>}
        </select>
      </Field>
      <Field label={type === 'INVENTARIO' ? 'Quantidade contada' : type === 'AJUSTE' ? 'Quantidade (negativa para tirar)' : 'Quantidade'}>
        <Input type="number" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} autoFocus />
      </Field>
      {type === 'TRANSFERENCIA' ? (
        <Field label="Loja de destino">
          <select className="input" value={toStore} onChange={(e) => setToStore(e.target.value)}>
            {me!.stores.filter((s) => s.id !== storeId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      ) : (
        <Field label="Motivo"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      )}
    </Modal>
  );
}

function HistoryModal({ row, onClose }: { row: any; onClose: () => void }) {
  const { data, loading, error } = useLoad<any[]>(`/stock/movements?variantId=${row.variantId}`);
  return (
    <Modal title={`Histórico — ${row.name} ${[row.color, row.size].filter(Boolean).join(' / ')}`} onClose={onClose} wide>
      <Loading loading={loading} error={error} />
      {data && (
        <table className="table">
          <thead><tr><th>Data</th><th>Movimento</th><th>Motivo</th><th className="r">Qtd.</th><th className="r">Saldo</th></tr></thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.id}>
                <td>{fmtDateTime(m.createdAt)}</td>
                <td>{TYPE_LABEL[m.type] ?? m.type}</td>
                <td className="muted">{m.reason ?? ''}</td>
                <td className="r num" style={{ color: m.quantity < 0 ? 'var(--danger)' : 'var(--go)' }}>{m.quantity > 0 ? '+' : ''}{m.quantity}</td>
                <td className="r num">{m.balanceAfter}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

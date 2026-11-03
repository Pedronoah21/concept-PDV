import { useState } from 'react';
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
  const [storeId, setStoreId] = useState(store?.id ?? me!.stores[0]?.id ?? '');
  const [q, setQ] = useState('');
  const [low, setLow] = useState(false);
  const { data, error, loading, reload } = useLoad<any[]>(`/stock?storeId=${storeId}&q=${encodeURIComponent(q)}${low ? '&low=1' : ''}`, [storeId, q, low]);
  const [adjust, setAdjust] = useState<any | null>(null);
  const [history, setHistory] = useState<any | null>(null);
  const totalValue = data?.reduce((a, r) => a + (r.valueCents ?? 0), 0) ?? 0;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Estoque</h1>
        <div className="row">
          {me!.stores.length > 1 && (
            <select className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)} style={{ width: 200 }}>
              {me!.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <Input placeholder="Buscar produto" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
          <label className="check"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Só abaixo do mínimo</label>
        </div>
      </div>
      {can('gerencia') && data && <p className="muted">Valor do estoque a custo médio: <b className="num">{formatBRL(totalValue)}</b></p>}
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="panel flush table-wrap">
          <table className="table">
            <thead><tr><th>Produto</th><th>Variação</th><th>Código</th><th className="r">Saldo</th><th className="r">Reservado</th><th className="r">Mínimo</th>{can('gerencia') && <th className="r">Custo médio</th>}<th /></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.variantId}>
                  <td>{r.name}</td>
                  <td>{[r.color, r.size].filter(Boolean).join(' / ') || '—'}</td>
                  <td className="muted">{r.barcode}</td>
                  <td className="r num">{r.low ? <span className="tag danger">{r.quantity}</span> : r.quantity}</td>
                  <td className="r num">{r.reserved || '—'}</td>
                  <td className="r num">{r.minStock}</td>
                  {can('gerencia') && <td className="r num">{formatBRL(r.avgCostCents ?? 0)}</td>}
                  <td className="r">
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm" onClick={() => setHistory(r)}>Histórico</button>
                      {can('gerencia') && <button className="btn sm" onClick={() => setAdjust(r)}>Ajustar</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adjust && <AdjustModal row={adjust} storeId={storeId} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); reload(); }} />}
      {history && <HistoryModal row={history} onClose={() => setHistory(null)} />}
    </div>
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

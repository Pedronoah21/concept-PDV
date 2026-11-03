import { useState } from 'react';
import { PAYMENT_LABELS, type PaymentMethod } from '@concept/shared';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { fmtDateTime, formatBRL, formatCpfCnpj } from '../lib/format';
import { Field, Loading, Modal, MoneyInput, Status, toast, useAction, useLoad } from '../components/ui';

const FLOW: Record<string, string[]> = {
  PENDENTE: ['PAGO', 'CANCELADO'],
  PAGO: ['SEPARACAO', 'CANCELADO'],
  SEPARACAO: ['ENVIADO', 'ENTREGUE'],
  ENVIADO: ['ENTREGUE'],
};
const ACTION: Record<string, string> = { PAGO: 'Confirmar pagamento', SEPARACAO: 'Iniciar separação', ENVIADO: 'Marcar como enviado', ENTREGUE: 'Marcar como entregue', CANCELADO: 'Cancelar pedido' };

export function OrdersPage() {
  const { me } = useSession();
  const [status, setStatus] = useState('');
  const { data, error, loading, reload } = useLoad<any[]>(`/orders${status ? `?status=${status}` : ''}`, [status]);
  const [open, setOpen] = useState<any | null>(null);
  const shopUrl = `${location.origin}/loja/${me!.company.slug}`;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Pedidos online</h1>
          <p className="muted">Sua loja: <a href={shopUrl} target="_blank" rel="noreferrer">{shopUrl}</a></p>
        </div>
        <select className="input" style={{ width: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos</option>
          {['PENDENTE', 'PAGO', 'SEPARACAO', 'ENVIADO', 'ENTREGUE', 'CANCELADO'].map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
        </select>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="panel flush table-wrap">
          <table className="table">
            <thead><tr><th>Pedido</th><th>Data</th><th>Cliente</th><th>Entrega</th><th>Pagamento</th><th>Situação</th><th className="r">Total</th></tr></thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id} className="click" onClick={() => setOpen(o)}>
                  <td className="num">#{o.number}</td>
                  <td>{fmtDateTime(o.createdAt)}</td>
                  <td>{o.customerName}</td>
                  <td>{o.delivery === 'ENTREGA' ? `Entrega — ${o.addressJson.city}/${o.addressJson.uf}` : 'Retirada na loja'}</td>
                  <td>{PAYMENT_LABELS[o.paymentMethod as PaymentMethod]}</td>
                  <td><Status s={o.status} />{o.saleId && <span className="tag go" style={{ marginLeft: 6 }}>faturado</span>}</td>
                  <td className="r num">{formatBRL(o.totalCents)}</td>
                </tr>
              ))}
              {!data.length && <tr><td colSpan={7} className="empty">Nenhum pedido ainda. Divulgue o endereço da sua loja online.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {open && <OrderModal order={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} />}
    </div>
  );
}

function OrderModal({ order, onClose, onChanged }: { order: any; onClose: () => void; onChanged: () => void }) {
  const [shipping, setShipping] = useState(order.shippingCents);
  const [change, busy] = useAction(async (status: string) => {
    if (status === 'CANCELADO' && !confirm('Cancelar o pedido e liberar o estoque reservado?')) return;
    await api(`/orders/${order.id}`, { method: 'PATCH', body: { status, shippingCents: shipping } });
    toast('Pedido atualizado');
    onChanged();
  });
  const [invoice, invoicing] = useAction(async () => {
    const r = await api<{ saleId: string }>(`/orders/${order.id}/invoice`, { method: 'POST' });
    toast('Pedido faturado e nota fiscal solicitada');
    navigate(`/vendas/${r.saleId}`);
  });
  const a = order.addressJson;
  return (
    <Modal title={`Pedido #${order.number}`} onClose={onClose} wide
      footer={
        <>
          {(FLOW[order.status] ?? []).map((s) => (
            <button key={s} className={`btn ${s === 'CANCELADO' ? 'danger' : ''}`} disabled={busy} onClick={() => change(s)}>{ACTION[s]}</button>
          ))}
          {!order.saleId && ['PAGO', 'SEPARACAO', 'ENVIADO', 'ENTREGUE'].includes(order.status) && (
            <button className="btn primary" disabled={invoicing} onClick={() => invoice()}>Faturar e emitir nota</button>
          )}
        </>
      }>
      <div className="grid cols-2">
        <div className="stack" style={{ gap: 4 }}>
          <h3>{order.customerName}</h3>
          <span>{order.customerEmail}</span>
          <span>{order.customerPhone}</span>
          {order.customerDoc && <span>CPF/CNPJ {formatCpfCnpj(order.customerDoc)}</span>}
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <h3>{order.delivery === 'ENTREGA' ? 'Entregar em' : 'Retirada na loja'}</h3>
          {order.delivery === 'ENTREGA' && (
            <>
              <span>{a.street}, {a.number}{a.complement ? ` — ${a.complement}` : ''}</span>
              <span>{a.district}, {a.city}/{a.uf}, CEP {a.zip}</span>
            </>
          )}
        </div>
      </div>
      <table className="table">
        <thead><tr><th>Item</th><th className="r">Qtd.</th><th className="r">Preço</th><th className="r">Total</th></tr></thead>
        <tbody>
          {order.itemsJson.map((i: any) => (
            <tr key={i.variantId}><td>{i.description}</td><td className="r num">{i.quantity}</td><td className="r num">{formatBRL(i.unitPriceCents)}</td><td className="r num">{formatBRL(i.quantity * i.unitPriceCents)}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="grid cols-2" style={{ alignItems: 'end' }}>
        <Field label="Frete cobrado do cliente">
          <MoneyInput value={shipping} onChange={setShipping} disabled={!!order.saleId} />
        </Field>
        <div className="remaining"><span>Total</span><span>{formatBRL(order.subtotalCents + shipping)}</span></div>
      </div>
      {order.notes && <p className="muted">Observação do cliente: {order.notes}</p>}
    </Modal>
  );
}

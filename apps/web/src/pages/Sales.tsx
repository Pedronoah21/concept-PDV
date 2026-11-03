import { useState } from 'react';
import { PAYMENT_LABELS, type PaymentMethod, type ReceiptData } from '@concept/shared';
import { api } from '../lib/api';
import { Link, navigate, useQuery } from '../lib/router';
import { useSession } from '../lib/session';
import { kv } from '../lib/idb';
import { daysAgo, fmtDateTime, formatBRL, formatCpfCnpj, today } from '../lib/format';
import { Field, Input, Loading, Modal, Status, toast, useAction, useLoad } from '../components/ui';
import { printReceipt } from '../lib/print';

export function SalesPage() {
  const query = useQuery();
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(today());
  const [q, setQ] = useState('');
  const review = query.get('review') ? '&review=1' : '';
  const { data, error, loading } = useLoad<any[]>(`/sales?from=${from}&to=${to}&q=${encodeURIComponent(q)}${review}`, [from, to, q, review]);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>{review ? 'Vendas para revisar' : 'Vendas'}</h1>
        <div className="row">
          <Field label="Buscar"><Input placeholder="Número ou cliente" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Field label="De"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Até"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="panel flush table-wrap">
          <table className="table">
            <thead>
              <tr><th>Nº</th><th>Data</th><th>Cliente</th><th>Pagamento</th><th>Nota</th><th>Situação</th><th className="r">Total</th></tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id} className="click" onClick={() => navigate(`/vendas/${s.id}`)}>
                  <td className="num">{s.number}{s.channel === 'ONLINE' && <span className="tag" style={{ marginLeft: 6 }}>online</span>}</td>
                  <td>{fmtDateTime(s.createdAt)}</td>
                  <td>{s.customer?.name ?? <span className="muted">Consumidor</span>}</td>
                  <td>{s.payments.map((p: any) => PAYMENT_LABELS[p.method as PaymentMethod]).join(', ')}</td>
                  <td>{s.fiscalDocuments[0] ? <Status s={s.fiscalDocuments[0].status} /> : <span className="muted">—</span>}</td>
                  <td>
                    <Status s={s.status} />
                    {s.needsReview && <span className="tag warn" style={{ marginLeft: 6 }}>revisar</span>}
                    {s.offline && <span className="tag" style={{ marginLeft: 6 }}>offline</span>}
                  </td>
                  <td className="r num">{formatBRL(s.totalCents)}</td>
                </tr>
              ))}
              {!data.length && <tr><td colSpan={7} className="empty">Nenhuma venda no período.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SaleDetailPage({ id }: { id: string }) {
  const { can, me, registerId } = useSession();
  const { data: sale, error, loading, reload } = useLoad<any>(`/sales/${id}`);
  const [modal, setModal] = useState<null | 'cancel' | 'return'>(null);
  const [review, reviewing] = useAction(async () => {
    await api(`/sales/${id}/review`, { method: 'POST' });
    toast('Venda revisada');
    reload();
  });
  const [retry, retrying] = useAction(async (docId: string) => {
    await api(`/fiscal/${docId}/retry`, { method: 'POST' });
    reload();
  });

  if (!sale) return <Loading error={error} loading={loading} />;
  const doc = sale.fiscalDocuments[0];

  const reprint = async () => {
    const receipt = await kv.get<any>(`catalog:${sale.storeId}`);
    const data: ReceiptData = {
      company: { name: me!.company.tradeName, cnpj: me!.company.cnpj, ie: me!.company.ie ?? undefined, address: receipt?.receipt?.address },
      saleNumber: String(sale.number),
      date: sale.createdAt,
      customer: { name: sale.customer?.name, document: sale.cpfNaNota },
      items: sale.items.map((i: any) => ({ code: '', description: i.description, quantity: i.quantity, unitPriceCents: i.unitPriceCents, discountCents: i.discountCents, totalCents: i.totalCents })),
      grossCents: sale.grossCents,
      discountCents: sale.discountCents,
      totalCents: sale.totalCents,
      payments: sale.payments,
      changeCents: sale.changeCents,
      footer: me!.company.receiptFooter ?? undefined,
      fiscal: doc ? { model: doc.model, number: doc.number, serie: doc.serie, accessKey: doc.accessKey, protocol: doc.protocol, qrcodeUrl: doc.qrcodeUrl, consultUrl: doc.consultUrl, status: doc.status } : null,
    };
    await printReceipt(data);
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <Link to="/vendas">Vendas</Link>
          <h1>Venda {sale.number}</h1>
          <p className="muted">
            {fmtDateTime(sale.createdAt)} — {sale.channel === 'ONLINE' ? 'loja online' : 'balcão'}
            {sale.offline ? ', registrada sem internet' : ''}
          </p>
        </div>
        <div className="row">
          <Status s={sale.status} />
          <button className="btn" onClick={() => reprint().catch((e) => toast(e.message))}>Reimprimir cupom</button>
          {doc?.danfeUrl && <a className="btn" href={doc.danfeUrl} target="_blank" rel="noreferrer">Abrir DANFE</a>}
          {sale.status === 'CONCLUIDA' && <button className="btn" onClick={() => setModal('return')}>Troca / devolução</button>}
          {sale.status === 'CONCLUIDA' && can('gerencia') && <button className="btn danger" onClick={() => setModal('cancel')}>Cancelar venda</button>}
        </div>
      </div>

      {sale.needsReview && (
        <div className="notice warn spread">
          <span>Venda feita sem internet com desconto ou crediário acima do limite do operador.</span>
          {can('gerencia') && <button className="btn sm" disabled={reviewing} onClick={() => review()}>Marcar como revisada</button>}
        </div>
      )}
      {sale.status === 'CANCELADA' && <div className="notice danger">Cancelada em {fmtDateTime(sale.canceledAt)}: {sale.cancelReason}</div>}

      <div className="grid cols-2">
        <div className="panel flush">
          <table className="table">
            <thead><tr><th>Item</th><th className="r">Qtd.</th><th className="r">Unitário</th><th className="r">Desconto</th><th className="r">Total</th></tr></thead>
            <tbody>
              {sale.items.map((i: any) => (
                <tr key={i.id}>
                  <td>{i.description}{i.returnedQty > 0 && <span className="tag warn" style={{ marginLeft: 6 }}>{i.returnedQty} devolvido(s)</span>}</td>
                  <td className="r num">{i.quantity}</td>
                  <td className="r num">{formatBRL(i.unitPriceCents)}</td>
                  <td className="r num">{i.discountCents ? formatBRL(i.discountCents) : '—'}</td>
                  <td className="r num">{formatBRL(i.totalCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={4} className="r">Total</td><td className="r num" style={{ fontSize: 20 }}>{formatBRL(sale.totalCents)}</td></tr>
            </tfoot>
          </table>
        </div>
        <div className="stack">
          <div className="panel stack" style={{ gap: 8 }}>
            <h2>Pagamento</h2>
            {sale.payments.map((p: any) => (
              <div key={p.id} className="spread"><span>{PAYMENT_LABELS[p.method as PaymentMethod]}{p.installments > 1 ? ` em ${p.installments}x` : ''}</span><span className="num">{formatBRL(p.amountCents)}</span></div>
            ))}
            {sale.changeCents > 0 && <div className="spread muted"><span>Troco</span><span className="num">{formatBRL(sale.changeCents)}</span></div>}
            {sale.customer && <p>Cliente: <Link to={`/clientes/${sale.customer.id}`}>{sale.customer.name}</Link></p>}
            {sale.cpfNaNota && <p className="muted">CPF/CNPJ na nota: {formatCpfCnpj(sale.cpfNaNota)}</p>}
          </div>
          <div className="panel stack" style={{ gap: 8 }}>
            <h2>Nota fiscal</h2>
            {!sale.fiscalDocuments.length && <p className="muted">Venda sem emissão de nota.</p>}
            {sale.fiscalDocuments.map((d: any) => (
              <div key={d.id} className="stack" style={{ gap: 4 }}>
                <div className="spread">
                  <span>{d.model === 'NFCE' ? 'NFC-e' : 'NF-e'} {d.number ?? ''}</span>
                  <Status s={d.status} />
                </div>
                {d.accessKey && <span className="small muted" style={{ wordBreak: 'break-all' }}>Chave {d.accessKey}</span>}
                {d.message && <span className="small">{d.message}</span>}
                {['PENDENTE', 'ERRO', 'REJEITADA'].includes(d.status) && can('gerencia') && (
                  <button className="btn sm" disabled={retrying} onClick={() => retry(d.id)}>Enviar novamente</button>
                )}
              </div>
            ))}
          </div>
          {sale.installments.length > 0 && (
            <div className="panel stack" style={{ gap: 8 }}>
              <h2>Parcelas do crediário</h2>
              {sale.installments.map((i: any) => (
                <div key={i.id} className="spread"><span>{i.number}/{i.of} — vence {new Date(i.dueDate).toLocaleDateString('pt-BR')}</span><span className="row"><span className="num">{formatBRL(i.amountCents)}</span><Status s={i.status} /></span></div>
              ))}
            </div>
          )}
          {sale.returns.length > 0 && (
            <div className="panel stack" style={{ gap: 8 }}>
              <h2>Devoluções</h2>
              {sale.returns.map((r: any) => (
                <div key={r.id} className="spread"><span>{fmtDateTime(r.createdAt)} — {r.refundMethod === 'VALE_TROCA' ? `vale-troca ${r.voucherCode}` : 'dinheiro'}</span><span className="num">{formatBRL(r.totalCents)}</span></div>
              ))}
            </div>
          )}
        </div>
      </div>

      {modal === 'cancel' && <CancelModal id={id} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'return' && <ReturnModal sale={sale} registerId={registerId} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    </div>
  );
}

function CancelModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [run, busy] = useAction(async () => {
    await api(`/sales/${id}/cancel`, { body: { reason } });
    toast('Venda cancelada');
    onDone();
  });
  return (
    <Modal title="Cancelar venda" onClose={onClose} footer={<button className="btn danger" disabled={busy || reason.trim().length < 15} onClick={() => run()}>Cancelar venda</button>}>
      <p>O estoque volta, as parcelas do crediário são canceladas e a NFC-e é cancelada na SEFAZ. A SEFAZ só aceita cancelar NFC-e logo após a emissão; depois disso, use troca/devolução.</p>
      <Field label="Justificativa (mínimo 15 caracteres)">
        <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function ReturnModal({ sale, registerId, onClose, onDone }: { sale: any; registerId: string | null; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<'VALE_TROCA' | 'DINHEIRO'>('VALE_TROCA');
  const [backToStock, setBack] = useState(true);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ totalCents: number; voucherCode: string | null } | null>(null);
  const [run, busy] = useAction(async () => {
    let cashSessionId: string | null = null;
    if (method === 'DINHEIRO') {
      if (!registerId) throw new Error('Defina o caixa deste computador na frente de caixa para devolver em dinheiro');
      const s = await api<{ id: string } | null>(`/cash/current?registerId=${registerId}`);
      if (!s) throw new Error('Abra o caixa para devolver em dinheiro');
      cashSessionId = s.id;
    }
    const items = Object.entries(qty).filter(([, q]) => q > 0).map(([saleItemId, quantity]) => ({ saleItemId, quantity, backToStock }));
    setResult(await api(`/sales/${sale.id}/returns`, { body: { items, refundMethod: method, cashSessionId, reason } }));
  });
  if (result)
    return (
      <Modal title="Devolução registrada" onClose={onDone} footer={<button className="btn primary" onClick={onDone}>Concluir</button>}>
        {result.voucherCode ? (
          <div className="display">
            <div className="lbl"><span>Vale-troca</span><span>{formatBRL(result.totalCents)}</span></div>
            <div className="total">{result.voucherCode}</div>
          </div>
        ) : (
          <p>Devolva {formatBRL(result.totalCents)} em dinheiro ao cliente. A saída foi lançada no caixa.</p>
        )}
      </Modal>
    );
  return (
    <Modal title="Troca / devolução" onClose={onClose} wide footer={<button className="btn primary" disabled={busy || !Object.values(qty).some((q) => q > 0)} onClick={() => run()}>Registrar devolução</button>}>
      <table className="table">
        <thead><tr><th>Item</th><th className="r">Vendido</th><th className="r">Devolver</th></tr></thead>
        <tbody>
          {sale.items.map((i: any) => {
            const max = i.quantity - i.returnedQty;
            return (
              <tr key={i.id}>
                <td>{i.description}</td>
                <td className="r num">{i.quantity}</td>
                <td className="r">
                  <input className="input num" style={{ width: 80 }} type="number" min={0} max={max} disabled={!max} value={qty[i.id] ?? 0} onChange={(e) => setQty((x) => ({ ...x, [i.id]: Math.min(max, Math.max(0, Number(e.target.value))) }))} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="grid cols-2">
        <Field label="Reembolso">
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value as 'VALE_TROCA' | 'DINHEIRO')}>
            <option value="VALE_TROCA">Vale-troca (crédito na loja)</option>
            <option value="DINHEIRO">Dinheiro (sai do caixa aberto)</option>
          </select>
        </Field>
        <Field label="Motivo"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: tamanho não serviu" /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={backToStock} onChange={(e) => setBack(e.target.checked)} /> Devolver as peças ao estoque (desmarque se houver defeito)</label>
    </Modal>
  );
}

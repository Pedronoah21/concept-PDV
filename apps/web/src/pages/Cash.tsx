import { useState } from 'react';
import { PAYMENT_LABELS, type PaymentMethod } from '@concept/shared';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Link } from '../lib/router';
import { kv } from '../lib/idb';
import { formatBRL, fmtDateTime } from '../lib/format';
import { Field, Input, Loading, Modal, MoneyInput, toast, useAction, useLoad } from '../components/ui';
import { connectSerialPrinter, getPrinterSettings, printReceipt, savePrinterSettings, type PrinterSettings } from '../lib/print';

const COUNT_METHODS: PaymentMethod[] = ['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO', 'OUTRO'];

interface Summary {
  session: { id: string; status: string; openedAt: string; closedAt: string | null; openingCents: number; register: string };
  salesCount: number;
  salesTotalCents: number;
  movements: { suprimento: number; sangria: number; devolucao: number };
  expected: Record<PaymentMethod, number> | null;
  counted: Record<string, number> | null;
  differenceCents: number | null;
}

export function CashPage() {
  const { registerId, register, can } = useSession();
  const current = useLoad<{ id: string } | null>(registerId ? `/cash/current?registerId=${registerId}` : null);
  const summary = useLoad<Summary>(current.data ? `/cash/${current.data.id}` : null, [current.data?.id]);
  const history = useLoad<any[]>(can('gerencia') ? '/cash/sessions' : null);
  const [modal, setModal] = useState<null | 'SANGRIA' | 'SUPRIMENTO' | 'close'>(null);
  const [closed, setClosed] = useState<Summary | null>(null);

  if (!registerId)
    return (
      <div className="panel">
        Este computador ainda não tem um caixa definido. <Link to="/pdv">Abra a frente de caixa</Link> para escolher.
      </div>
    );

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Caixa — {register?.name}</h1>
        {current.data && (
          <div className="row">
            <button className="btn" onClick={() => setModal('SUPRIMENTO')}>Suprimento</button>
            <button className="btn" onClick={() => setModal('SANGRIA')}>Sangria</button>
            <button className="btn primary" onClick={() => setModal('close')}>Fechar caixa</button>
          </div>
        )}
      </div>
      <Loading loading={current.loading} error={current.error} />
      {!current.loading && !current.data && !closed && (
        <div className="panel">
          Caixa fechado. <Link to="/pdv">Abra pela frente de caixa</Link> informando o fundo de troco.
        </div>
      )}
      {closed && <ClosedReport s={closed} />}
      {summary.data && current.data && (
        <div className="stats">
          <div className="stat">Aberto em<b>{fmtDateTime(summary.data.session.openedAt)}</b></div>
          <div className="stat">Vendas<b>{summary.data.salesCount}</b></div>
          <div className="stat">Faturado<b>{formatBRL(summary.data.salesTotalCents)}</b></div>
          <div className="stat">Fundo de troco<b>{formatBRL(summary.data.session.openingCents)}</b></div>
          {summary.data.expected && <div className="stat">Dinheiro esperado<b>{formatBRL(summary.data.expected.DINHEIRO)}</b></div>}
        </div>
      )}
      {summary.data && !summary.data.expected && current.data && (
        <p className="muted">Fechamento cego: o valor esperado aparece depois que você informar a contagem.</p>
      )}

      <PrinterSetup />

      {history.data && (
        <div className="panel flush">
          <div style={{ padding: 16 }}><h2>Fechamentos anteriores</h2></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Caixa</th><th>Abertura</th><th>Fechamento</th><th className="r">Diferença</th></tr></thead>
              <tbody>
                {history.data.map((s) => (
                  <tr key={s.id}>
                    <td>{s.register.name}</td>
                    <td>{fmtDateTime(s.openedAt)}</td>
                    <td>{s.closedAt ? fmtDateTime(s.closedAt) : <span className="tag warn">Aberto</span>}</td>
                    <td className={`r num ${s.differenceCents ? (s.differenceCents < 0 ? 'tag danger' : 'tag warn') : ''}`}>
                      {s.differenceCents == null ? '—' : formatBRL(s.differenceCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(modal === 'SANGRIA' || modal === 'SUPRIMENTO') && current.data && (
        <MovementModal type={modal} sessionId={current.data.id} onClose={() => setModal(null)} onDone={() => { setModal(null); summary.reload(); }} />
      )}
      {modal === 'close' && current.data && (
        <CloseModal
          sessionId={current.data.id}
          onClose={() => setModal(null)}
          onDone={async (s) => {
            setModal(null);
            setClosed(s);
            await kv.del(`cash:${registerId}`);
            current.setData(null);
          }}
        />
      )}
    </div>
  );
}

function MovementModal({ type, sessionId, onClose, onDone }: { type: 'SANGRIA' | 'SUPRIMENTO'; sessionId: string; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState('');
  const [run, busy] = useAction(async () => {
    await api(`/cash/${sessionId}/movements`, { body: { type, amountCents: amount, reason } });
    toast(type === 'SANGRIA' ? 'Sangria registrada' : 'Suprimento registrado');
    onDone();
  });
  return (
    <Modal title={type === 'SANGRIA' ? 'Sangria (retirada de dinheiro)' : 'Suprimento (entrada de dinheiro)'} onClose={onClose}
      footer={<button className="btn primary" disabled={busy || amount <= 0} onClick={() => run()}>Registrar</button>}>
      <Field label="Valor (R$)"><MoneyInput value={amount} onChange={setAmount} className="big-input" autoFocus /></Field>
      <Field label="Motivo"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={type === 'SANGRIA' ? 'Ex.: depósito no cofre' : 'Ex.: reforço de troco'} /></Field>
    </Modal>
  );
}

function CloseModal({ sessionId, onClose, onDone }: { sessionId: string; onClose: () => void; onDone: (s: Summary) => void }) {
  const [counted, setCounted] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  const [run, busy] = useAction(async () => {
    const s = await api<Summary>(`/cash/${sessionId}/close`, { body: { counted, notes } });
    onDone(s);
  });
  return (
    <Modal title="Fechar caixa" onClose={onClose}
      footer={<button className="btn primary" disabled={busy} onClick={() => confirm('Confirmar o fechamento do caixa?') && run()}>Fechar caixa</button>}>
      <p className="muted">Conte o dinheiro da gaveta e some os comprovantes de cada forma de pagamento.</p>
      <div className="grid cols-2">
        {COUNT_METHODS.map((m) => (
          <Field key={m} label={PAYMENT_LABELS[m]}>
            <MoneyInput value={counted[m] ?? 0} onChange={(c) => setCounted((x) => ({ ...x, [m]: c }))} />
          </Field>
        ))}
      </div>
      <Field label="Observações"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </Modal>
  );
}

function ClosedReport({ s }: { s: Summary }) {
  const diff = s.differenceCents ?? 0;
  return (
    <div className="panel stack">
      <h2>Caixa fechado</h2>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Forma</th><th className="r">Esperado</th><th className="r">Contado</th><th className="r">Diferença</th></tr></thead>
          <tbody>
            {COUNT_METHODS.map((m) => {
              const e = s.expected?.[m] ?? 0;
              const c = s.counted?.[m] ?? 0;
              return (
                <tr key={m}><td>{PAYMENT_LABELS[m]}</td><td className="r num">{formatBRL(e)}</td><td className="r num">{formatBRL(c)}</td><td className="r num">{formatBRL(c - e)}</td></tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={`notice ${diff === 0 ? 'go' : diff < 0 ? 'danger' : 'warn'}`}>
        {diff === 0 ? 'Caixa conferido sem diferença.' : diff < 0 ? `Faltaram ${formatBRL(-diff)}.` : `Sobraram ${formatBRL(diff)}.`}
      </div>
    </div>
  );
}

function PrinterSetup() {
  const [s, setS] = useState<PrinterSettings>(getPrinterSettings());
  const update = (patch: Partial<PrinterSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    savePrinterSettings(next);
  };
  const test = () =>
    printReceipt({
      company: { name: 'Teste de impressão', cnpj: '11222333000181' },
      saleNumber: 'TESTE',
      date: new Date().toISOString(),
      items: [{ code: '0001', description: 'Item de teste', quantity: 1, unitPriceCents: 100, discountCents: 0, totalCents: 100 }],
      grossCents: 100,
      discountCents: 0,
      totalCents: 100,
      payments: [{ method: 'DINHEIRO', amountCents: 100 }],
      changeCents: 0,
    }).catch((e) => toast((e as Error).message));
  return (
    <div className="panel stack">
      <h2>Impressora deste computador</h2>
      <div className="grid cols-3">
        <Field label="Como imprimir">
          <select className="input" value={s.mode} onChange={(e) => update({ mode: e.target.value as PrinterSettings['mode'] })}>
            <option value="navegador">Pelo driver instalado (qualquer impressora)</option>
            <option value="serial">Direto na térmica ESC/POS (Chrome/Edge)</option>
          </select>
        </Field>
        <Field label="Largura da bobina">
          <select className="input" value={s.paper} onChange={(e) => update({ paper: Number(e.target.value) as 80 | 58 })}>
            <option value={80}>80 mm</option>
            <option value={58}>58 mm</option>
          </select>
        </Field>
        <div className="stack" style={{ gap: 6, alignContent: 'end' }}>
          <label className="check"><input type="checkbox" checked={s.autoPrint} onChange={(e) => update({ autoPrint: e.target.checked })} /> Imprimir ao concluir a venda</label>
          {s.mode === 'serial' && <label className="check"><input type="checkbox" checked={s.openDrawer} onChange={(e) => update({ openDrawer: e.target.checked })} /> Abrir gaveta em vendas com dinheiro</label>}
        </div>
      </div>
      <div className="row">
        {s.mode === 'serial' && <button className="btn" onClick={() => connectSerialPrinter().then(() => toast('Impressora conectada')).catch((e) => toast(e.message))}>Conectar impressora</button>}
        <button className="btn" onClick={test}>Imprimir teste</button>
      </div>
    </div>
  );
}

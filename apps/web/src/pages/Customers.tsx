import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { fmtDate, fmtDateTime, formatBRL, formatCpfCnpj, onlyDigits } from '../lib/format';
import { Field, Input, Loading, Modal, MoneyInput, Status, toast, useAction, useLoad } from '../components/ui';

export function CustomersPage() {
  const [q, setQ] = useState('');
  const { data, error, loading } = useLoad<any[]>(`/customers?q=${encodeURIComponent(q)}`, [q]);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Clientes</h1>
        <div className="row">
          <Input placeholder="Nome, CPF ou telefone" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 280 }} />
          <Link className="btn primary" to="/clientes/novo">Novo cliente</Link>
        </div>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="panel flush table-wrap">
          <table className="table">
            <thead><tr><th>Nome</th><th>CPF/CNPJ</th><th>Telefone</th><th>Cidade</th><th className="r">Limite de crediário</th></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="click" onClick={() => navigate(`/clientes/${c.id}`)}>
                  <td>{c.name}</td>
                  <td>{c.document ? formatCpfCnpj(c.document) : '—'}</td>
                  <td>{c.phone ?? '—'}</td>
                  <td>{c.city ? `${c.city}/${c.uf ?? ''}` : '—'}</td>
                  <td className="r num">{formatBRL(c.creditLimitCents)}</td>
                </tr>
              ))}
              {!data.length && <tr><td colSpan={5} className="empty">Nenhum cliente encontrado.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const blank = { name: '', document: '', email: '', phone: '', birthDate: '', zip: '', street: '', number: '', complement: '', district: '', city: '', cityCode: '', uf: '', creditLimitCents: 0, notes: '' };

export function CustomerDetailPage({ id }: { id: string }) {
  const isNew = id === 'novo';
  const { can } = useSession();
  const detail = useLoad<any>(isNew ? null : `/customers/${id}`);
  const [f, setF] = useState({ ...blank });
  const [paying, setPaying] = useState<any | null>(null);

  useEffect(() => {
    if (detail.data) {
      const d = detail.data;
      setF(Object.fromEntries(Object.keys(blank).map((k) => [k, k === 'birthDate' ? (d.birthDate ? d.birthDate.slice(0, 10) : '') : (d[k] ?? (k === 'creditLimitCents' ? 0 : ''))])) as typeof blank);
    }
  }, [detail.data]);

  const set = (k: keyof typeof blank, v: unknown) => setF((x) => ({ ...x, [k]: v }));

  /** Preenche o endereço pelo CEP (ViaCEP). */
  const lookupCep = async (cep: string) => {
    const d = onlyDigits(cep);
    if (d.length !== 8) return;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${d}/json/`).then((x) => x.json());
      if (r.erro) return toast('CEP não encontrado');
      setF((x) => ({ ...x, street: r.logradouro || x.street, district: r.bairro || x.district, city: r.localidade, uf: r.uf, cityCode: r.ibge }));
    } catch {
      /* sem internet: preenche à mão */
    }
  };

  const [save, saving] = useAction(async () => {
    const body = { ...f, email: f.email || null, birthDate: f.birthDate || null };
    const saved = await api<any>(isNew ? '/customers' : `/customers/${id}`, { method: isNew ? 'POST' : 'PUT', body });
    toast('Cliente salvo');
    if (isNew) navigate(`/clientes/${saved.id}`, true);
    else detail.reload();
  });

  return (
    <div className="stack">
      <div className="page-head">
        <div><Link to="/clientes">Clientes</Link><h1>{isNew ? 'Novo cliente' : f.name}</h1></div>
        <button className="btn primary" disabled={saving} onClick={() => save()}>Salvar cliente</button>
      </div>
      {detail.data && (
        <div className="stats">
          <div className="stat">Em aberto no crediário<b>{formatBRL(detail.data.openCents)}</b></div>
          <div className="stat">Crédito disponível<b>{formatBRL(detail.data.availableCreditCents)}</b></div>
          <div className="stat">Compras recentes<b>{detail.data.sales.length}</b></div>
        </div>
      )}
      <div className="panel stack">
        <div className="grid cols-3">
          <Field label="Nome"><Input value={f.name} onChange={(e) => set('name', e.target.value)} required /></Field>
          <Field label="CPF/CNPJ"><Input value={f.document} onChange={(e) => set('document', e.target.value)} inputMode="numeric" /></Field>
          <Field label="Data de nascimento"><Input type="date" value={f.birthDate} onChange={(e) => set('birthDate', e.target.value)} /></Field>
          <Field label="Telefone / WhatsApp"><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field label="E-mail"><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
          {can('gerencia') && <Field label="Limite de crediário"><MoneyInput value={f.creditLimitCents} onChange={(c) => set('creditLimitCents', c)} /></Field>}
        </div>
        <div className="grid cols-4">
          <Field label="CEP"><Input value={f.zip} onChange={(e) => set('zip', e.target.value)} onBlur={(e) => lookupCep(e.target.value)} /></Field>
          <Field label="Rua"><Input value={f.street} onChange={(e) => set('street', e.target.value)} /></Field>
          <Field label="Número"><Input value={f.number} onChange={(e) => set('number', e.target.value)} /></Field>
          <Field label="Complemento"><Input value={f.complement} onChange={(e) => set('complement', e.target.value)} /></Field>
          <Field label="Bairro"><Input value={f.district} onChange={(e) => set('district', e.target.value)} /></Field>
          <Field label="Cidade"><Input value={f.city} onChange={(e) => set('city', e.target.value)} /></Field>
          <Field label="UF"><Input value={f.uf} maxLength={2} onChange={(e) => set('uf', e.target.value.toUpperCase())} /></Field>
        </div>
        <Field label="Observações"><textarea className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
      {detail.data && (
        <div className="grid cols-2">
          <div className="panel flush">
            <div style={{ padding: 16 }}><h2>Parcelas em aberto</h2></div>
            <InstallmentTable rows={detail.data.installments} onPay={setPaying} />
          </div>
          <div className="panel flush">
            <div style={{ padding: 16 }}><h2>Últimas compras</h2></div>
            <table className="table">
              <tbody>
                {detail.data.sales.map((s: any) => (
                  <tr key={s.id} className="click" onClick={() => navigate(`/vendas/${s.id}`)}><td className="num">{s.number}</td><td>{fmtDateTime(s.createdAt)}</td><td><Status s={s.status} /></td><td className="r num">{formatBRL(s.totalCents)}</td></tr>
                ))}
                {!detail.data.sales.length && <tr><td className="empty">Nenhuma compra ainda.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {paying && <PayInstallmentModal inst={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); detail.reload(); }} />}
    </div>
  );
}

function InstallmentTable({ rows, onPay, showCustomer }: { rows: any[]; onPay: (i: any) => void; showCustomer?: boolean }) {
  const now = new Date();
  return (
    <table className="table">
      <thead><tr>{showCustomer && <th>Cliente</th>}<th>Parcela</th><th>Vencimento</th><th className="r">Saldo</th><th /></tr></thead>
      <tbody>
        {rows.map((i) => {
          const late = new Date(i.dueDate) < now;
          const days = Math.floor((now.getTime() - new Date(i.dueDate).getTime()) / 86_400_000);
          return (
            <tr key={i.id}>
              {showCustomer && <td><Link to={`/clientes/${i.customerId}`}>{i.customer?.name}</Link>{i.customer?.phone && <div className="muted small">{i.customer.phone}</div>}</td>}
              <td>{i.number}/{i.of}{i.sale ? <span className="muted small"> venda {i.sale.number}</span> : null}</td>
              <td>{late ? <span className="tag danger">{fmtDate(i.dueDate)} — {days} dia(s) em atraso</span> : fmtDate(i.dueDate)}</td>
              <td className="r num">{formatBRL(i.amountCents - i.paidCents)}</td>
              <td className="r">
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  {showCustomer && late && i.customer?.phone && (
                    <a className="btn sm" target="_blank" rel="noreferrer" href={`https://wa.me/55${onlyDigits(i.customer.phone)}?text=${encodeURIComponent(`Olá, ${i.customer.name.split(' ')[0]}! Lembrete da parcela ${i.number}/${i.of} de ${formatBRL(i.amountCents - i.paidCents)}, vencida em ${fmtDate(i.dueDate)}.`)}`}>
                      Lembrar no WhatsApp
                    </a>
                  )}
                  <button className="btn sm primary" onClick={() => onPay(i)}>Receber</button>
                </div>
              </td>
            </tr>
          );
        })}
        {!rows.length && <tr><td colSpan={5} className="empty">Nenhuma parcela em aberto.</td></tr>}
      </tbody>
    </table>
  );
}

function PayInstallmentModal({ inst, onClose, onDone }: { inst: any; onClose: () => void; onDone: () => void }) {
  const { registerId } = useSession();
  const [amount, setAmount] = useState(inst.amountCents - inst.paidCents);
  const [method, setMethod] = useState('DINHEIRO');
  const [run, busy] = useAction(async () => {
    if (!registerId) throw new Error('Defina o caixa deste computador na frente de caixa');
    const s = await api<{ id: string } | null>(`/cash/current?registerId=${registerId}`);
    if (!s) throw new Error('Abra o caixa para receber parcelas');
    await api(`/installments/${inst.id}/pay`, { body: { amountCents: amount, method, cashSessionId: s.id } });
    toast('Parcela recebida');
    onDone();
  });
  return (
    <Modal title={`Receber parcela ${inst.number}/${inst.of}`} onClose={onClose} footer={<button className="btn go" disabled={busy || amount <= 0} onClick={() => run()}>Confirmar recebimento</button>}>
      <Field label="Valor (aceita pagamento parcial)"><MoneyInput value={amount} onChange={setAmount} className="big-input" autoFocus /></Field>
      <Field label="Forma">
        <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="DINHEIRO">Dinheiro</option>
          <option value="PIX">PIX</option>
          <option value="DEBITO">Débito</option>
          <option value="CREDITO">Crédito</option>
        </select>
      </Field>
    </Modal>
  );
}

export function CreditPage() {
  const [overdue, setOverdue] = useState(true);
  const { data, error, loading, reload } = useLoad<any[]>(`/installments${overdue ? '?overdue=1' : ''}`, [overdue]);
  const [paying, setPaying] = useState<any | null>(null);
  const total = data?.reduce((a, i) => a + i.amountCents - i.paidCents, 0) ?? 0;
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Crediário</h1>
        <label className="check"><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> Só parcelas vencidas</label>
      </div>
      {data && <p className="muted">{overdue ? 'Total vencido' : 'Total a receber'}: <b className="num">{formatBRL(total)}</b></p>}
      <Loading error={error} loading={loading && !data} />
      {data && <div className="panel flush table-wrap"><InstallmentTable rows={data} onPay={setPaying} showCustomer /></div>}
      {paying && <PayInstallmentModal inst={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); reload(); }} />}
    </div>
  );
}

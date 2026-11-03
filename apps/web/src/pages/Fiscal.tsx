import { useState } from 'react';
import { api } from '../lib/api';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { fmtDateTime, formatBRL } from '../lib/format';
import { Loading, Status, toast, useAction, useLoad } from '../components/ui';

export function FiscalPage() {
  const { me } = useSession();
  const [status, setStatus] = useState('');
  const { data, error, loading, reload } = useLoad<any[]>(`/fiscal${status ? `?status=${status}` : ''}`, [status]);
  const [retry, busy] = useAction(async (id: string) => {
    const d = await api<any>(`/fiscal/${id}/retry`, { method: 'POST' });
    toast(d.status === 'AUTORIZADA' ? 'Nota autorizada' : d.message ?? 'Reenviada');
    reload();
  });
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Notas fiscais</h1>
          <p className="muted">
            Emissor: {me!.company.fiscalProvider === 'mock' ? 'simulador (sem valor fiscal)' : 'Focus NFe'}
            {me!.company.fiscalProvider !== 'mock' && `, ambiente de ${me!.company.fiscalEnv === 'PRODUCAO' ? 'produção' : 'homologação'}`}.{' '}
            {me!.user.role === 'ADMIN' && <Link to="/configuracoes">Alterar</Link>}
          </p>
        </div>
        <select className="input" style={{ width: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas</option>
          <option value="PENDENTE">Pendentes</option>
          <option value="REJEITADA">Rejeitadas</option>
          <option value="ERRO">Com erro</option>
          <option value="AUTORIZADA">Autorizadas</option>
          <option value="CANCELADA">Canceladas</option>
        </select>
      </div>
      {me!.company.fiscalProvider === 'mock' && (
        <div className="notice warn">O simulador autoriza tudo na hora para treino. Para emitir de verdade, configure a Focus NFe com o certificado digital da loja.</div>
      )}
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="panel flush table-wrap">
          <table className="table">
            <thead><tr><th>Emissão</th><th>Modelo</th><th>Número</th><th>Venda</th><th>Situação</th><th>Mensagem</th><th className="r">Valor</th><th /></tr></thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id}>
                  <td>{fmtDateTime(d.createdAt)}</td>
                  <td>{d.model === 'NFCE' ? 'NFC-e' : 'NF-e'}</td>
                  <td className="num">{d.number ?? '—'}</td>
                  <td><Link to={`/vendas/${d.saleId}`}>{d.sale.number}</Link></td>
                  <td><Status s={d.status} /></td>
                  <td className="small" style={{ maxWidth: 360 }}>{d.message ?? ''}{d.attempts > 1 ? ` (${d.attempts} tentativas)` : ''}</td>
                  <td className="r num">{formatBRL(d.sale.totalCents)}</td>
                  <td className="r">
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      {d.danfeUrl && <a className="btn sm" href={d.danfeUrl} target="_blank" rel="noreferrer">DANFE</a>}
                      {d.xmlUrl && <a className="btn sm" href={d.xmlUrl} target="_blank" rel="noreferrer">XML</a>}
                      {['PENDENTE', 'ERRO', 'REJEITADA'].includes(d.status) && <button className="btn sm" disabled={busy} onClick={() => retry(d.id)}>Enviar novamente</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {!data.length && <tr><td colSpan={8} className="empty">Nenhuma nota neste filtro.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Rejeitada por dados do produto (NCM, CFOP, tributação)? Corrija o cadastro do produto e envie novamente.</p>
    </div>
  );
}

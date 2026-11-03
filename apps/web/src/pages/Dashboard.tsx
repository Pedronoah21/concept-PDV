import { useState } from 'react';
import { PAYMENT_LABELS, type PaymentMethod } from '@concept/shared';
import { Link } from '../lib/router';
import { daysAgo, formatBRL, today } from '../lib/format';
import { Field, Input, Loading, useLoad } from '../components/ui';

interface Summary {
  salesCount: number;
  revenueCents: number;
  grossProfitCents: number;
  marginPct: number;
  ticketCents: number;
  discountCents: number;
  byPayment: { method: PaymentMethod; totalCents: number }[];
  byDay: { day: string; totalCents: number; count: number }[];
  byChannel: { channel: string; totalCents: number; count: number }[];
  topProducts: { description: string; quantity: number; totalCents: number; profitCents: number }[];
  alerts: { needsReview: number; pendingFiscal: number };
}

export function DashboardPage() {
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(today());
  const { data, error, loading } = useLoad<Summary>(`/reports/summary?from=${from}&to=${to}`, [from, to]);
  const low = useLoad<any[]>('/stock?low=1');
  const abc = useLoad<any[]>(`/reports/abc?from=${from}&to=${to}`, [from, to]);
  const stale = useLoad<any[]>('/reports/stale?days=60');
  const maxDay = Math.max(1, ...(data?.byDay.map((d) => d.totalCents) ?? [1]));
  const maxPay = Math.max(1, ...(data?.byPayment.map((d) => d.totalCents) ?? [1]));

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Painel</h1>
        <div className="row">
          <Field label="De"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Até"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <>
          {(data.alerts.needsReview > 0 || data.alerts.pendingFiscal > 0) && (
            <div className="row">
              {data.alerts.needsReview > 0 && <Link className="notice warn" to="/vendas?review=1">{data.alerts.needsReview} venda(s) offline com desconto ou crediário acima do limite aguardam sua revisão</Link>}
              {data.alerts.pendingFiscal > 0 && <Link className="notice danger" to="/fiscal">{data.alerts.pendingFiscal} nota(s) fiscal(is) pendente(s) ou com erro</Link>}
            </div>
          )}
          <div className="stats">
            <div className="stat">Faturamento<b>{formatBRL(data.revenueCents)}</b></div>
            <div className="stat">Vendas<b>{data.salesCount}</b></div>
            <div className="stat">Ticket médio<b>{formatBRL(data.ticketCents)}</b></div>
            <div className="stat">Lucro bruto<b>{formatBRL(data.grossProfitCents)}</b><span className="muted small">margem {data.marginPct.toFixed(1)}%</span></div>
            <div className="stat">Descontos concedidos<b>{formatBRL(data.discountCents)}</b></div>
          </div>
          <div className="grid cols-2">
            <div className="panel stack">
              <h2>Faturamento por dia</h2>
              {data.byDay.length ? (
                <div className="daychart" role="img" aria-label="Gráfico de faturamento diário">
                  {data.byDay.map((d) => (
                    <div key={d.day} style={{ height: `${(d.totalCents / maxDay) * 100}%` }} title={`${new Date(d.day).toLocaleDateString('pt-BR')}: ${formatBRL(d.totalCents)} em ${d.count} venda(s)`} />
                  ))}
                </div>
              ) : <div className="empty">Sem vendas no período.</div>}
            </div>
            <div className="panel stack">
              <h2>Formas de pagamento</h2>
              <div className="bars">
                {data.byPayment.map((p) => (
                  <div key={p.method} className="bar">
                    <span>{PAYMENT_LABELS[p.method] ?? p.method}</span>
                    <i style={{ width: `${(p.totalCents / maxPay) * 100}%` }} />
                    <span className="r num">{formatBRL(p.totalCents)}</span>
                  </div>
                ))}
              </div>
              {data.byChannel.length > 1 && (
                <p className="muted small">
                  {data.byChannel.map((c) => `${c.channel === 'ONLINE' ? 'Loja online' : 'Balcão'}: ${formatBRL(c.totalCents)}`).join('; ')}
                </p>
              )}
            </div>
          </div>
          <div className="grid cols-2">
            <div className="panel flush">
              <div style={{ padding: 16 }}><h2>Mais vendidos</h2></div>
              <table className="table">
                <thead><tr><th>Produto</th><th className="r">Qtd.</th><th className="r">Faturado</th><th className="r">Lucro</th></tr></thead>
                <tbody>
                  {data.topProducts.map((t) => (
                    <tr key={t.description}><td>{t.description}</td><td className="r num">{t.quantity}</td><td className="r num">{formatBRL(t.totalCents)}</td><td className="r num">{formatBRL(t.profitCents)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel flush">
              <div style={{ padding: 16 }} className="spread"><h2>Estoque baixo</h2><Link to="/estoque">Ver estoque</Link></div>
              <table className="table">
                <thead><tr><th>Produto</th><th className="r">Saldo</th><th className="r">Mínimo</th></tr></thead>
                <tbody>
                  {(low.data ?? []).slice(0, 12).map((r) => (
                    <tr key={r.variantId}><td>{r.name} <span className="muted">{[r.color, r.size].filter(Boolean).join(' / ')}</span></td><td className="r num">{r.quantity}</td><td className="r num">{r.minStock}</td></tr>
                  ))}
                  {low.data && !low.data.length && <tr><td colSpan={3} className="empty">Nenhum produto abaixo do mínimo.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div className="grid cols-2">
            <div className="panel flush">
              <div style={{ padding: 16 }}><h2>Curva ABC</h2><p className="muted small">A: produtos que somam 80% do faturamento. Nunca deixe faltar.</p></div>
              <table className="table">
                <thead><tr><th>Classe</th><th>Produto</th><th className="r">Faturado</th></tr></thead>
                <tbody>
                  {(abc.data ?? []).slice(0, 15).map((r) => (
                    <tr key={r.productId}><td><span className={`tag ${r.class === 'A' ? 'go' : r.class === 'B' ? 'warn' : ''}`}>{r.class}</span></td><td>{r.name}</td><td className="r num">{formatBRL(r.totalCents)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel flush">
              <div style={{ padding: 16 }}><h2>Parados há 60 dias</h2><p className="muted small">Com estoque e sem venda. Bons candidatos a promoção.</p></div>
              <table className="table">
                <thead><tr><th>Produto</th><th className="r">Saldo</th><th className="r">Capital parado</th></tr></thead>
                <tbody>
                  {(stale.data ?? []).slice(0, 15).map((r) => (
                    <tr key={r.variantId}><td>{r.name} <span className="muted">{[r.color, r.size].filter(Boolean).join(' / ')}</span></td><td className="r num">{r.quantity}</td><td className="r num">{formatBRL(r.quantity * r.avgCostCents)}</td></tr>
                  ))}
                  {stale.data && !stale.data.length && <tr><td colSpan={3} className="empty">Nenhum produto parado.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

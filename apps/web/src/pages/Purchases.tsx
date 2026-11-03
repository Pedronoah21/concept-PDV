import { useState } from 'react';
import { splitInstallments } from '@concept/shared';
import { api } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { fmtDate, formatBRL, formatCpfCnpj, variantLabel } from '../lib/format';
import { Field, Input, Loading, MoneyInput, toast, toastError, useAction, useLoad } from '../components/ui';

export function PurchasesPage() {
  const { data, error, loading } = useLoad<any[]>('/purchases');
  const payables = useLoad<any[]>('/payables');
  const [pay] = useAction(async (id: string) => {
    await api(`/payables/${id}/pay`, { method: 'POST' });
    payables.reload();
  });
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Entrada de mercadoria</h1>
        <Link className="btn primary" to="/compras/nova">Lançar entrada</Link>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="panel flush table-wrap">
          <table className="table">
            <thead><tr><th>Data</th><th>Fornecedor</th><th>Nota</th><th className="r">Itens</th><th className="r">Total</th></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}><td>{fmtDate(p.createdAt)}</td><td>{p.supplier?.name ?? '—'}</td><td>{p.invoiceNumber ?? '—'}</td><td className="r num">{p._count.items}</td><td className="r num">{formatBRL(p.totalCents)}</td></tr>
              ))}
              {!data.length && <tr><td colSpan={5} className="empty">Nenhuma entrada lançada. Importe o XML da nota do fornecedor para começar.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {payables.data && payables.data.length > 0 && (
        <div className="panel flush">
          <div style={{ padding: 16 }}><h2>Contas a pagar</h2></div>
          <table className="table">
            <thead><tr><th>Vencimento</th><th>Descrição</th><th className="r">Valor</th><th /></tr></thead>
            <tbody>
              {payables.data.map((p) => (
                <tr key={p.id}>
                  <td>{new Date(p.dueDate) < new Date() ? <span className="tag danger">{fmtDate(p.dueDate)}</span> : fmtDate(p.dueDate)}</td>
                  <td>{p.description}</td>
                  <td className="r num">{formatBRL(p.amountCents)}</td>
                  <td className="r"><button className="btn sm" onClick={() => pay(p.id)}>Marcar como paga</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface Item {
  key: string;
  variantId: string | null;
  label: string;
  quantity: number;
  unitCostCents: number;
  /** Dados vindos do XML, para criar o produto se ainda não existir */
  xml?: { description: string; barcode: string | null; ncm: string | null; cest: string | null; supplierCode: string; fractional: boolean };
}

export function PurchaseFormPage() {
  const { me, store } = useSession();
  const suppliers = useLoad<any[]>('/suppliers');
  const [storeId, setStoreId] = useState(store?.id ?? me!.stores[0]?.id);
  const [supplierId, setSupplierId] = useState('');
  const [invoice, setInvoice] = useState('');
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const [issuedAt, setIssuedAt] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [freight, setFreight] = useState(0);
  const [other, setOther] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [installments, setInstallments] = useState(0);
  const [firstDue, setFirstDue] = useState(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<any[]>([]);

  const productsCents = items.reduce((a, i) => a + i.quantity * i.unitCostCents, 0);
  const total = productsCents + freight + other - discount;

  const importXml = async (file: File) => {
    try {
      const xml = await file.text();
      const r = await api<any>('/purchases/parse-xml', { body: { xml } });
      if (r.alreadyImported) toast('Atenção: esta nota já foi lançada antes');
      let sid = r.supplierId;
      if (!sid && r.supplier.document) {
        const s = await api<any>('/suppliers', { body: { name: r.supplier.tradeName || r.supplier.name, document: r.supplier.document } });
        sid = s.id;
        await suppliers.reload();
      }
      setSupplierId(sid ?? '');
      setInvoice(r.number ?? '');
      setAccessKey(r.accessKey);
      setIssuedAt(r.issuedAt);
      setFreight(r.freightCents);
      setOther(r.otherCents);
      setDiscount(r.discountCents);
      setItems(
        r.items.map((i: any, k: number) => ({
          key: String(k),
          variantId: i.variantId,
          label: i.matchedName ?? i.description,
          quantity: i.quantity,
          unitCostCents: i.unitCostCents,
          xml: { description: i.description, barcode: i.barcode, ncm: i.ncm, cest: i.cest, supplierCode: i.supplierCode, fractional: i.fractional },
        })),
      );
      toast(`${r.items.length} item(ns) lidos da nota de ${r.supplier.name}`);
    } catch (e) {
      toastError(e);
    }
  };

  /** Cadastra como produto novo cada item da nota que não foi reconhecido. */
  const [createMissing, creating] = useAction(async () => {
    const next = [...items];
    for (const [k, it] of next.entries()) {
      if (it.variantId || !it.xml) continue;
      const markup = Math.round(it.unitCostCents * 2); // preço sugerido: 100% sobre o custo (ajuste depois)
      const p = await api<any>('/products', {
        body: {
          name: it.xml.description,
          ncm: it.xml.ncm && /^\d{8}$/.test(it.xml.ncm) ? it.xml.ncm : '00000000',
          cest: it.xml.cest,
          variants: [{ barcode: it.xml.barcode, priceCents: markup, minStock: 1 }],
        },
      });
      next[k] = { ...it, variantId: p.variants[0].id, label: p.name };
    }
    setItems(next);
    toast('Produtos cadastrados. Revise os preços de venda depois.');
  });

  const doSearch = async (term: string) => {
    setSearch(term);
    if (term.length < 2) return setFound([]);
    setFound(await api<any[]>(`/products?q=${encodeURIComponent(term)}`));
  };

  const [save, saving] = useAction(async () => {
    if (items.some((i) => !i.variantId)) throw new Error('Há itens sem produto vinculado. Cadastre-os antes de lançar.');
    const parts = installments > 0 ? splitInstallments(total, installments) : [];
    const payables = parts.map((amountCents, i) => {
      const d = new Date(`${firstDue}T12:00:00`);
      d.setMonth(d.getMonth() + i);
      return { amountCents, dueDate: d.toISOString() };
    });
    await api('/purchases', {
      body: {
        storeId,
        supplierId: supplierId || null,
        invoiceNumber: invoice || null,
        accessKey,
        issuedAt,
        freightCents: freight,
        otherCents: other,
        discountCents: discount,
        items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity, unitCostCents: i.unitCostCents })),
        payables,
      },
    });
    toast('Entrada lançada. Estoque e custo médio atualizados.');
    navigate('/compras');
  });

  const missing = items.filter((i) => !i.variantId).length;

  return (
    <div className="stack">
      <div className="page-head">
        <div><Link to="/compras">Entrada de mercadoria</Link><h1>Lançar entrada</h1></div>
        <label className="btn primary">
          Importar XML da NF-e do fornecedor
          <input type="file" accept=".xml,text/xml" hidden onChange={(e) => e.target.files?.[0] && importXml(e.target.files[0])} />
        </label>
      </div>

      <div className="panel stack">
        <div className="grid cols-4">
          <Field label="Fornecedor">
            <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Sem fornecedor</option>
              {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.document ? ` (${formatCpfCnpj(s.document)})` : ''}</option>)}
            </select>
          </Field>
          <Field label="Número da nota"><Input value={invoice} onChange={(e) => setInvoice(e.target.value)} /></Field>
          <Field label="Loja que recebe">
            <select className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              {me!.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          {accessKey && <Field label="Chave da NF-e"><Input value={accessKey} readOnly /></Field>}
        </div>
      </div>

      <div className="panel stack">
        <div className="spread">
          <h2>Itens</h2>
          {missing > 0 && <button className="btn" disabled={creating} onClick={() => createMissing()}>Cadastrar {missing} produto(s) novo(s) da nota</button>}
        </div>
        <div style={{ position: 'relative' }}>
          <Input placeholder="Adicionar produto: nome ou código de barras" value={search} onChange={(e) => doSearch(e.target.value)} />
          {found.length > 0 && (
            <div className="suggest" style={{ top: 44, left: 0, right: 0 }}>
              {found.flatMap((p) =>
                p.variants.map((v: any) => (
                  <button key={v.id} onMouseDown={() => { setItems((xs) => [...xs, { key: v.id + Date.now(), variantId: v.id, label: `${p.name} ${variantLabel(v)}`, quantity: 1, unitCostCents: v.avgCostCents ?? 0 }]); setSearch(''); setFound([]); }}>
                    <span>{p.name} <span className="muted">{variantLabel(v)}</span></span>
                    <span className="muted small">{v.barcode}</span>
                  </button>
                )),
              )}
            </div>
          )}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Produto</th><th>Qtd.</th><th>Custo unitário</th><th className="r">Total</th><th /></tr></thead>
            <tbody>
              {items.map((it, k) => (
                <tr key={it.key}>
                  <td>
                    {it.label}
                    {!it.variantId && <span className="tag danger" style={{ marginLeft: 6 }}>não cadastrado</span>}
                    {it.xml?.fractional && <span className="tag warn" style={{ marginLeft: 6 }}>quantidade fracionada arredondada</span>}
                  </td>
                  <td><Input type="number" min={1} value={it.quantity} style={{ width: 80 }} onChange={(e) => setItems((xs) => xs.map((x, i) => (i === k ? { ...x, quantity: Number(e.target.value) } : x)))} /></td>
                  <td><MoneyInput value={it.unitCostCents} style={{ width: 110 }} onChange={(c) => setItems((xs) => xs.map((x, i) => (i === k ? { ...x, unitCostCents: c } : x)))} /></td>
                  <td className="r num">{formatBRL(it.quantity * it.unitCostCents)}</td>
                  <td><button className="btn ghost sm" aria-label="Remover item" onClick={() => setItems((xs) => xs.filter((_, i) => i !== k))}>✕</button></td>
                </tr>
              ))}
              {!items.length && <tr><td colSpan={5} className="empty">Importe o XML ou adicione os produtos manualmente.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="panel stack">
          <h2>Custos adicionais</h2>
          <p className="muted small">Frete e despesas são rateados no custo de cada item, pelo valor.</p>
          <div className="grid cols-3">
            <Field label="Frete"><MoneyInput value={freight} onChange={setFreight} /></Field>
            <Field label="Outras despesas"><MoneyInput value={other} onChange={setOther} /></Field>
            <Field label="Desconto"><MoneyInput value={discount} onChange={setDiscount} /></Field>
          </div>
        </div>
        <div className="panel stack">
          <h2>Pagamento ao fornecedor</h2>
          <div className="grid cols-2">
            <Field label="Parcelas a pagar">
              <select className="input" value={installments} onChange={(e) => setInstallments(Number(e.target.value))}>
                <option value={0}>Já paga / não lançar</option>
                {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}x de {formatBRL(Math.ceil(total / n))}</option>)}
              </select>
            </Field>
            {installments > 0 && <Field label="Primeiro vencimento"><Input type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} /></Field>}
          </div>
          <div className="remaining"><span>Total da entrada</span><span>{formatBRL(total)}</span></div>
          <button className="btn go lg" disabled={saving || !items.length} onClick={() => save()}>Lançar entrada no estoque</button>
        </div>
      </div>
    </div>
  );
}

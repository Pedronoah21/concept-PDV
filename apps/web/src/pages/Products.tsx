import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { formatBRL } from '../lib/format';
import { Field, Input, Loading, MoneyInput, toast, useAction, useLoad } from '../components/ui';

export function ProductsPage() {
  const { can, store } = useSession();
  const [q, setQ] = useState('');
  const { data, error, loading } = useLoad<any[]>(`/products?q=${encodeURIComponent(q)}${store ? `&storeId=${store.id}` : ''}`, [q]);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Produtos</h1>
        <div className="row">
          <Input placeholder="Nome, marca, código ou código de barras" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 320 }} />
          {can('gerencia') && <Link className="btn primary" to="/produtos/novo">Novo produto</Link>}
        </div>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="panel flush table-wrap">
          <table className="table">
            <thead><tr><th>Código</th><th>Produto</th><th>Categoria</th><th>Variações</th><th className="r">Estoque</th><th className="r">Preço</th></tr></thead>
            <tbody>
              {data.map((p) => {
                const prices = p.variants.map((v: any) => v.priceCents);
                const min = Math.min(...prices);
                const max = Math.max(...prices);
                return (
                  <tr key={p.id} className="click" onClick={() => navigate(`/produtos/${p.id}`)}>
                    <td className="num">{p.code ?? '—'}</td>
                    <td><b>{p.name}</b> {p.brand && <span className="muted">{p.brand}</span>}</td>
                    <td>{p.category?.name ?? '—'}</td>
                    <td>{p.variants.length}</td>
                    <td className="r num">{p.variants.reduce((a: number, v: any) => a + v.stock, 0)}</td>
                    <td className="r num">{min === max ? formatBRL(min) : `${formatBRL(min)} a ${formatBRL(max)}`}</td>
                  </tr>
                );
              })}
              {!data.length && <tr><td colSpan={6} className="empty">Nenhum produto encontrado. Cadastre o primeiro ou importe pelo XML de uma nota de compra.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface VariantForm {
  id?: string;
  sku?: string;
  barcode: string;
  color: string;
  size: string;
  priceCents: number;
  promoPriceCents: number | null;
  minStock: number;
  active: boolean;
  initialStock?: number;
  initialCostCents?: number;
}

const emptyProduct = {
  code: '',
  name: '',
  description: '',
  brand: '',
  categoryId: '',
  unit: 'UN',
  imageUrl: '',
  onlineVisible: true,
  active: true,
  ncm: '',
  cest: '',
  origin: 0,
  cfop: '5102',
  csosn: '102',
  cstIcms: '',
  icmsRate: 0,
  cstPis: '49',
  cstCofins: '49',
};

export function ProductFormPage({ id }: { id?: string }) {
  const { store } = useSession();
  const categories = useLoad<any[]>('/categories');
  const [p, setP] = useState({ ...emptyProduct });
  const [variants, setVariants] = useState<VariantForm[]>([{ barcode: '', color: '', size: '', priceCents: 0, promoPriceCents: null, minStock: 2, active: true, initialStock: 0, initialCostCents: 0 }]);
  const [colors, setColors] = useState('');
  const [sizes, setSizes] = useState('');
  const [newCat, setNewCat] = useState('');

  useEffect(() => {
    if (!id) return;
    api<any>(`/products/${id}`).then((d) => {
      setP({ ...emptyProduct, ...Object.fromEntries(Object.entries(d).filter(([k]) => k in emptyProduct).map(([k, v]) => [k, v ?? ''])) } as typeof emptyProduct);
      setVariants(d.variants.filter((v: any) => v.active).map((v: any) => ({ id: v.id, sku: v.sku, barcode: v.barcode ?? '', color: v.color ?? '', size: v.size ?? '', priceCents: v.priceCents, promoPriceCents: v.promoPriceCents, minStock: v.minStock, active: v.active })));
    });
  }, [id]);

  const set = (k: keyof typeof emptyProduct, v: unknown) => setP((x) => ({ ...x, [k]: v }));
  const setV = (i: number, patch: Partial<VariantForm>) => setVariants((vs) => vs.map((v, k) => (k === i ? { ...v, ...patch } : v)));

  /** Gera a grade cor × tamanho de uma vez. */
  const generateGrid = () => {
    const cs = colors.split(',').map((s) => s.trim()).filter(Boolean);
    const ss = sizes.split(',').map((s) => s.trim()).filter(Boolean);
    const price = variants[0]?.priceCents ?? 0;
    const cost = variants[0]?.initialCostCents ?? 0;
    const combos = (cs.length ? cs : ['']).flatMap((c) => (ss.length ? ss : ['']).map((s) => ({ c, s })));
    const existing = variants.filter((v) => v.id);
    const add = combos
      .filter(({ c, s }) => !existing.some((v) => v.color === c && v.size === s))
      .map(({ c, s }) => ({ barcode: '', color: c, size: s, priceCents: price, promoPriceCents: null, minStock: 2, active: true, initialStock: 0, initialCostCents: cost }));
    setVariants([...existing, ...add]);
  };

  const [save, saving] = useAction(async () => {
    const body = {
      ...p,
      categoryId: p.categoryId || null,
      description: p.description || null,
      brand: p.brand || null,
      code: p.code || null,
      imageUrl: p.imageUrl || null,
      cest: p.cest || null,
      cstIcms: p.cstIcms || null,
      storeId: store?.id,
      variants: variants.map(({ sku: _sku, ...v }) => ({ ...v, barcode: v.barcode || null, color: v.color || null, size: v.size || null })),
    };
    const saved = await api<any>(id ? `/products/${id}` : '/products', { method: id ? 'PUT' : 'POST', body });
    toast('Produto salvo');
    navigate(`/produtos/${saved.id}`, true);
  });

  const [addCat] = useAction(async () => {
    const c = await api<any>('/categories', { body: { name: newCat } });
    await categories.reload();
    set('categoryId', c.id);
    setNewCat('');
  });

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div className="page-head">
        <div>
          <Link to="/produtos">Produtos</Link>
          <h1>{id ? `${p.code ? p.code + ' ' : ''}${p.name}` || 'Produto' : 'Novo produto'}</h1>
        </div>
        <button className="btn primary" disabled={saving}>Salvar produto</button>
      </div>

      <div className="panel stack">
        <h2>Dados do produto</h2>
        <div className="grid cols-4">
          <Field label="Código do produto" hint="Deixe em branco para gerar automaticamente.">
            <Input value={p.code} maxLength={30} placeholder="Ex.: CAM010" onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9._/-]/g, ''))} />
          </Field>
          <Field label="Nome"><Input required value={p.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Marca"><Input value={p.brand} onChange={(e) => set('brand', e.target.value)} /></Field>
          <Field label="Categoria">
            <select className="input" value={p.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">Sem categoria</option>
              {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="row">
          <Input placeholder="Nova categoria" value={newCat} onChange={(e) => setNewCat(e.target.value)} style={{ width: 220 }} />
          <button type="button" className="btn sm" disabled={newCat.length < 2} onClick={() => addCat()}>Criar categoria</button>
        </div>
        <Field label="Endereço da foto (aparece na loja online)" hint="Link de uma imagem já hospedada, como a do catálogo do fornecedor.">
          <Input type="url" value={p.imageUrl} onChange={(e) => set('imageUrl', e.target.value)} placeholder="https://" />
        </Field>
        <Field label="Descrição (aparece na loja online)">
          <textarea className="input" rows={2} value={p.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <div className="row">
          <label className="check"><input type="checkbox" checked={p.onlineVisible} onChange={(e) => set('onlineVisible', e.target.checked)} /> Vender na loja online</label>
          <label className="check"><input type="checkbox" checked={p.active} onChange={(e) => set('active', e.target.checked)} /> Ativo</label>
        </div>
      </div>

      <div className="panel stack">
        <h2>Tributação</h2>
        <p className="muted small">Necessário para emitir NFC-e/NF-e. Confirme os códigos com o contador da loja.</p>
        <div className="grid cols-4">
          <Field label="NCM (8 dígitos)"><Input required pattern="\d{8}" value={p.ncm} onChange={(e) => set('ncm', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="CEST"><Input value={p.cest} onChange={(e) => set('cest', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="CFOP"><Input value={p.cfop} onChange={(e) => set('cfop', e.target.value)} /></Field>
          <Field label="Origem">
            <select className="input" value={p.origin} onChange={(e) => set('origin', Number(e.target.value))}>
              <option value={0}>0 — Nacional</option>
              <option value={1}>1 — Importação direta</option>
              <option value={2}>2 — Importada, mercado interno</option>
            </select>
          </Field>
          <Field label="CSOSN (Simples Nacional)"><Input value={p.csosn} onChange={(e) => set('csosn', e.target.value)} /></Field>
          <Field label="CST ICMS (regime normal)"><Input value={p.cstIcms} onChange={(e) => set('cstIcms', e.target.value)} /></Field>
          <Field label="Alíquota ICMS (%)">
            <Input inputMode="decimal" value={(p.icmsRate / 100).toString().replace('.', ',')} onChange={(e) => set('icmsRate', Math.round(Number(e.target.value.replace(',', '.')) * 100) || 0)} />
          </Field>
          <Field label="Unidade"><Input value={p.unit} onChange={(e) => set('unit', e.target.value.toUpperCase())} /></Field>
        </div>
      </div>

      <div className="panel stack">
        <div className="spread">
          <h2>Grade e preços</h2>
          <button type="button" className="btn sm" onClick={() => setVariants((vs) => [...vs, { barcode: '', color: '', size: '', priceCents: vs[0]?.priceCents ?? 0, promoPriceCents: null, minStock: 2, active: true, initialStock: 0, initialCostCents: 0 }])}>
            Adicionar variação
          </button>
        </div>
        <div className="grid cols-3" style={{ alignItems: 'end' }}>
          <Field label="Cores (separadas por vírgula)"><Input placeholder="Branca, Preta, Azul" value={colors} onChange={(e) => setColors(e.target.value)} /></Field>
          <Field label="Tamanhos (separados por vírgula)"><Input placeholder="P, M, G, GG" value={sizes} onChange={(e) => setSizes(e.target.value)} /></Field>
          <button type="button" className="btn" onClick={generateGrid}>Gerar grade</button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Cor</th><th>Tamanho</th><th>Código de barras</th><th>Preço</th><th>Promoção</th><th>Mínimo</th>{!id && <><th>Saldo inicial</th><th>Custo</th></>}<th /></tr>
            </thead>
            <tbody>
              {variants.map((v, i) => (
                <tr key={v.id ?? i}>
                  <td><Input value={v.color} onChange={(e) => setV(i, { color: e.target.value })} /></td>
                  <td><Input value={v.size} onChange={(e) => setV(i, { size: e.target.value })} style={{ width: 70 }} /></td>
                  <td><Input value={v.barcode} placeholder="Gerado se vazio" onChange={(e) => setV(i, { barcode: e.target.value.replace(/\D/g, '') })} /></td>
                  <td><MoneyInput value={v.priceCents} onChange={(c) => setV(i, { priceCents: c })} style={{ width: 100 }} /></td>
                  <td><MoneyInput value={v.promoPriceCents ?? 0} onChange={(c) => setV(i, { promoPriceCents: c || null })} style={{ width: 100 }} /></td>
                  <td><Input type="number" min={0} value={v.minStock} onChange={(e) => setV(i, { minStock: Number(e.target.value) })} style={{ width: 70 }} /></td>
                  {!id && (
                    <>
                      <td><Input type="number" min={0} value={v.initialStock ?? 0} onChange={(e) => setV(i, { initialStock: Number(e.target.value) })} style={{ width: 80 }} /></td>
                      <td><MoneyInput value={v.initialCostCents ?? 0} onChange={(c) => setV(i, { initialCostCents: c })} style={{ width: 100 }} /></td>
                    </>
                  )}
                  <td>
                    {variants.length > 1 && <button type="button" className="btn ghost sm" aria-label="Remover variação" onClick={() => setVariants((vs) => vs.filter((_, k) => k !== i))}>✕</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {id && <p className="muted small">O estoque muda só por entrada de mercadoria, venda, devolução ou ajuste na tela Estoque — assim todo movimento fica registrado.</p>}
      </div>
    </form>
  );
}

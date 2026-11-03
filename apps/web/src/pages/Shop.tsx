import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { formatBRL, onlyDigits } from '../lib/format';
import { Field, Input, Loading, Modal, toast, toastError } from '../components/ui';

interface ShopProduct {
  id: string;
  name: string;
  description: string | null;
  brand: string | null;
  category: string | null;
  imageUrl: string | null;
  variants: { id: string; color: string | null; size: string | null; priceCents: number; finalPriceCents: number; available: number }[];
}
interface CartItem {
  variantId: string;
  name: string;
  label: string;
  priceCents: number;
  quantity: number;
  max: number;
}

/** Loja online pública: /loja/<slug>. Usa o mesmo estoque do PDV, com reserva no pedido. */
export function ShopPage({ slug }: { slug: string }) {
  const [data, setData] = useState<{ company: { name: string; phone: string | null; city: string | null; uf: string | null }; products: ShopProduct[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState<CartItem[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(`cpdv:cart:${slug}`) ?? '[]');
    } catch {
      return [];
    }
  });
  const [checkout, setCheckout] = useState(false);
  const [done, setDone] = useState<{ number: number; totalCents: number } | null>(null);

  const load = () => api(`/public/${slug}/catalog`).then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [slug]);
  useEffect(() => {
    try {
      localStorage.setItem(`cpdv:cart:${slug}`, JSON.stringify(cart));
    } catch {
      /* navegador sem armazenamento */
    }
  }, [cart, slug]);

  const categories = useMemo(() => [...new Set(data?.products.map((p) => p.category).filter(Boolean) as string[])], [data]);
  const products = data?.products.filter((p) => !category || p.category === category) ?? [];
  const count = cart.reduce((a, i) => a + i.quantity, 0);
  const total = cart.reduce((a, i) => a + i.quantity * i.priceCents, 0);

  if (!data) return <div className="shop"><Loading error={error} loading={!error} /></div>;
  if (done)
    return (
      <div className="shop stack">
        <h1>Pedido #{done.number} recebido</h1>
        <p>Total de {formatBRL(done.totalCents)}. A loja vai confirmar o pagamento e a entrega pelo telefone ou e-mail informado.</p>
        <button className="btn" onClick={() => { setDone(null); load(); }}>Voltar à loja</button>
      </div>
    );

  return (
    <div className="shop">
      <header className="shop-head">
        <h1>{data.company.name}</h1>
        <span className="muted">{[data.company.city && `${data.company.city}/${data.company.uf}`, data.company.phone].filter(Boolean).join(', ')}</span>
      </header>
      {categories.length > 1 && (
        <div className="chips" style={{ marginBottom: 20 }}>
          <button className="chip" aria-pressed={!category} onClick={() => setCategory('')}>Tudo</button>
          {categories.map((c) => <button key={c} className="chip" aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}
        </div>
      )}
      <div className="products">
        {products.map((p) => <ProductCard key={p.id} p={p} onAdd={(item) => setCart((c) => {
          const ex = c.find((x) => x.variantId === item.variantId);
          if (ex) return c.map((x) => (x === ex ? { ...x, quantity: Math.min(x.max, x.quantity + 1) } : x));
          return [...c, item];
        })} />)}
        {!products.length && <div className="empty">Nenhum produto disponível no momento.</div>}
      </div>
      {count > 0 && (
        <div className="cart-bar">
          <span>{count} peça(s) — <b className="num" style={{ fontSize: 20 }}>{formatBRL(total)}</b></span>
          <button className="btn go" onClick={() => setCheckout(true)}>Finalizar pedido</button>
        </div>
      )}
      {checkout && (
        <Checkout slug={slug} cart={cart} setCart={setCart} onClose={() => setCheckout(false)} onDone={(r) => { setCart([]); setCheckout(false); setDone(r); }} />
      )}
    </div>
  );
}

function ProductCard({ p, onAdd }: { p: ShopProduct; onAdd: (i: CartItem) => void }) {
  const colors = [...new Set(p.variants.map((v) => v.color ?? ''))];
  const [color, setColor] = useState(colors[0]);
  const sizes = p.variants.filter((v) => (v.color ?? '') === color);
  const [variantId, setVariantId] = useState<string | null>(sizes.length === 1 ? sizes[0].id : null);
  const v = p.variants.find((x) => x.id === variantId) ?? sizes[0];
  return (
    <article className="product">
      <div className="ph">{p.imageUrl ? <img src={p.imageUrl} alt={p.name} loading="lazy" /> : p.name.charAt(0)}</div>
      <h3>{p.name}</h3>
      {p.brand && <span className="muted small">{p.brand}</span>}
      <div className="price">
        {formatBRL(v.finalPriceCents)}
        {v.finalPriceCents < v.priceCents && <s>{formatBRL(v.priceCents)}</s>}
      </div>
      {colors.length > 1 && (
        <div className="chips" aria-label="Cor">
          {colors.map((c) => <button key={c} className="chip" aria-pressed={c === color} onClick={() => { setColor(c); setVariantId(null); }}>{c}</button>)}
        </div>
      )}
      {sizes.some((s) => s.size) && (
        <div className="chips" aria-label="Tamanho">
          {sizes.map((s) => <button key={s.id} className="chip" disabled={!s.available} aria-pressed={s.id === variantId} onClick={() => setVariantId(s.id)}>{s.size}</button>)}
        </div>
      )}
      <button
        className="btn primary"
        style={{ width: '100%' }}
        disabled={!variantId}
        onClick={() => {
          const sel = p.variants.find((x) => x.id === variantId)!;
          onAdd({ variantId: sel.id, name: p.name, label: [sel.color, sel.size].filter(Boolean).join(' / '), priceCents: sel.finalPriceCents, quantity: 1, max: sel.available });
          toast(`${p.name} adicionado ao pedido`);
        }}
      >
        {variantId ? 'Adicionar ao pedido' : 'Escolha o tamanho'}
      </button>
    </article>
  );
}

function Checkout({ slug, cart, setCart, onClose, onDone }: { slug: string; cart: CartItem[]; setCart: (c: CartItem[]) => void; onClose: () => void; onDone: (r: { number: number; totalCents: number }) => void }) {
  const [c, setC] = useState({ name: '', email: '', phone: '', document: '' });
  const [delivery, setDelivery] = useState<'RETIRADA' | 'ENTREGA'>('RETIRADA');
  const [a, setA] = useState({ zip: '', street: '', number: '', complement: '', district: '', city: '', uf: '' });
  const [payment, setPayment] = useState('PIX');
  const [busy, setBusy] = useState(false);
  const total = cart.reduce((s, i) => s + i.quantity * i.priceCents, 0);

  const cep = async (v: string) => {
    const d = onlyDigits(v);
    if (d.length !== 8) return;
    const r = await fetch(`https://viacep.com.br/ws/${d}/json/`).then((x) => x.json()).catch(() => null);
    if (r && !r.erro) setA((x) => ({ ...x, street: r.logradouro, district: r.bairro, city: r.localidade, uf: r.uf }));
  };

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ number: number; totalCents: number }>(`/public/${slug}/orders`, {
        body: {
          customer: { ...c, document: c.document || null },
          delivery,
          address: delivery === 'ENTREGA' ? a : null,
          paymentMethod: payment,
          items: cart.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
        },
      });
      onDone(r);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Seu pedido" onClose={onClose} wide footer={<button className="btn go lg" disabled={busy || !c.name || !c.email || !c.phone} onClick={submit}>Enviar pedido de {formatBRL(total)}</button>}>
      {cart.map((i) => (
        <div key={i.variantId} className="payrow">
          <span>{i.name} <span className="muted">{i.label}</span></span>
          <input className="input num" type="number" min={0} max={i.max} value={i.quantity} style={{ width: 70 }}
            onChange={(e) => setCart(cart.map((x) => (x === i ? { ...x, quantity: Math.min(i.max, Number(e.target.value)) } : x)).filter((x) => x.quantity > 0))} />
          <span className="num">{formatBRL(i.quantity * i.priceCents)}</span>
        </div>
      ))}
      <div className="grid cols-2">
        <Field label="Nome completo"><Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} autoComplete="name" /></Field>
        <Field label="CPF (para a nota fiscal)"><Input value={c.document} onChange={(e) => setC({ ...c, document: e.target.value })} inputMode="numeric" /></Field>
        <Field label="E-mail"><Input type="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} autoComplete="email" /></Field>
        <Field label="WhatsApp"><Input value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} autoComplete="tel" /></Field>
      </div>
      <div className="row">
        <button className={`btn ${delivery === 'RETIRADA' ? 'primary' : ''}`} onClick={() => setDelivery('RETIRADA')}>Retirar na loja</button>
        <button className={`btn ${delivery === 'ENTREGA' ? 'primary' : ''}`} onClick={() => setDelivery('ENTREGA')}>Receber em casa</button>
      </div>
      {delivery === 'ENTREGA' && (
        <div className="grid cols-3">
          <Field label="CEP"><Input value={a.zip} onChange={(e) => setA({ ...a, zip: e.target.value })} onBlur={(e) => cep(e.target.value)} /></Field>
          <Field label="Rua"><Input value={a.street} onChange={(e) => setA({ ...a, street: e.target.value })} /></Field>
          <Field label="Número"><Input value={a.number} onChange={(e) => setA({ ...a, number: e.target.value })} /></Field>
          <Field label="Complemento"><Input value={a.complement} onChange={(e) => setA({ ...a, complement: e.target.value })} /></Field>
          <Field label="Bairro"><Input value={a.district} onChange={(e) => setA({ ...a, district: e.target.value })} /></Field>
          <Field label="Cidade / UF"><div className="row"><Input value={a.city} onChange={(e) => setA({ ...a, city: e.target.value })} style={{ flex: 1 }} /><Input value={a.uf} maxLength={2} style={{ width: 60 }} onChange={(e) => setA({ ...a, uf: e.target.value.toUpperCase() })} /></div></Field>
        </div>
      )}
      <Field label="Como prefere pagar">
        <select className="input" value={payment} onChange={(e) => setPayment(e.target.value)}>
          <option value="PIX">PIX</option>
          <option value="CREDITO">Cartão de crédito (na entrega ou retirada)</option>
          <option value="DEBITO">Cartão de débito (na entrega ou retirada)</option>
          <option value="DINHEIRO">Dinheiro</option>
        </select>
      </Field>
      <p className="muted small">As peças ficam reservadas para você. A loja confirma o pagamento e o frete pelo WhatsApp.</p>
    </Modal>
  );
}

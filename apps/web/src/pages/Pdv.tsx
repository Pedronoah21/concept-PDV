import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  checkPayments,
  computeCart,
  discountPercent,
  PAYMENT_LABELS,
  type PaymentMethod,
  type ReceiptData,
  type SaleInput,
} from '@concept/shared';
import { api, ApiError } from '../lib/api';
import { kv, outbox } from '../lib/idb';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import {
  decrementLocalStock,
  enqueueSale,
  loadCatalog,
  markOffline,
  nextLocalNumber,
  retryFailed,
  useSync,
  type Catalog,
  type CatalogVariant,
  type OutboxSale,
} from '../lib/offline';
import { formatBRL, formatCpfCnpj, onlyDigits, uuid, variantLabel } from '../lib/format';
import { getPrinterSettings, printReceipt } from '../lib/print';
import { Field, Input, Modal, MoneyInput, toast, toastError } from '../components/ui';

interface Line {
  key: string;
  variant: CatalogVariant;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
}
interface Payment {
  method: PaymentMethod;
  amountCents: number;
  installments: number;
  voucherCode?: string;
  firstDueDate?: string;
}
interface CashSession {
  id: string;
  openedAt: string;
  openingCents: number;
}

export function PdvPage() {
  const { me, store, register, registerId, setRegisterId, logout, can } = useSession();
  const sync = useSync();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [session, setSession] = useState<CashSession | null | undefined>(undefined);

  // Catálogo local + sessão de caixa (ambos funcionam offline depois da primeira carga)
  useEffect(() => {
    if (!store || !registerId) return;
    loadCatalog(store.id).then(setCatalog);
    api<CashSession | null>(`/cash/current?registerId=${registerId}`)
      .then(async (s) => {
        setSession(s);
        await kv.set(`cash:${registerId}`, s);
      })
      .catch(async (e) => {
        if (e instanceof ApiError && e.offline) setSession((await kv.get<CashSession | null>(`cash:${registerId}`)) ?? null);
        else setSession(null);
      });
  }, [store, registerId]);

  if (!me) return null;
  if (!registerId) return <ChooseRegister onPick={setRegisterId} />;

  return (
    <div className="pdv">
      <div className="pdv-top">
        <span className="brandmark">Concept PDV</span>
        <span>
          {store?.name} — {register?.name}
        </span>
        <span>Operador: {me.user.name}</span>
        <span className="grow" />
        <span className={`status-dot ${sync.online ? '' : 'off'}`}>
          {sync.online ? 'Online' : 'Sem internet — vendendo offline'}
        </span>
        {sync.pending > 0 && <span>{sync.pending} venda(s) aguardando envio</span>}
        {(can('gerencia') || can('caixa')) && <Link to={can('gerencia') ? '/painel' : '/caixa'}>Retaguarda</Link>}
        <button className="btn sm ghost" style={{ color: '#fff' }} onClick={logout}>
          Sair
        </button>
      </div>
      {session === undefined || !catalog ? (
        <div className="empty">{catalog === null && !sync.online ? 'Sem internet e sem catálogo salvo neste computador. Conecte-se uma vez para carregar os produtos.' : 'Preparando o caixa…'}</div>
      ) : session === null ? (
        <OpenCash registerId={registerId} onOpened={async (s) => { setSession(s); await kv.set(`cash:${registerId}`, s); }} />
      ) : (
        <Till catalog={catalog} session={session} onCatalog={setCatalog} />
      )}
    </div>
  );
}

function ChooseRegister({ onPick }: { onPick: (id: string) => void }) {
  const { me } = useSession();
  return (
    <div className="login">
      <div className="panel" style={{ width: 'min(480px, 100%)' }}>
        <div className="stack">
          <h1>Qual caixa é este computador?</h1>
          <p className="muted">A escolha fica salva neste navegador. Cada caixa tem sua própria sessão e numeração.</p>
          {me!.stores.map((s) => (
            <div key={s.id} className="stack" style={{ gap: 8 }}>
              <h3>{s.name}</h3>
              <div className="row">
                {s.registers.map((r) => (
                  <button key={r.id} className="btn primary" onClick={() => onPick(r.id)}>
                    {r.name} ({r.code})
                  </button>
                ))}
                {!s.registers.length && <span className="muted small">Nenhum caixa cadastrado nesta loja.</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function OpenCash({ registerId, onOpened }: { registerId: string; onOpened: (s: CashSession) => void }) {
  const [opening, setOpening] = useState(0);
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
      <form
        className="panel stack"
        style={{ width: 'min(420px, 100%)' }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onOpened(await api('/cash/open', { body: { registerId, openingCents: opening } }));
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>Abrir caixa</h1>
        <p className="muted">Conte o dinheiro do fundo de troco e informe o valor. A abertura precisa de internet.</p>
        <Field label="Fundo de troco (R$)">
          <MoneyInput value={opening} onChange={setOpening} className="big-input" autoFocus />
        </Field>
        <button className="btn go lg" disabled={busy}>
          Abrir caixa
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Caixa em operação
// ---------------------------------------------------------------------------
function Till({ catalog, session, onCatalog }: { catalog: Catalog; session: CashSession; onCatalog: (c: Catalog) => void }) {
  const { me, store, register } = useSession();
  const [lines, setLines] = useState<Line[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [saleDiscount, setSaleDiscount] = useState(0);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [cpf, setCpf] = useState('');
  const [modal, setModal] = useState<null | 'pay' | 'customer' | 'discount' | 'pending' | 'approval'>(null);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const customer = catalog.customers.find((c) => c.id === customerId) ?? null;
  const totals = useMemo(() => {
    try {
      return computeCart(lines, saleDiscount);
    } catch {
      return computeCart(lines, 0);
    }
  }, [lines, saleDiscount]);
  const catalogGross = lines.reduce((a, l) => a + l.quantity * l.variant.priceCents, 0);
  const discountPct = discountPercent(catalogGross, Math.max(0, catalogGross - totals.totalCents));
  const needsApproval = discountPct > me!.user.maxDiscountPct + 0.001 && !approvalToken;

  const addVariant = useCallback((v: CatalogVariant, qty = 1) => {
    setLines((ls) => {
      const existing = ls.find((l) => l.variant.id === v.id && l.discountCents === 0);
      if (existing) {
        setSelected(existing.key);
        return ls.map((l) => (l === existing ? { ...l, quantity: l.quantity + qty } : l));
      }
      const key = uuid();
      setSelected(key);
      return [...ls, { key, variant: v, quantity: qty, unitPriceCents: v.priceCents, discountCents: 0 }];
    });
    if (v.stock - qty < 0) toast(`Atenção: ${v.name} está sem saldo no estoque`);
  }, []);

  const reset = () => {
    setLines([]);
    setSaleDiscount(0);
    setCustomerId(null);
    setCpf('');
    setApprovalToken(null);
    setSelected(null);
    setTimeout(() => searchRef.current?.focus(), 0);
  };

  // Atalhos de teclado do caixa
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (receipt || (modal && e.key !== 'Escape')) return;
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'F4') { e.preventDefault(); setModal('customer'); }
      if (e.key === 'F6') { e.preventDefault(); if (lines.length) setModal('discount'); }
      if (e.key === 'F10' || e.key === 'F12') { e.preventDefault(); if (lines.length) setModal(needsApproval ? 'approval' : 'pay'); }
      if (e.key === 'Delete' && selected && document.activeElement !== searchRef.current) {
        setLines((ls) => ls.filter((l) => l.key !== selected));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, lines.length, selected, needsApproval, receipt]);

  const finish = async (payments: Payment[], issueFiscal: boolean) => {
    const { changeCents } = checkPayments(totals.totalCents, payments);
    const payload: SaleInput = {
      id: uuid(),
      registerId: register!.id,
      cashSessionId: session.id,
      customerId,
      cpfNaNota: onlyDigits(cpf) || null,
      items: lines.map((l) => ({ variantId: l.variant.id, quantity: l.quantity, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents })),
      discountCents: saleDiscount,
      payments: payments.map((p) => ({ ...p, voucherCode: p.voucherCode || undefined, firstDueDate: p.firstDueDate || undefined })),
      approvalToken,
      issueFiscal,
      createdAt: new Date().toISOString(),
      offline: false,
      notes: null,
    };
    const base: ReceiptData = {
      company: { name: catalog.receipt.name, cnpj: catalog.receipt.cnpj, ie: catalog.receipt.ie ?? undefined, address: catalog.receipt.address },
      saleNumber: '',
      date: payload.createdAt,
      operator: me!.user.name,
      customer: { name: customer?.name, document: payload.cpfNaNota },
      items: lines.map((l, i) => ({
        code: l.variant.sku,
        description: [l.variant.name, variantLabel(l.variant)].filter(Boolean).join(' '),
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        discountCents: totals.lineDiscounts[i],
        totalCents: l.quantity * l.unitPriceCents - totals.lineDiscounts[i],
      })),
      grossCents: totals.grossCents,
      discountCents: totals.itemDiscountCents + totals.saleDiscountCents,
      totalCents: totals.totalCents,
      payments: payments.map((p) => ({ method: p.method, amountCents: p.amountCents, installments: p.installments })),
      changeCents,
      footer: catalog.receipt.footer ?? undefined,
    };

    let data: ReceiptData;
    try {
      const sale = await api<any>('/sales', { body: payload });
      const doc = sale.fiscalDocuments?.[0];
      data = {
        ...base,
        saleNumber: String(sale.number),
        fiscal: doc ? { model: doc.model, number: doc.number, serie: doc.serie, accessKey: doc.accessKey, protocol: doc.protocol, qrcodeUrl: doc.qrcodeUrl, consultUrl: doc.consultUrl, status: doc.status } : null,
      };
      if (doc && doc.status !== 'AUTORIZADA') toast('Venda registrada. A nota fiscal está na fila e será emitida automaticamente.');
    } catch (e) {
      if (!(e instanceof ApiError && e.offline)) throw e; // erro de regra: o operador precisa corrigir
      markOffline();
      const localNumber = await nextLocalNumber(register!.code);
      await enqueueSale({ id: payload.id, localNumber, payload: { ...payload, offline: true }, createdAt: payload.createdAt } satisfies OutboxSale);
      data = { ...base, saleNumber: localNumber, offline: true };
    }
    await decrementLocalStock(store!.id, payload.items);
    const updated = await kv.get<Catalog>(`catalog:${store!.id}`);
    if (updated) onCatalog(updated);
    setReceipt(data);
    setModal(null);
    if (getPrinterSettings().autoPrint) printReceipt(data).catch(toastError);
  };

  const sel = lines.find((l) => l.key === selected) ?? null;

  return (
    <div className="pdv-body">
      <section className="pdv-items" aria-label="Itens da venda">
        <Search catalog={catalog} inputRef={searchRef} onPick={addVariant} />
        <div className="lines">
          {!lines.length && (
            <div className="empty">
              Leia o código de barras ou digite o nome do produto. Use <kbd>3*</kbd> antes do código para lançar 3 unidades.
            </div>
          )}
          {lines.map((l, i) => (
            <div key={l.key} className={`line ${l.key === selected ? 'sel' : ''}`} onClick={() => setSelected(l.key)}>
              <span className="idx">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <div className="name">{l.variant.name}</div>
                <div className="muted small">
                  {[variantLabel(l.variant), `código ${l.variant.sku}`, `${formatBRL(l.unitPriceCents)} cada`].filter(Boolean).join(', ')}
                  {l.discountCents > 0 && <span className="tag warn" style={{ marginLeft: 6 }}>-{formatBRL(l.discountCents)}</span>}
                </div>
              </div>
              <div className="qty">
                <button aria-label="Diminuir" onClick={() => setLines((ls) => ls.map((x) => (x.key === l.key && x.quantity > 1 ? { ...x, quantity: x.quantity - 1 } : x)))}>−</button>
                <span>{l.quantity}</span>
                <button aria-label="Aumentar" onClick={() => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, quantity: x.quantity + 1 } : x)))}>+</button>
              </div>
              <div className="total">{formatBRL(l.quantity * l.unitPriceCents - l.discountCents)}</div>
              <button className="btn ghost sm" aria-label={`Remover ${l.variant.name}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      </section>

      <aside className="till">
        <div className="display" aria-live="polite">
          <div className="lbl">
            <span>Total da venda</span>
            <span>{lines.reduce((a, l) => a + l.quantity, 0)} item(ns)</span>
          </div>
          <div className="total">{formatBRL(totals.totalCents)}</div>
          {totals.grossCents !== totals.totalCents && (
            <div className="sub">
              <span>Subtotal {formatBRL(totals.grossCents)}</span>
              <span>Desconto {formatBRL(totals.grossCents - totals.totalCents)}</span>
            </div>
          )}
        </div>

        <div className="till-actions">
          <button className="btn" onClick={() => setModal('customer')}>
            <span>{customer ? customer.name : cpf ? `CPF ${formatCpfCnpj(cpf)}` : 'Cliente / CPF'}</span> <kbd>F4</kbd>
          </button>
          <button className="btn" onClick={() => setModal('discount')} disabled={!lines.length}>
            <span>Desconto{discountPct > 0 ? ` (${discountPct.toFixed(1)}%)` : ''}</span> <kbd>F6</kbd>
          </button>
          <button className="btn" onClick={() => searchRef.current?.focus()}>
            <span>Buscar produto</span> <kbd>F2</kbd>
          </button>
          <button className="btn" onClick={() => setModal('pending')}>
            <span>Vendas não enviadas</span>
          </button>
          <button className="btn danger" disabled={!lines.length} onClick={() => confirm('Descartar todos os itens desta venda?') && reset()}>
            <span>Descartar venda</span>
          </button>
          <button className="btn" disabled={!sel} onClick={() => sel && setLines((ls) => ls.filter((l) => l.key !== sel.key))}>
            <span>Remover item</span> <kbd>Del</kbd>
          </button>
          {needsApproval && lines.length > 0 && (
            <div className="notice warn" style={{ gridColumn: '1 / -1' }}>
              Desconto acima do seu limite de {me!.user.maxDiscountPct}%: o gerente precisa autorizar.
            </div>
          )}
        </div>

        <button className="btn go pay-btn" disabled={!lines.length} onClick={() => setModal(needsApproval ? 'approval' : 'pay')}>
          Receber pagamento <kbd>F10</kbd>
        </button>
      </aside>

      {modal === 'customer' && (
        <CustomerModal
          catalog={catalog}
          cpf={cpf}
          customerId={customerId}
          onClose={() => setModal(null)}
          onSave={(id, doc) => {
            setCustomerId(id);
            setCpf(doc);
            setModal(null);
          }}
        />
      )}
      {modal === 'discount' && (
        <DiscountModal
          line={sel}
          grossCents={totals.grossCents - totals.itemDiscountCents}
          saleDiscount={saleDiscount}
          onClose={() => setModal(null)}
          onLine={(key, cents) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, discountCents: cents } : l)))}
          onSale={(c) => setSaleDiscount(c)}
        />
      )}
      {modal === 'approval' && (
        <ApprovalModal
          pct={discountPct}
          onClose={() => setModal(null)}
          onApproved={(t) => {
            setApprovalToken(t);
            setModal('pay');
          }}
          onOffline={() => setModal('pay')}
        />
      )}
      {modal === 'pay' && <PaymentModal totalCents={totals.totalCents} customer={customer} onClose={() => setModal(null)} onFinish={finish} />}
      {modal === 'pending' && <PendingModal onClose={() => setModal(null)} />}
      {receipt && (
        <ReceiptModal
          data={receipt}
          onNew={() => {
            setReceipt(null);
            reset();
          }}
        />
      )}
    </div>
  );
}

/** Minúsculas e sem acento: "bone" encontra "Boné", "calca" encontra "Calça". */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function Search({ catalog, onPick, inputRef }: { catalog: Catalog; onPick: (v: CatalogVariant, qty?: number) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const parsed = useMemo(() => {
    const m = q.match(/^(\d{1,3})\*(.*)$/);
    return m ? { qty: Number(m[1]), term: m[2].trim() } : { qty: 1, term: q.trim() };
  }, [q]);
  const results = useMemo(() => {
    const t = fold(parsed.term);
    if (t.length < 2 || /^\d{8,14}$/.test(t)) return [];
    const words = t.split(/\s+/);
    return catalog.variants.filter((v) => {
      const hay = fold(`${v.name} ${v.brand ?? ''} ${v.color ?? ''} ${v.size ?? ''} ${v.sku}`);
      return words.every((w) => hay.includes(w));
    }).slice(0, 30);
  }, [parsed.term, catalog.variants]);

  const pick = (v: CatalogVariant) => {
    onPick(v, parsed.qty);
    setQ('');
    setCursor(0);
    inputRef.current?.focus();
  };

  return (
    <div className="scan">
      <input
        ref={inputRef}
        className="input"
        placeholder="Código de barras, código ou nome do produto"
        aria-label="Buscar produto"
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setCursor(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
          if (e.key === 'Escape') setQ('');
          if (e.key === 'Enter') {
            e.preventDefault();
            const term = parsed.term;
            const exact = catalog.variants.find((v) => v.barcode === term || v.sku.toLowerCase() === term.toLowerCase());
            if (exact) return pick(exact);
            if (results[cursor]) return pick(results[cursor]);
            if (term) toast(`Nenhum produto com o código "${term}"`);
          }
        }}
      />
      {results.length > 0 && (
        <div className="suggest" role="listbox">
          {results.map((v, i) => (
            <button key={v.id} role="option" aria-selected={i === cursor} onMouseDown={(e) => { e.preventDefault(); pick(v); }}>
              <span>
                <b>{v.name}</b> <span className="muted">{variantLabel(v)}</span>
                <br />
                <span className="small muted">
                  {v.sku} — estoque {v.stock}
                </span>
              </span>
              <span className="num" style={{ fontSize: 20 }}>{formatBRL(v.priceCents)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomerModal({ catalog, cpf, customerId, onClose, onSave }: { catalog: Catalog; cpf: string; customerId: string | null; onClose: () => void; onSave: (id: string | null, cpf: string) => void }) {
  const [doc, setDoc] = useState(cpf);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(customerId);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    const d = onlyDigits(t);
    return catalog.customers.filter((c) => c.name.toLowerCase().includes(t) || (d && (c.document?.startsWith(d) || c.phone?.includes(d)))).slice(0, 12);
  }, [q, catalog.customers]);
  const current = catalog.customers.find((c) => c.id === picked);
  return (
    <Modal
      title="Cliente da venda"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => onSave(null, '')}>Limpar</button>
          <button className="btn primary" onClick={() => onSave(picked, doc)}>Confirmar</button>
        </>
      }
    >
      <Field label="CPF/CNPJ na nota" hint="Opcional. Sai impresso na NFC-e.">
        <Input value={doc} onChange={(e) => setDoc(e.target.value)} inputMode="numeric" autoFocus />
      </Field>
      <Field label="Buscar cliente cadastrado (necessário para crediário)">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, CPF ou telefone" />
      </Field>
      {current && <div className="notice go">Selecionado: {current.name}</div>}
      {list.map((c) => (
        <button
          key={c.id}
          className="btn"
          style={{ justifyContent: 'space-between' }}
          onClick={() => {
            setPicked(c.id);
            if (c.document && !doc) setDoc(c.document);
          }}
        >
          <span>{c.name}</span>
          <span className="muted small">{c.document ? formatCpfCnpj(c.document) : c.phone}</span>
        </button>
      ))}
    </Modal>
  );
}

function DiscountModal({ line, grossCents, saleDiscount, onClose, onLine, onSale }: { line: Line | null; grossCents: number; saleDiscount: number; onClose: () => void; onLine: (key: string, cents: number) => void; onSale: (cents: number) => void }) {
  const [target, setTarget] = useState<'sale' | 'line'>(line ? 'line' : 'sale');
  const base = target === 'line' && line ? line.quantity * line.unitPriceCents : grossCents;
  const [cents, setCents] = useState(target === 'line' ? line?.discountCents ?? 0 : saleDiscount);
  const [pct, setPct] = useState('');
  const apply = () => {
    const value = Math.min(cents, base);
    if (target === 'line' && line) onLine(line.key, value);
    else onSale(value);
    onClose();
  };
  return (
    <Modal title="Desconto" onClose={onClose} footer={<button className="btn primary" onClick={apply}>Aplicar desconto</button>}>
      {line && (
        <div className="row">
          <button className={`btn ${target === 'line' ? 'primary' : ''}`} onClick={() => { setTarget('line'); setCents(line.discountCents); }}>
            No item: {line.variant.name}
          </button>
          <button className={`btn ${target === 'sale' ? 'primary' : ''}`} onClick={() => { setTarget('sale'); setCents(saleDiscount); }}>
            Na venda toda
          </button>
        </div>
      )}
      <div className="grid cols-2">
        <Field label="Percentual (%)">
          <Input
            inputMode="decimal"
            value={pct}
            onChange={(e) => {
              setPct(e.target.value);
              const p = Number(e.target.value.replace(',', '.'));
              if (Number.isFinite(p)) setCents(Math.round((base * p) / 100));
            }}
          />
        </Field>
        <Field label="Valor (R$)">
          <MoneyInput value={cents} onChange={(c) => { setCents(c); setPct(''); }} onKeyDown={(e) => e.key === 'Enter' && apply()} />
        </Field>
      </div>
      <p className="muted small">Sobre {formatBRL(base)}. Descontos acima do seu limite pedem a senha do gerente ao receber.</p>
    </Modal>
  );
}

function ApprovalModal({ pct, onClose, onApproved, onOffline }: { pct: number; onClose: () => void; onApproved: (token: string) => void; onOffline: () => void }) {
  const sync = useSync();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Autorização do gerente" onClose={onClose}>
      <p>
        Desconto de <b>{pct.toFixed(1)}%</b> precisa de autorização.
      </p>
      {!sync.online ? (
        <>
          <div className="notice warn">Sem internet: a venda será concluída e ficará marcada para revisão do gerente.</div>
          <button className="btn primary" onClick={onOffline}>Continuar mesmo assim</button>
        </>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api<{ token: string; manager: string }>('/auth/approve', { body: { email, password, scope: 'desconto', maxPct: Math.ceil(pct) } });
              toast(`Autorizado por ${r.manager}`);
              onApproved(r.token);
            } catch (err) {
              toastError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="E-mail do gerente">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
          </Field>
          <Field label="Senha do gerente">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <button className="btn primary" disabled={busy}>Autorizar</button>
        </form>
      )}
    </Modal>
  );
}

const QUICK_METHODS: PaymentMethod[] = ['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO', 'CREDIARIO', 'VALE_TROCA'];
const addMonth = () => {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
};

function PaymentModal({ totalCents, customer, onClose, onFinish }: { totalCents: number; customer: Catalog['customers'][number] | null; onClose: () => void; onFinish: (p: Payment[], fiscal: boolean) => Promise<void> }) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const paid = payments.reduce((a, p) => a + p.amountCents, 0);
  const remaining = Math.max(0, totalCents - paid);
  const [method, setMethod] = useState<PaymentMethod>('DINHEIRO');
  const [amount, setAmount] = useState(remaining);
  const [installments, setInstallments] = useState(1);
  const [voucher, setVoucher] = useState('');
  const [firstDue, setFirstDue] = useState(addMonth());
  const [fiscal, setFiscal] = useState(true);
  const [busy, setBusy] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => setAmount(remaining), [remaining]);

  let change = 0;
  let error: string | null = null;
  try {
    if (paid >= totalCents) change = checkPayments(totalCents, payments).changeCents;
  } catch (e) {
    error = (e as Error).message;
  }
  const done = paid >= totalCents && !error;

  const add = () => {
    if (amount <= 0) return;
    if (method === 'CREDIARIO' && !customer) return toast('Selecione o cliente (F4) para vender no crediário');
    if (method === 'VALE_TROCA' && !voucher.trim()) return toast('Digite o código do vale-troca');
    if (method !== 'DINHEIRO' && amount > remaining) return toast('Só pagamento em dinheiro pode passar do valor (troco)');
    setPayments((ps) => [
      ...ps,
      {
        method,
        amountCents: amount,
        installments: method === 'CREDITO' || method === 'CREDIARIO' ? installments : 1,
        voucherCode: method === 'VALE_TROCA' ? voucher.trim().toUpperCase() : undefined,
        firstDueDate: method === 'CREDIARIO' ? firstDue : undefined,
      },
    ]);
    setMethod('DINHEIRO');
    setInstallments(1);
    setVoucher('');
  };

  const finish = async () => {
    setBusy(true);
    try {
      await onFinish(payments, fiscal);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Pagamento"
      onClose={onClose}
      footer={
        <>
          <label className="check" style={{ marginRight: 'auto' }}>
            <input type="checkbox" checked={fiscal} onChange={(e) => setFiscal(e.target.checked)} /> Emitir NFC-e
          </label>
          <button className="btn go lg" disabled={!done || busy} onClick={finish}>
            {busy ? 'Registrando…' : 'Concluir venda'}
          </button>
        </>
      }
    >
      <div className="remaining">
        <span>Total</span>
        <span>{formatBRL(totalCents)}</span>
      </div>
      {payments.map((p, i) => (
        <div key={i} className="payrow">
          <span>
            {PAYMENT_LABELS[p.method]}
            {p.installments > 1 ? ` em ${p.installments}x` : ''}
            {p.voucherCode ? ` (${p.voucherCode})` : ''}
          </span>
          <span className="num" style={{ fontSize: 18 }}>{formatBRL(p.amountCents)}</span>
          <button className="btn ghost sm" onClick={() => setPayments((ps) => ps.filter((_, k) => k !== i))} aria-label="Remover pagamento">✕</button>
        </div>
      ))}
      {!done && (
        <>
          <div className="methods">
            {QUICK_METHODS.map((m) => (
              <button
                key={m}
                className={`btn ${method === m ? 'primary' : ''}`}
                onClick={() => {
                  setMethod(m);
                  amountRef.current?.focus();
                }}
              >
                {PAYMENT_LABELS[m]}
              </button>
            ))}
          </div>
          <div className="grid cols-2">
            <Field label={`Valor em ${PAYMENT_LABELS[method].toLowerCase()}`}>
              <MoneyInput ref={amountRef} value={amount} onChange={setAmount} className="big-input" autoFocus onKeyDown={(e) => e.key === 'Enter' && add()} />
            </Field>
            {(method === 'CREDITO' || method === 'CREDIARIO') && (
              <Field label="Parcelas">
                <select className="input" value={installments} onChange={(e) => setInstallments(Number(e.target.value))}>
                  {Array.from({ length: method === 'CREDIARIO' ? 10 : 12 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}x de {formatBRL(Math.ceil(amount / n))}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {method === 'CREDIARIO' && (
              <Field label="Primeiro vencimento">
                <Input type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
              </Field>
            )}
            {method === 'VALE_TROCA' && (
              <Field label="Código do vale-troca">
                <Input value={voucher} onChange={(e) => setVoucher(e.target.value)} />
              </Field>
            )}
          </div>
          <button className="btn primary" onClick={add}>
            Adicionar pagamento
          </button>
        </>
      )}
      <div className="remaining" style={{ color: remaining ? 'var(--warn)' : 'var(--go)' }}>
        <span>{remaining ? 'Falta receber' : 'Troco'}</span>
        <span>{formatBRL(remaining || change)}</span>
      </div>
      {error && <div className="notice danger">{error}</div>}
    </Modal>
  );
}

function ReceiptModal({ data, onNew }: { data: ReceiptData; onNew: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Enter' && onNew();
    const t = setTimeout(() => window.addEventListener('keydown', k), 300);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', k);
    };
  }, [onNew]);
  const authorized = data.fiscal?.status === 'AUTORIZADA';
  return (
    <Modal
      title={`Venda ${data.saleNumber} concluída`}
      onClose={onNew}
      footer={
        <>
          <button className="btn" onClick={() => printReceipt(data).catch(toastError)}>Imprimir cupom</button>
          <button className="btn go lg" onClick={onNew} autoFocus>
            Nova venda <kbd>Enter</kbd>
          </button>
        </>
      }
    >
      {data.changeCents > 0 && (
        <div className="display">
          <div className="lbl"><span>Troco</span></div>
          <div className="total">{formatBRL(data.changeCents)}</div>
        </div>
      )}
      <div className="remaining">
        <span>Total pago</span>
        <span>{formatBRL(data.totalCents)}</span>
      </div>
      {data.offline && <div className="notice warn">Venda guardada neste computador. Será enviada e a nota emitida assim que a internet voltar.</div>}
      {authorized && <div className="notice go">NFC-e {data.fiscal?.number} autorizada.</div>}
      {data.fiscal && !authorized && <div className="notice warn">Nota fiscal em processamento — acompanhe em Notas fiscais.</div>}
    </Modal>
  );
}

function PendingModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<OutboxSale[]>([]);
  const load = () => outbox.all<OutboxSale>().then((x) => setItems(x.sort((a, b) => a.createdAt.localeCompare(b.createdAt))));
  useEffect(() => {
    load();
  }, []);
  return (
    <Modal title="Vendas não enviadas ao servidor" onClose={onClose} wide>
      {!items.length && <div className="empty">Todas as vendas deste caixa já foram enviadas.</div>}
      {items.map((s) => (
        <div key={s.id} className="payrow">
          <span>
            <b>{s.localNumber}</b> <span className="muted small">{new Date(s.createdAt).toLocaleString('pt-BR')}</span>
            {s.error && <div className="notice danger small">{s.error}</div>}
          </span>
          <span className="num">{formatBRL(computeCart(s.payload.items, s.payload.discountCents).totalCents)}</span>
          {s.permanent ? (
            <button className="btn sm" onClick={() => retryFailed(s.id).then(load)}>Tentar de novo</button>
          ) : (
            <span className="tag warn">Na fila</span>
          )}
        </div>
      ))}
    </Modal>
  );
}

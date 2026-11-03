import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, match, navigate, usePath } from './lib/router';
import { SessionProvider, useSession } from './lib/session';
import { api } from './lib/api';
import { startSyncLoop, useSync } from './lib/offline';
import { Field, Input, ToastHost, toastError } from './components/ui';
import { PdvPage } from './pages/Pdv';
import { CashPage } from './pages/Cash';
import { DashboardPage } from './pages/Dashboard';
import { SalesPage, SaleDetailPage } from './pages/Sales';
import { ProductsPage, ProductFormPage } from './pages/Products';
import { StockPage } from './pages/Stock';
import { PurchasesPage, PurchaseFormPage } from './pages/Purchases';
import { CustomersPage, CustomerDetailPage, CreditPage } from './pages/Customers';
import { OrdersPage } from './pages/Orders';
import { FiscalPage } from './pages/Fiscal';
import { SettingsPage } from './pages/Settings';
import { ShopPage } from './pages/Shop';

export function App() {
  const path = usePath();
  const shop = match('/loja/:slug', path);
  if (shop) {
    return (
      <>
        <ShopPage slug={shop.slug} />
        <ToastHost />
      </>
    );
  }
  return (
    <SessionProvider>
      <Gate />
      <ToastHost />
    </SessionProvider>
  );
}

let syncStarted = false;

function Gate() {
  const { me, loading } = useSession();
  const path = usePath();
  useEffect(() => {
    if (me && !syncStarted) {
      syncStarted = true;
      startSyncLoop();
    }
  }, [me]);
  if (loading) return <div className="empty">Abrindo o Concept PDV…</div>;
  if (!me) return <LoginPage />;
  if (path === '/' || path === '/login') {
    navigate(me.user.role === 'CAIXA' || me.user.role === 'VENDEDOR' ? '/pdv' : '/painel', true);
    return null;
  }
  if (path === '/pdv') return <PdvPage />;
  return <Shell path={path} />;
}

function LoginPage() {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/auth/login', { body: { email, password } });
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form onSubmit={submit}>
        <div className="mark">Concept PDV</div>
        <p className="muted">Entre com o e-mail e a senha cadastrados pelo administrador da loja.</p>
        <Field label="E-mail">
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Senha">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button className="btn primary lg" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}

interface NavItem {
  to: string;
  label: string;
  perm?: 'gerencia' | 'admin' | 'caixa';
}
const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Vendas', items: [{ to: '/painel', label: 'Painel', perm: 'gerencia' }, { to: '/vendas', label: 'Vendas' }, { to: '/caixa', label: 'Caixa', perm: 'caixa' }, { to: '/pedidos', label: 'Pedidos online', perm: 'gerencia' }] },
  { group: 'Mercadoria', items: [{ to: '/produtos', label: 'Produtos' }, { to: '/estoque', label: 'Estoque' }, { to: '/compras', label: 'Entrada de mercadoria', perm: 'gerencia' }] },
  { group: 'Clientes', items: [{ to: '/clientes', label: 'Clientes' }, { to: '/crediario', label: 'Crediário' }] },
  { group: 'Gestão', items: [{ to: '/fiscal', label: 'Notas fiscais', perm: 'gerencia' }, { to: '/configuracoes', label: 'Configurações', perm: 'admin' }] },
];

const ROUTES: [string, (p: Record<string, string>) => ReactNode][] = [
  ['/painel', () => <DashboardPage />],
  ['/caixa', () => <CashPage />],
  ['/vendas', () => <SalesPage />],
  ['/vendas/:id', (p) => <SaleDetailPage id={p.id} />],
  ['/produtos', () => <ProductsPage />],
  ['/produtos/novo', () => <ProductFormPage />],
  ['/produtos/:id', (p) => <ProductFormPage id={p.id} />],
  ['/estoque', () => <StockPage />],
  ['/compras', () => <PurchasesPage />],
  ['/compras/nova', () => <PurchaseFormPage />],
  ['/clientes', () => <CustomersPage />],
  ['/clientes/:id', (p) => <CustomerDetailPage id={p.id} />],
  ['/crediario', () => <CreditPage />],
  ['/pedidos', () => <OrdersPage />],
  ['/fiscal', () => <FiscalPage />],
  ['/configuracoes', () => <SettingsPage />],
];

function Shell({ path }: { path: string }) {
  const { me, can, logout } = useSession();
  const sync = useSync();
  let page: ReactNode = <div className="empty">Página não encontrada.</div>;
  for (const [pattern, render] of ROUTES) {
    const params = match(pattern, path);
    if (params) {
      page = render(params);
      break;
    }
  }
  return (
    <div className="shell">
      <nav className="side" aria-label="Menu principal">
        <div className="brandmark">Concept PDV</div>
        <Link to="/pdv" className="cta">
          Abrir frente de caixa
        </Link>
        {NAV.map((g) => {
          const items = g.items.filter((i) => !i.perm || can(i.perm));
          if (!items.length) return null;
          return (
            <div key={g.group} style={{ display: 'contents' }}>
              <div className="group">{g.group}</div>
              {items.map((i) => (
                <Link key={i.to} to={i.to} className={path === i.to || path.startsWith(i.to + '/') ? 'on' : ''}>
                  {i.label}
                </Link>
              ))}
            </div>
          );
        })}
        <div className="foot">
          <div>{me!.user.name}</div>
          <div>{me!.company.tradeName}</div>
          {!sync.online && <div style={{ color: '#f5c46b' }}>Sem internet</div>}
          <button className="btn ghost sm" style={{ color: '#dfe8ec', paddingLeft: 0 }} onClick={logout}>
            Sair
          </button>
        </div>
      </nav>
      <main className="main">{page}</main>
    </div>
  );
}

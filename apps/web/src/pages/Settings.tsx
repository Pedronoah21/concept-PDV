import { Link } from '../lib/router';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Field, Input, Loading, Modal, toast, useAction, useLoad } from '../components/ui';

const ROLE_LABEL: Record<string, string> = { ADMIN: 'Administrador', GERENTE: 'Gerente', CAIXA: 'Operador de caixa', VENDEDOR: 'Vendedor' };

export function SettingsPage() {
  return (
    <div className="stack">
      <div className="page-head"><h1>Configurações</h1></div>
      <CompanySettings />
      <StoresSettings />
      <div className="panel spread">
        <span>Administradores, gerentes, operadores de caixa e vendedores ficam em <b>Usuários</b>.</span>
        <Link className="btn" to="/usuarios">Abrir usuários</Link>
      </div>
    </div>
  );
}

/** Página própria de usuários (menu Gestão → Usuários). */
export function UsersPage() {
  return (
    <div className="stack">
      <UsersSettings />
    </div>
  );
}

/** Valores iniciais de cada perfil ao cadastrar. */
const ROLE_DEFAULTS: Record<string, { maxDiscountPct: number; needsStore: boolean }> = {
  ADMIN: { maxDiscountPct: 100, needsStore: false },
  GERENTE: { maxDiscountPct: 30, needsStore: false },
  CAIXA: { maxDiscountPct: 5, needsStore: true },
  VENDEDOR: { maxDiscountPct: 5, needsStore: true },
};

function CompanySettings() {
  const { refresh } = useSession();
  const { data, error, loading } = useLoad<any>('/company');
  const [f, setF] = useState<any>(null);
  const [token, setToken] = useState('');
  useEffect(() => {
    if (data) setF(data);
  }, [data]);
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));
  const [save, saving] = useAction(async () => {
    const keys = ['legalName', 'tradeName', 'cnpj', 'ie', 'crt', 'phone', 'email', 'zip', 'street', 'number', 'district', 'city', 'cityCode', 'uf', 'receiptFooter', 'onlineStoreOn', 'allowNegativeStock', 'fiscalProvider', 'fiscalEnv'];
    const body = Object.fromEntries(keys.map((k) => [k, f[k] === '' ? null : f[k]]));
    await api('/company', { method: 'PUT', body: { ...body, fiscalToken: token || undefined } });
    setToken('');
    await refresh();
    toast('Configurações salvas');
  });
  if (!f) return <Loading error={error} loading={loading} />;
  return (
    <form className="panel stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div className="spread"><h2>Empresa</h2><button className="btn primary" disabled={saving}>Salvar empresa</button></div>
      <div className="grid cols-3">
        <Field label="Razão social"><Input value={f.legalName} onChange={(e) => set('legalName', e.target.value)} /></Field>
        <Field label="Nome fantasia (sai no cupom e na loja online)"><Input value={f.tradeName} onChange={(e) => set('tradeName', e.target.value)} /></Field>
        <Field label="CNPJ"><Input value={f.cnpj} onChange={(e) => set('cnpj', e.target.value)} /></Field>
        <Field label="Inscrição estadual"><Input value={f.ie ?? ''} onChange={(e) => set('ie', e.target.value)} /></Field>
        <Field label="Regime tributário">
          <select className="input" value={f.crt} onChange={(e) => set('crt', Number(e.target.value))}>
            <option value={1}>Simples Nacional</option>
            <option value={2}>Simples Nacional, excesso de sublimite</option>
            <option value={3}>Regime normal</option>
          </select>
        </Field>
        <Field label="Telefone"><Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Rua"><Input value={f.street ?? ''} onChange={(e) => set('street', e.target.value)} /></Field>
        <Field label="Número"><Input value={f.number ?? ''} onChange={(e) => set('number', e.target.value)} /></Field>
        <Field label="Bairro"><Input value={f.district ?? ''} onChange={(e) => set('district', e.target.value)} /></Field>
        <Field label="Cidade"><Input value={f.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Field>
        <Field label="UF"><Input value={f.uf ?? ''} maxLength={2} onChange={(e) => set('uf', e.target.value.toUpperCase())} /></Field>
        <Field label="Código IBGE do município"><Input value={f.cityCode ?? ''} onChange={(e) => set('cityCode', e.target.value)} /></Field>
      </div>
      <Field label="Mensagem no rodapé do cupom"><Input value={f.receiptFooter ?? ''} onChange={(e) => set('receiptFooter', e.target.value)} /></Field>
      <div className="row">
        <label className="check"><input type="checkbox" checked={f.onlineStoreOn} onChange={(e) => set('onlineStoreOn', e.target.checked)} /> Loja online ativa</label>
        <label className="check"><input type="checkbox" checked={f.allowNegativeStock} onChange={(e) => set('allowNegativeStock', e.target.checked)} /> Permitir vender produto sem saldo no estoque</label>
      </div>
      <h2>Nota fiscal</h2>
      <div className="grid cols-3">
        <Field label="Emissor">
          <select className="input" value={f.fiscalProvider} onChange={(e) => set('fiscalProvider', e.target.value)}>
            <option value="mock">Simulador (treino, sem valor fiscal)</option>
            <option value="focusnfe">Focus NFe</option>
          </select>
        </Field>
        <Field label="Ambiente">
          <select className="input" value={f.fiscalEnv} onChange={(e) => set('fiscalEnv', e.target.value)}>
            <option value="HOMOLOGACAO">Homologação (testes)</option>
            <option value="PRODUCAO">Produção</option>
          </select>
        </Field>
        <Field label={f.hasFiscalToken ? 'Token da API (já configurado; preencha para trocar)' : 'Token da API'}>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </Field>
      </div>
      <p className="muted small">Na Focus NFe, cadastre a empresa, envie o certificado digital A1 e o CSC da NFC-e pelo painel deles. Teste tudo em homologação antes de mudar para produção.</p>
    </form>
  );
}

function StoresSettings() {
  const { refresh } = useSession();
  const { data, reload } = useLoad<any[]>('/stores');
  const [name, setName] = useState('');
  const [reg, setReg] = useState<{ storeId: string; name: string; code: string } | null>(null);
  const [addStore] = useAction(async () => {
    await api('/stores', { body: { name } });
    setName('');
    reload();
    refresh();
  });
  const [addReg, busy] = useAction(async () => {
    await api(`/stores/${reg!.storeId}/registers`, { body: { name: reg!.name, code: reg!.code } });
    setReg(null);
    reload();
    refresh();
  });
  return (
    <div className="panel stack">
      <h2>Lojas e caixas</h2>
      {data?.map((s) => (
        <div key={s.id} className="spread" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
          <div>
            <b>{s.name}</b> {s.isOnline && <span className="tag go">atende a loja online</span>}
            <div className="muted small">{s.registers.map((r: any) => `${r.name} (${r.code})`).join(', ') || 'Sem caixas'}</div>
          </div>
          <button className="btn sm" onClick={() => setReg({ storeId: s.id, name: `Caixa ${String(s.registers.length + 1).padStart(2, '0')}`, code: `CX${String(s.registers.length + 1).padStart(2, '0')}` })}>Adicionar caixa</button>
        </div>
      ))}
      <div className="row">
        <Input placeholder="Nome da nova loja" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 260 }} />
        <button className="btn" disabled={name.length < 2} onClick={() => addStore()}>Criar loja</button>
      </div>
      {reg && (
        <Modal title="Novo caixa" onClose={() => setReg(null)} footer={<button className="btn primary" disabled={busy} onClick={() => addReg()}>Criar caixa</button>}>
          <Field label="Nome"><Input value={reg.name} onChange={(e) => setReg({ ...reg, name: e.target.value })} /></Field>
          <Field label="Código (aparece no número das vendas offline)"><Input value={reg.code} onChange={(e) => setReg({ ...reg, code: e.target.value.toUpperCase() })} /></Field>
        </Modal>
      )}
    </div>
  );
}

function UsersSettings() {
  const { data, reload } = useLoad<any[]>('/users');
  const stores = useLoad<any[]>('/stores');
  const [edit, setEdit] = useState<any | null>(null);
  const [save, busy] = useAction(async () => {
    const { id, store: _st, register: _rg, createdAt: _c, ...body } = edit;
    if (!body.password) delete body.password;
    body.storeId = body.storeId || null;
    body.registerId = body.registerId || null;
    await api(id ? `/users/${id}` : '/users', { method: id ? 'PUT' : 'POST', body });
    toast('Usuário salvo');
    setEdit(null);
    reload();
  });
  const newUser = (role: keyof typeof ROLE_DEFAULTS) =>
    setEdit({
      name: '',
      email: '',
      password: '',
      role,
      maxDiscountPct: ROLE_DEFAULTS[role].maxDiscountPct,
      active: true,
      // Operador e vendedor precisam de loja: já vem marcada a primeira (dá para trocar).
      storeId: ROLE_DEFAULTS[role].needsStore ? stores.data?.[0]?.id ?? '' : '',
      registerId: '',
    });
  return (
    <>
    <div className="page-head">
      <h1>Usuários</h1>
      <div className="row">
        <button className="btn" onClick={() => newUser('ADMIN')}>Novo administrador</button>
        <button className="btn" onClick={() => newUser('GERENTE')}>Novo gerente</button>
        <button className="btn" onClick={() => newUser('VENDEDOR')}>Novo vendedor</button>
        <button className="btn primary" onClick={() => newUser('CAIXA')}>Novo operador de caixa</button>
      </div>
    </div>
    <div className="panel flush">
      <table className="table">
        <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Loja</th><th>Caixa padrão</th><th className="r">Desconto máx.</th><th /></tr></thead>
        <tbody>
          {data?.map((u) => (
            <tr key={u.id}>
              <td>{u.name} {!u.active && <span className="tag danger">inativo</span>}</td>
              <td>{u.email}</td>
              <td>{ROLE_LABEL[u.role]}</td>
              <td>{u.store?.name ?? <span className="muted">Todas</span>}</td>
              <td>{u.register?.name ?? <span className="muted">Escolhe ao entrar</span>}</td>
              <td className="r num">{u.maxDiscountPct}%</td>
              <td className="r"><button className="btn sm" onClick={() => setEdit({ ...u, password: '' })}>Editar</button></td>
            </tr>
          ))}
          {data && !data.length && <tr><td colSpan={7} className="empty">Nenhum usuário cadastrado.</td></tr>}
        </tbody>
      </table>
      {edit && (
        <Modal title={edit.id ? 'Editar usuário' : 'Novo usuário'} onClose={() => setEdit(null)} footer={<button className="btn primary" disabled={busy} onClick={() => save()}>Salvar usuário</button>}>
          <Field label="Nome"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="E-mail"><Input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
          <Field label={edit.id ? 'Nova senha (deixe vazio para manter)' : 'Senha (mínimo 8 caracteres)'}><Input type="password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} autoComplete="new-password" /></Field>
          <div className="grid cols-2">
            <Field label="Perfil">
              <select
                className="input"
                value={edit.role}
                onChange={(e) => {
                  const role = e.target.value;
                  // Usuário novo: o desconto padrão acompanha o perfil escolhido.
                  setEdit({
                    ...edit,
                    role,
                    ...(edit.id ? {} : { maxDiscountPct: ROLE_DEFAULTS[role].maxDiscountPct }),
                    ...(ROLE_DEFAULTS[role].needsStore && !edit.storeId ? { storeId: stores.data?.[0]?.id ?? '' } : {}),
                  });
                }}
              >
                {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Desconto máximo sem gerente (%)"><Input type="number" min={0} max={100} value={edit.maxDiscountPct} onChange={(e) => setEdit({ ...edit, maxDiscountPct: Number(e.target.value) })} /></Field>
          </div>
          <div className="grid cols-2">
            <Field label={ROLE_DEFAULTS[edit.role]?.needsStore ? 'Loja (obrigatória)' : 'Loja'} hint="O usuário só vê e opera esta loja.">
              <select className="input" value={edit.storeId ?? ''} onChange={(e) => setEdit({ ...edit, storeId: e.target.value, registerId: '' })}>
                {!ROLE_DEFAULTS[edit.role]?.needsStore && <option value="">Todas as lojas</option>}
                {stores.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Caixa padrão" hint="Abre direto ao entrar, sem perguntar.">
              <select className="input" value={edit.registerId ?? ''} disabled={!edit.storeId} onChange={(e) => setEdit({ ...edit, registerId: e.target.value })}>
                <option value="">{edit.storeId ? 'Perguntar ao entrar (ou o único caixa)' : 'Escolha a loja primeiro'}</option>
                {stores.data?.find((s) => s.id === edit.storeId)?.registers.map((r: any) => <option key={r.id} value={r.id}>{r.name} ({r.code})</option>)}
              </select>
            </Field>
          </div>
          <label className="check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Ativo</label>
          <p className="muted small">Gerente: vendas, estoque, compras, relatórios e autoriza descontos. Operador de caixa: frente de caixa, caixa e crediário. Vendedor: vendas e clientes. Administrador: tudo, inclusive estas configurações.</p>
        </Modal>
      )}
    </div>
    </>
  );
}

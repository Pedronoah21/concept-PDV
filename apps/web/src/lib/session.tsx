import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { kv } from './idb';

export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    role: 'ADMIN' | 'GERENTE' | 'CAIXA' | 'VENDEDOR';
    maxDiscountPct: number;
    companyId: string;
    /** Loja do usuário (null = todas) e caixa padrão */
    storeId: string | null;
    registerId: string | null;
  };
  company: { id: string; slug: string; tradeName: string; legalName: string; cnpj: string; ie: string | null; fiscalProvider: string; fiscalEnv: string; receiptFooter: string | null };
  stores: { id: string; name: string; isOnline: boolean; registers: { id: string; code: string; name: string }[] }[];
}

interface SessionCtx {
  me: Me | null;
  loading: boolean;
  /** Caixa (terminal) configurado neste computador */
  registerId: string | null;
  setRegisterId: (id: string) => void;
  store: Me['stores'][number] | null;
  register: Me['stores'][number]['registers'][number] | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (perm: Perm) => boolean;
}

type Perm = 'gerencia' | 'admin' | 'caixa';

const Ctx = createContext<SessionCtx>(null as never);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [registerId, setRegister] = useState<string | null>(() => localStorage.getItem('cpdv:register'));

  const refresh = useCallback(async () => {
    try {
      const data = await api<Me>('/auth/me');
      setMe(data);
      await kv.set('me', data);
    } catch (e) {
      // Sem internet: segue com a última sessão conhecida para o caixa continuar vendendo.
      if (e instanceof ApiError && e.offline) setMe((await kv.get<Me>('me')) ?? null);
      else {
        setMe(null);
        await kv.del('me');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const onUnauthorized = () => {
      setMe(null);
      kv.del('me');
    };
    window.addEventListener('cpdv:unauthorized', onUnauthorized);
    return () => window.removeEventListener('cpdv:unauthorized', onUnauthorized);
  }, [refresh]);

  const setRegisterId = (id: string) => {
    localStorage.setItem('cpdv:register', id);
    setRegister(id);
  };

  // Caixa usado neste computador, na ordem: caixa padrão do usuário → o escolhido aqui antes
  // (se ainda for da loja dele) → o único caixa disponível. Sem nada disso, a tela pede para escolher.
  const allRegisters = me?.stores.flatMap((s) => s.registers) ?? [];
  const effectiveRegister =
    (me?.user.registerId && allRegisters.find((r) => r.id === me.user.registerId)?.id) ||
    (registerId && allRegisters.find((r) => r.id === registerId)?.id) ||
    (allRegisters.length === 1 ? allRegisters[0].id : null);
  const store = me?.stores.find((s) => s.registers.some((r) => r.id === effectiveRegister)) ?? null;
  const register = store?.registers.find((r) => r.id === effectiveRegister) ?? null;
  const role = me?.user.role;

  const value: SessionCtx = {
    me,
    loading,
    registerId: register ? effectiveRegister : null,
    setRegisterId,
    store,
    register,
    refresh,
    logout: async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
      await kv.del('me');
      setMe(null);
    },
    can: (perm) =>
      role === 'ADMIN' || (perm === 'gerencia' && role === 'GERENTE') || (perm === 'caixa' && (role === 'GERENTE' || role === 'CAIXA')),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

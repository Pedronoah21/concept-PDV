import { useCallback, useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { api } from '../lib/api';
import { centsToInput, parseMoney } from '../lib/format';

// ---------------- Avisos rápidos ----------------
type ToastMsg = { text: string; kind?: 'danger' };
let pushToast: (t: ToastMsg) => void = () => undefined;
export const toast = (text: string) => pushToast({ text });
export const toastError = (e: unknown) => pushToast({ text: e instanceof Error ? e.message : String(e), kind: 'danger' });

export function ToastHost() {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    pushToast = (m) => {
      setMsg(m);
      clearTimeout(t);
      t = setTimeout(() => setMsg(null), m.kind ? 6000 : 3000);
    };
  }, []);
  return msg ? (
    <div className={`toast ${msg.kind ?? ''}`} role="status">
      {msg.text}
    </div>
  ) : null;
}

// ---------------- Carregamento de dados ----------------
export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export function Loading({ error, loading }: { error?: string | null; loading?: boolean }) {
  if (error) return <div className="notice danger">{error}</div>;
  if (loading) return <div className="empty">Carregando…</div>;
  return null;
}

// ---------------- Campos ----------------
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

/** Campo de dinheiro em reais; o valor real é sempre em centavos. */
export function MoneyInput({
  value,
  onChange,
  className = '',
  ref,
  ...rest
}: { value: number; onChange: (cents: number) => void; ref?: Ref<HTMLInputElement> } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(centsToInput(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(centsToInput(value));
  }, [value]);
  return (
    <input
      ref={ref}
      className={`input num ${className}`}
      inputMode="decimal"
      value={text}
      onFocus={(e) => {
        focused.current = true;
        e.target.select();
      }}
      onBlur={() => {
        focused.current = false;
        setText(centsToInput(value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseMoney(e.target.value));
      }}
      {...rest}
    />
  );
}

// ---------------- Janela modal ----------------
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Fechar">
            Fechar <kbd>Esc</kbd>
          </button>
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/** Executa uma ação com estado de "enviando" e aviso de erro. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const run = async (...args: A): Promise<R | undefined> => {
    setBusy(true);
    try {
      return await fn(...args);
    } catch (e) {
      toastError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return [run, busy] as const;
}

export const STATUS_TAG: Record<string, string> = {
  CONCLUIDA: 'go',
  AUTORIZADA: 'go',
  ENTREGUE: 'go',
  PAGO: 'go',
  PAGA: 'go',
  PENDENTE: 'warn',
  PROCESSANDO: 'warn',
  ABERTA: 'warn',
  SEPARACAO: 'warn',
  ENVIADO: 'warn',
  CANCELADA: 'danger',
  CANCELADO: 'danger',
  REJEITADA: 'danger',
  ERRO: 'danger',
};

export const STATUS_LABEL: Record<string, string> = {
  CONCLUIDA: 'Concluída',
  CANCELADA: 'Cancelada',
  AUTORIZADA: 'Autorizada',
  PENDENTE: 'Pendente',
  PROCESSANDO: 'Processando',
  REJEITADA: 'Rejeitada',
  ERRO: 'Erro',
  PAGO: 'Pago',
  SEPARACAO: 'Em separação',
  ENVIADO: 'Enviado',
  ENTREGUE: 'Entregue',
  CANCELADO: 'Cancelado',
  ABERTA: 'Em aberto',
  PAGA: 'Paga',
};

export function Status({ s }: { s: string }) {
  return <span className={`tag ${STATUS_TAG[s] ?? ''}`}>{STATUS_LABEL[s] ?? s}</span>;
}

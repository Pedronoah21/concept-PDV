import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { BASE, withBase } from './base';

/** Roteador mínimo sobre a History API (sem dependências). */
const listeners = new Set<() => void>();

/** Caminho atual sem o prefixo de publicação: '/pdv/vendas' → '/vendas'. */
export function currentPath() {
  const p = location.pathname;
  if (!BASE) return p;
  if (p === BASE) return '/';
  return p.startsWith(`${BASE}/`) ? p.slice(BASE.length) : p;
}

/** Recebe caminhos do app ('/vendas'), sem o prefixo. */
export function navigate(to: string, replace = false) {
  const url = withBase(to);
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  listeners.forEach((l) => l());
}

window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function usePath() {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const l = () => setPath(currentPath());
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return path;
}

export function useQuery() {
  usePath();
  return new URLSearchParams(location.search);
}

/** Casa "/vendas/:id" com "/vendas/abc" → { id: 'abc' } */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={withBase(to)}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}

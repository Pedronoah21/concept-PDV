import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Mesmo BASE_PATH do servidor, ex.: "/pdv" para cedcci.com.br/pdv. */
const base = (process.env.BASE_PATH ?? '').trim().replace(/\/+$/, '');
const prefix = base && !base.startsWith('/') ? `/${base}` : base;

export default defineConfig({
  base: `${prefix}/`,
  plugins: [react()],
  server: {
    port: 5173,
    // Mesma origem para o cookie de sessão funcionar sem configuração extra.
    proxy: { [`${prefix}/api`]: 'http://localhost:3333' },
  },
});

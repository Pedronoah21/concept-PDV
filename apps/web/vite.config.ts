import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Mesma origem para o cookie de sessão funcionar sem configuração extra.
    proxy: { '/api': 'http://localhost:3333' },
  },
});

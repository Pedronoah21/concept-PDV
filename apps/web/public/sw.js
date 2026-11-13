// Service worker do Concept PDV: mantém a aplicação abrindo sem internet.
// Os dados (produtos, vendas pendentes) ficam no IndexedDB, não aqui.
// Funciona em qualquer caminho de publicação (ex.: cedcci.com.br/pdv/): tudo é relativo ao escopo.
const CACHE = 'concept-pdv-v2';
const BASE = new URL(self.registration.scope).pathname; // ex.: "/pdv/" ou "/"
const INDEX = BASE + 'index.html';
const SHELL = [BASE, INDEX, BASE + 'manifest.webmanifest', BASE + 'icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith(BASE + 'api/')) return;
  // Só cuida do que é deste app (o domínio pode ter outros sistemas).
  if (url.origin === self.location.origin && !url.pathname.startsWith(BASE)) return;

  // Navegação: tenta a rede, e sem internet abre a aplicação guardada.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(INDEX, copy));
          return res;
        })
        .catch(() => caches.match(INDEX)),
    );
    return;
  }

  // Arquivos da aplicação e fontes: usa o que tem e atualiza em segundo plano.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok || res.type === 'opaque') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

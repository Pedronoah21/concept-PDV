import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Prisma } from '@prisma/client';
import { AppError } from './lib/errors';
import authRoutes from './routes/auth';
import catalogRoutes from './routes/catalog';
import salesRoutes from './routes/sales';
import businessRoutes from './routes/business';
import adminRoutes from './routes/admin';
import publicRoutes from './routes/public';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });

  await app.register(cookie, { secret: process.env.COOKIE_SECRET });
  await app.register(cors, {
    origin: (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return reply.code(409).send({ error: 'Registro duplicado', code: 'DUPLICADO' });
      if (err.code === 'P2025') return reply.code(404).send({ error: 'Registro não encontrado', code: 'NAO_ENCONTRADO' });
    }
    if ((err as { statusCode?: number }).statusCode === 429) return reply.code(429).send({ error: 'Muitas tentativas. Aguarde um pouco.', code: 'LIMITE' });
    if ((err as { validation?: unknown }).validation) return reply.code(400).send({ error: err.message, code: 'DADOS_INVALIDOS' });
    req.log.error(err);
    return reply.code(500).send({ error: 'Erro interno', code: 'ERRO_INTERNO' });
  });

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(publicRoutes);
      await api.register(catalogRoutes);
      await api.register(salesRoutes);
      await api.register(businessRoutes);
      await api.register(adminRoutes);
    },
    { prefix: '/api' },
  );

  // Produção: a própria API entrega o app (PDV, retaguarda e loja online) já compilado.
  const webDist = process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Rota não encontrada', code: 'NAO_ENCONTRADO' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

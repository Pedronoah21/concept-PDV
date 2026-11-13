import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { parse } from '../lib/http';
import { createOrder, orderInput, publicCatalog } from '../services/orders';

/** Rotas abertas da loja online (sem login). */
export default async function publicRoutes(app: FastifyInstance) {
  /** Nome da loja e endereço da loja online, para a página de apresentação. */
  app.get('/public/info', async () => {
    const c = await prisma.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { tradeName: true, slug: true, onlineStoreOn: true } });
    return c ? { name: c.tradeName, shopSlug: c.onlineStoreOn ? c.slug : null } : { name: null, shopSlug: null };
  });
  app.get('/public/:slug/catalog', async (req) => publicCatalog((req.params as { slug: string }).slug));
  app.post('/public/:slug/orders', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const order = await createOrder((req.params as { slug: string }).slug, parse(orderInput, req.body));
    reply.code(201);
    return order;
  });
}

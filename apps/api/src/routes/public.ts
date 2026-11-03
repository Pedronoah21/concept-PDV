import type { FastifyInstance } from 'fastify';
import { parse } from '../lib/http';
import { createOrder, orderInput, publicCatalog } from '../services/orders';

/** Rotas abertas da loja online (sem login). */
export default async function publicRoutes(app: FastifyInstance) {
  app.get('/public/:slug/catalog', async (req) => publicCatalog((req.params as { slug: string }).slug));
  app.post('/public/:slug/orders', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const order = await createOrder((req.params as { slug: string }).slug, parse(orderInput, req.body));
    reply.code(201);
    return order;
  });
}

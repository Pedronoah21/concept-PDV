import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db';
import { createSession, destroySession, requireAuth, SESSION_COOKIE, signApproval, verifyCredentials } from '../lib/auth';
import { forbidden } from '../lib/errors';
import { parse } from '../lib/http';

const loginInput = z.object({ email: z.string().email(), password: z.string().min(1), companySlug: z.string().optional() });
const approveInput = z.object({ email: z.string().email(), password: z.string().min(1), scope: z.enum(['desconto', 'cancelamento']), maxPct: z.number().min(0).max(100).default(100) });

export default async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(loginInput, req.body);
    const user = await verifyCredentials(body.email, body.password, body.companySlug);
    const { token, expiresAt } = await createSession(user.id, req.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      expires: expiresAt,
    });
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    await destroySession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const company = await prisma.company.findUniqueOrThrow({
      where: { id: req.user.companyId },
      select: { id: true, slug: true, tradeName: true, legalName: true, cnpj: true, ie: true, phone: true, street: true, number: true, district: true, city: true, uf: true, receiptFooter: true, fiscalProvider: true, fiscalEnv: true },
    });
    const stores = await prisma.store.findMany({
      where: { companyId: company.id, active: true, ...(req.user.storeId ? { id: req.user.storeId } : {}) },
      include: { registers: { where: { active: true }, orderBy: { code: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    return { user: req.user, company, stores };
  });

  /** Gerente digita a senha no caixa do operador e libera desconto/cancelamento. */
  app.post('/auth/approve', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(approveInput, req.body);
    const manager = await verifyCredentials(body.email, body.password);
    if (manager.companyId !== req.user.companyId || !['ADMIN', 'GERENTE'].includes(manager.role)) throw forbidden('Usuário não é gerente');
    return { token: signApproval({ uid: manager.id, cid: manager.companyId, scope: body.scope, maxPct: body.maxPct }), manager: manager.name };
  });
}

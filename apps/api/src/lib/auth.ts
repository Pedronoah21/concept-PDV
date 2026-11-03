import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import type { Role } from '@prisma/client';
import { prisma } from '../db';
import { AppError, forbidden } from './errors';

export const SESSION_COOKIE = 'cpdv_session';
const SESSION_DAYS = 7;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export interface AuthUser {
  id: string;
  companyId: string;
  name: string;
  email: string;
  role: Role;
  maxDiscountPct: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);

/** Verifica e-mail/senha com bloqueio após tentativas inválidas (inspirado no Hórus PDV). */
export async function verifyCredentials(email: string, password: string, companySlug?: string) {
  const users = await prisma.user.findMany({
    where: { email: email.toLowerCase().trim(), active: true, ...(companySlug ? { company: { slug: companySlug } } : {}) },
  });
  if (users.length > 1) throw new AppError(400, 'Informe a empresa para entrar', 'EMPRESA_OBRIGATORIA');
  const user = users[0];
  const invalid = new AppError(401, 'E-mail ou senha inválidos', 'CREDENCIAIS_INVALIDAS');
  if (!user) {
    await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvali'); // tempo constante
    throw invalid;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(423, 'Usuário bloqueado por excesso de tentativas. Tente mais tarde.', 'USUARIO_BLOQUEADO');
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins: failed >= MAX_FAILED ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    });
    throw invalid;
  }
  if (user.failedLogins > 0 || user.lockedUntil) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  }
  return user;
}

export async function createSession(userId: string, userAgent?: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await prisma.session.create({ data: { id: sha256(token), userId, expiresAt, userAgent } });
  return { token, expiresAt };
}

export async function destroySession(token: string | undefined) {
  if (token) await prisma.session.deleteMany({ where: { id: sha256(token) } });
}

export async function requireAuth(req: FastifyRequest) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw new AppError(401, 'Sessão expirada. Entre novamente.', 'NAO_AUTENTICADO');
  const session = await prisma.session.findUnique({ where: { id: sha256(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date() || !session.user.active) {
    throw new AppError(401, 'Sessão expirada. Entre novamente.', 'NAO_AUTENTICADO');
  }
  const u = session.user;
  req.user = { id: u.id, companyId: u.companyId, name: u.name, email: u.email, role: u.role, maxDiscountPct: u.maxDiscountPct };
}

/** Permissões por perfil. ADMIN pode tudo. */
const PERMISSIONS: Record<string, Role[]> = {
  'venda:criar': ['ADMIN', 'GERENTE', 'CAIXA', 'VENDEDOR'],
  'venda:cancelar': ['ADMIN', 'GERENTE'],
  'venda:devolver': ['ADMIN', 'GERENTE', 'CAIXA'],
  'caixa:operar': ['ADMIN', 'GERENTE', 'CAIXA'],
  'caixa:ver-esperado': ['ADMIN', 'GERENTE'],
  'produto:editar': ['ADMIN', 'GERENTE'],
  'estoque:ajustar': ['ADMIN', 'GERENTE'],
  'compra:lancar': ['ADMIN', 'GERENTE'],
  'cliente:editar': ['ADMIN', 'GERENTE', 'CAIXA', 'VENDEDOR'],
  'crediario:receber': ['ADMIN', 'GERENTE', 'CAIXA'],
  'pedido:gerir': ['ADMIN', 'GERENTE'],
  'fiscal:gerir': ['ADMIN', 'GERENTE'],
  'relatorio:ver': ['ADMIN', 'GERENTE'],
  'custo:ver': ['ADMIN', 'GERENTE'],
  'config:editar': ['ADMIN'],
};

export function can(user: AuthUser, permission: keyof typeof PERMISSIONS | string) {
  if (user.role === 'ADMIN') return true;
  return (PERMISSIONS[permission] ?? []).includes(user.role);
}

export function assertCan(user: AuthUser, permission: string) {
  if (!can(user, permission)) throw forbidden();
}

export const guard = (permission: string) => async (req: FastifyRequest, _reply: FastifyReply) => {
  assertCan(req.user, permission);
};

// ---------------------------------------------------------------------------
// Autorização de gerente (desconto acima do limite, cancelamento no caixa).
// Token curto assinado com HMAC; não precisa ser guardado no banco.
// ---------------------------------------------------------------------------
const secret = () => process.env.COOKIE_SECRET ?? 'dev-secret';

export function signApproval(payload: { uid: string; cid: string; scope: string; maxPct: number }, minutes = 10) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + minutes * 60_000 })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyApproval(token: string | null | undefined, companyId: string, scope: string) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
    uid: string;
    cid: string;
    scope: string;
    maxPct: number;
    exp: number;
  };
  if (data.cid !== companyId || data.scope !== scope || data.exp < Date.now()) return null;
  return data;
}

/**
 * Primeira instalação em produção: cria a empresa, a loja, o caixa e o administrador
 * a partir de variáveis de ambiente. Seguro para rodar a cada deploy (não faz nada se já existir).
 *
 *   COMPANY_NAME   nome fantasia da loja
 *   COMPANY_SLUG   endereço da loja online: /loja/<slug>
 *   ADMIN_EMAIL    e-mail de login do administrador
 *   ADMIN_PASSWORD senha inicial (troque no primeiro acesso em Configurações → Usuários)
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const { COMPANY_NAME, COMPANY_SLUG, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!COMPANY_NAME || !COMPANY_SLUG || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log('bootstrap: variáveis COMPANY_* / ADMIN_* não definidas — nada a fazer.');
    return;
  }
  if (await prisma.company.findUnique({ where: { slug: COMPANY_SLUG } })) {
    console.log(`bootstrap: empresa "${COMPANY_SLUG}" já existe — nada a fazer.`);
    return;
  }
  if (ADMIN_PASSWORD.length < 10) throw new Error('ADMIN_PASSWORD precisa ter ao menos 10 caracteres');

  const company = await prisma.company.create({
    data: {
      slug: COMPANY_SLUG,
      // CNPJ provisório: o administrador informa o real em Configurações → Empresa.
      cnpj: `provisorio-${COMPANY_SLUG}`.slice(0, 40),
      legalName: COMPANY_NAME,
      tradeName: COMPANY_NAME,
      fiscalProvider: 'mock',
    },
  });
  const store = await prisma.store.create({ data: { companyId: company.id, name: 'Loja principal', isOnline: true } });
  await prisma.register.create({ data: { storeId: store.id, code: 'CX01', name: 'Caixa 01' } });
  await prisma.user.create({
    data: {
      companyId: company.id,
      name: 'Administrador',
      email: ADMIN_EMAIL.toLowerCase(),
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
      role: 'ADMIN',
      maxDiscountPct: 100,
    },
  });
  console.log(`bootstrap: empresa "${COMPANY_NAME}" criada com o administrador ${ADMIN_EMAIL}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

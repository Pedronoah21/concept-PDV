/**
 * Aplica as migrações do banco com segurança, a cada deploy.
 *
 * Bancos criados antes das migrações versionadas (com `prisma db push`) já têm as tabelas
 * da migração 0_init: nesse caso ela é só registrada como aplicada, e as seguintes rodam.
 * Banco novo: todas as migrações rodam normalmente.
 *
 * Para evoluir o banco: altere schema.prisma e rode `pnpm --filter @concept/api db:migrate:dev`.
 * Nunca edite uma migração que já foi publicada.
 */
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const [row] = await prisma.$queryRaw<{ migrations: string | null; company: string | null }[]>`
    SELECT to_regclass('"_prisma_migrations"')::text AS migrations, to_regclass('"Company"')::text AS company`;
  await prisma.$disconnect();

  if (!row.migrations && row.company) {
    console.log('migrate: banco criado antes das migrações — registrando 0_init como aplicada.');
    execSync('prisma migrate resolve --applied 0_init', { stdio: 'inherit' });
  }
  execSync('prisma migrate deploy', { stdio: 'inherit' });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

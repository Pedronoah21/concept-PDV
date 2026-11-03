import { buildApp } from './app';
import { prisma } from './db';
import { processFiscalQueue } from './fiscal/queue';

const port = Number(process.env.PORT ?? 3333);
const app = await buildApp({ logger: true });

// Fila fiscal: reenvia notas pendentes (internet ou SEFAZ fora do ar) a cada 5 segundos.
const timer = setInterval(() => {
  processFiscalQueue().catch((err) => app.log.error({ err }, 'falha na fila fiscal'));
}, 5_000);

async function shutdown() {
  clearInterval(timer);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port, host: '0.0.0.0' });

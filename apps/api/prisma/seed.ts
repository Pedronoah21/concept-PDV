/**
 * Dados de demonstração: uma loja de roupas com grade, estoque e usuários de cada perfil.
 * Rode com `pnpm db:seed`. Não use em produção.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { internalEAN13 } from '@concept/shared';

const prisma = new PrismaClient();

async function main() {
  if (await prisma.company.findUnique({ where: { slug: 'demo' } })) {
    console.log('Empresa demo já existe — nada a fazer.');
    return;
  }
  const company = await prisma.company.create({
    data: {
      slug: 'demo',
      cnpj: '11222333000181',
      legalName: 'Concept Moda Ltda',
      tradeName: 'Concept Moda',
      ie: '123456789',
      crt: 1,
      phone: '(92) 99999-0000',
      street: 'Av. Eduardo Ribeiro',
      number: '100',
      district: 'Centro',
      city: 'Manaus',
      cityCode: '1302603',
      uf: 'AM',
      zip: '69010001',
      receiptFooter: 'Trocas em até 30 dias com a etiqueta. Obrigado pela preferência!',
      fiscalProvider: 'mock',
    },
  });
  const loja = await prisma.store.create({ data: { companyId: company.id, name: 'Loja Centro', isOnline: true } });
  await prisma.register.createMany({
    data: [
      { storeId: loja.id, code: 'CX01', name: 'Caixa 01' },
      { storeId: loja.id, code: 'CX02', name: 'Caixa 02' },
    ],
  });

  const pass = await bcrypt.hash('concept123', 10);
  await prisma.user.createMany({
    data: [
      { companyId: company.id, name: 'Administrador', email: 'admin@demo.com', passwordHash: pass, role: 'ADMIN', maxDiscountPct: 100 },
      { companyId: company.id, name: 'Gerente', email: 'gerente@demo.com', passwordHash: pass, role: 'GERENTE', maxDiscountPct: 30 },
      { companyId: company.id, name: 'Operador de Caixa', email: 'caixa@demo.com', passwordHash: pass, role: 'CAIXA', maxDiscountPct: 5 },
    ],
  });

  const cats = Object.fromEntries(
    await Promise.all(
      ['Camisetas', 'Calças', 'Vestidos', 'Acessórios'].map(async (name) => [name, (await prisma.category.create({ data: { companyId: company.id, name } })).id]),
    ),
  );

  let ean = 0;
  let code = 0;
  const catalog = [
    { name: 'Camiseta Básica Algodão', brand: 'Concept', cat: 'Camisetas', ncm: '61091000', price: 5990, cost: 2200, colors: ['Branca', 'Preta', 'Azul'], sizes: ['P', 'M', 'G', 'GG'] },
    { name: 'Calça Jeans Slim', brand: 'Denim Co', cat: 'Calças', ncm: '62034200', price: 18990, cost: 7900, colors: ['Azul escuro'], sizes: ['38', '40', '42', '44'] },
    { name: 'Vestido Midi Floral', brand: 'Concept', cat: 'Vestidos', ncm: '62044400', price: 15990, cost: 6100, colors: ['Floral'], sizes: ['P', 'M', 'G'] },
    { name: 'Boné Aba Curva', brand: 'Urban', cat: 'Acessórios', ncm: '65050090', price: 7990, cost: 2900, colors: ['Preto'], sizes: [null] },
  ];
  for (const item of catalog) {
    code++;
    const product = await prisma.product.create({
      data: { companyId: company.id, name: item.name, brand: item.brand, categoryId: cats[item.cat], ncm: item.ncm, cfop: '5102', csosn: '102' },
    });
    let k = 0;
    for (const color of item.colors) {
      for (const size of item.sizes) {
        k++;
        const v = await prisma.variant.create({
          data: {
            productId: product.id,
            sku: `${String(code).padStart(5, '0')}-${k}`,
            barcode: internalEAN13(++ean),
            color,
            size,
            priceCents: item.price,
            avgCostCents: item.cost,
            minStock: 2,
          },
        });
        const qty = 3 + ((k * 7) % 9);
        await prisma.stockBalance.create({ data: { variantId: v.id, storeId: loja.id, quantity: qty } });
        await prisma.stockMovement.create({
          data: { companyId: company.id, storeId: loja.id, variantId: v.id, type: 'AJUSTE', quantity: qty, balanceAfter: qty, unitCostCents: item.cost, reason: 'Saldo inicial (demo)' },
        });
      }
    }
  }
  await prisma.counter.createMany({
    data: [
      { companyId: company.id, key: 'ean', value: ean },
      { companyId: company.id, key: 'product', value: code },
    ],
  });
  await prisma.customer.create({
    data: { companyId: company.id, name: 'Maria da Silva', document: '52998224725', phone: '92988887777', creditLimitCents: 100000, city: 'Manaus', uf: 'AM' },
  });
  console.log('Empresa demo criada. Acesse com admin@demo.com / concept123');
}

main().finally(() => prisma.$disconnect());

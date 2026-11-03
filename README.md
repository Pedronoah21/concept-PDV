# Concept PDV

Ponto de venda para varejo, do balcão à loja online, da entrada da mercadoria à nota fiscal.
Funciona **com ou sem internet**: o caixa continua vendendo quando a conexão cai e envia tudo
sozinho quando ela volta.

Criado a partir da análise de 14 projetos de PDV e ERP open source — veja o que foi aproveitado
de cada um em [docs/ANALISE.md](docs/ANALISE.md).

## O que ele faz

**Frente de caixa (PDV)**
- Leitura de código de barras, busca por nome sem acento, multiplicador (`3*código`)
- Atalhos: <kbd>F2</kbd> buscar, <kbd>F4</kbd> cliente/CPF, <kbd>F6</kbd> desconto, <kbd>F10</kbd> pagamento, <kbd>Del</kbd> remover item
- Vários pagamentos na mesma venda: dinheiro (com troco), PIX, débito, crédito parcelado, crediário, vale-troca
- Desconto por item ou na venda; acima do limite do operador, o gerente autoriza com a senha dele
- **Venda offline**: catálogo guardado no computador, número provisório por caixa (`CX01-000123`),
  fila de envio e reenvio seguro — a mesma venda nunca é gravada duas vezes
- Cupom em 80 mm ou 58 mm direto na térmica ESC/POS (Chrome/Edge), com QR Code da NFC-e e
  abertura de gaveta; ou por qualquer impressora instalada, com o link de consulta e o DANFE do emissor
- Instala como aplicativo (PWA) no Windows, Linux, macOS, Android

**Caixa**
- Abertura com fundo de troco, sangria, suprimento
- Fechamento **cego** (o operador conta antes de ver o esperado) com diferença por forma de pagamento

**Mercadoria**
- Código do produto definido pela loja (ou gerado automaticamente), herdado pelas variações
- Produto com grade cor × tamanho gerada de uma vez; código de barras interno (EAN-13) quando o produto não tem
- Dados fiscais no cadastro: NCM, CEST, CFOP, origem, CSOSN/CST, alíquota, PIS/COFINS
- Estoque como livro de movimentos: toda alteração tem origem, usuário, motivo e saldo resultante
- Ajuste, perda, inventário e transferência entre lojas
- **Entrada de mercadoria pelo XML da NF-e do fornecedor**: lê fornecedor, itens, frete e desconto,
  reconhece os produtos pelo código de barras e cadastra os novos com um clique
- Frete e despesas rateados no custo; **custo médio ponderado** automático; contas a pagar parceladas

**Clientes e crediário**
- Cadastro com busca de endereço pelo CEP
- Crediário com limite de crédito, parcelas, recebimento parcial e lembrete pelo WhatsApp
- Troca/devolução parcial com reembolso em dinheiro ou **vale-troca**

**Loja online** (`/loja/<sua-loja>`)
- Catálogo com fotos, cores e tamanhos, usando o **mesmo estoque** do balcão
- O pedido **reserva** as peças; confirmar pagamento → faturar → baixa o estoque e emite a nota
- NFC-e para retirada ou entrega no mesmo estado; NF-e (modelo 55) para outro estado

**Nota fiscal**
- NFC-e e NF-e por API de emissão ([Focus NFe](https://focusnfe.com.br)), com simulador para treino
- Fila com reenvio automático (internet ou SEFAZ fora do ar), cancelamento com justificativa
- Camada plugável: outro emissor é um arquivo novo em `apps/api/src/fiscal/providers.ts`

**Gestão**
- Painel: faturamento, ticket médio, lucro bruto e margem, formas de pagamento, mais vendidos
- Curva ABC, produtos parados (capital empatado), estoque abaixo do mínimo
- Perfis: administrador, gerente, operador de caixa, vendedor
- Multiempresa, várias lojas e vários caixas
- Sessão em cookie HttpOnly, bloqueio após 5 senhas erradas, limite de tentativas, log de auditoria

## Como rodar

Requisitos: Node.js 20+, pnpm 10+ e PostgreSQL 14+ (ou Docker).

```bash
git clone https://github.com/Pedronoah21/concept-PDV.git
cd concept-PDV
pnpm install
docker compose up -d                    # PostgreSQL local (ou use o seu)
cp apps/api/.env.example apps/api/.env  # ajuste se necessário
pnpm --filter @concept/api db:setup     # cria as tabelas e a loja de demonstração
pnpm dev                                # API em :3333 e app em :5173
```

Abra http://localhost:5173 e entre com:

| Perfil | E-mail | Senha |
|---|---|---|
| Administrador | admin@demo.com | concept123 |
| Gerente | gerente@demo.com | concept123 |
| Operador de caixa | caixa@demo.com | concept123 |

A loja online de demonstração fica em http://localhost:5173/loja/demo.

### Testes

```bash
pnpm test
```

Inclui um teste ponta a ponta contra o PostgreSQL que percorre o ciclo inteiro: cadastro com grade,
entrada com custo médio, abertura de caixa, venda com troco e NFC-e, reenvio sem duplicar,
autorização de desconto, venda offline, crediário, devolução com vale-troca, cancelamento,
fechamento cego, pedido online com reserva e NF-e interestadual, e a conferência de que o saldo
de estoque bate com o livro de movimentos.

### Produção

```bash
pnpm build
NODE_ENV=production COOKIE_SECRET=<segredo-longo> DATABASE_URL=<postgres> \
  pnpm --filter @concept/api start
```

A API entrega o app compilado no mesmo endereço (porta 3333). Coloque um proxy com HTTPS
(Caddy, Nginx, Cloudflare) na frente: o navegador só instala o PWA e libera a impressão direta
em endereço seguro.

## Colocando a nota fiscal em produção

1. Crie a conta na Focus NFe, cadastre a empresa, envie o **certificado digital A1** e o **CSC** da NFC-e.
2. Em **Configurações → Nota fiscal**, escolha Focus NFe, ambiente **Homologação** e cole o token.
3. Faça vendas de teste e confira em **Notas fiscais**. Peça ao contador para revisar NCM, CFOP e CSOSN/CST dos produtos.
4. Só então mude para **Produção**.

## Estrutura

```
apps/api        API (Fastify + Prisma + PostgreSQL)
  prisma/         modelo de dados e dados de demonstração
  src/services/   regras de negócio: vendas, estoque, compras, caixa, pedidos
  src/fiscal/     montagem da NFC-e/NF-e, emissores e fila
  src/routes/     rotas HTTP
apps/web        App (React): PDV, retaguarda, loja online, modo offline
packages/shared Regras comuns ao caixa e ao servidor: dinheiro, carrinho, cupom, ESC/POS
docs/           Análise das referências e próximos passos
```

O banco evolui por migrações versionadas em `apps/api/prisma/migrations`: altere `schema.prisma`,
rode `pnpm --filter @concept/api db:migrate:dev` e publique a migração gerada. Nunca edite uma
migração já publicada; a cada deploy, `deploy:prepare` aplica as pendentes.

Regras que valem para o código todo: dinheiro sempre em centavos inteiros; estoque só muda por
`moveStock`; vendas são idempotentes pelo ID gerado no caixa; nada fiscal é apagado.

## Próximos passos

Veja [docs/ROADMAP.md](docs/ROADMAP.md).

## Licença

MIT

# Análise das 14 referências

Este documento registra o que o Concept PDV aproveitou — e o que evitou — de cada projeto estudado.
Os quatro projetos brasileiros (11 a 14) foram lidos diretamente no código-fonte; os demais são
projetos amplamente conhecidos e foram avaliados pela arquitetura e pelo conjunto de recursos.

## Decisões que saíram da análise

| Decisão no Concept PDV | Inspirado em | Problema que resolve |
|---|---|---|
| Valores em **centavos inteiros** (nunca `float`/texto) | Erro comum no LojaUp (`REAL`) e Hórus (preços como `string`) | Arredondamento errado em totais, troco e impostos |
| Estoque como **livro de movimentos** com saldo resultante | LojaUp (`stock_movements.balance_after`), ERPNext (Stock Ledger) | Auditoria completa: toda alteração de saldo tem origem, usuário e motivo |
| **Produto → variações** (cor/tamanho, código de barras próprio) | LojaUp, Odoo (product.template/product.product) | Grade de varejo de moda sem duplicar cadastro |
| **Custo médio ponderado** com frete e despesas rateados na entrada | LojaUp (compras), ERPNext (moving average) | Margem e lucro reais por produto |
| **Sessão de caixa** com abertura, sangria, suprimento e conferência por forma de pagamento | Odoo POS, NexoPOS, LojaUp | Fechamento cego e diferença de caixa auditável |
| **PDV offline-first** com fila de envio e IDs gerados no caixa | Odoo POS (pedidos em fila e sincronização), POS Awesome | Vender sem internet sem duplicar venda ao reconectar |
| **Camada fiscal plugável** (provedor por adaptador) | Roadmap do Hórus e observação fiscal do LojaUp | Trocar Focus NFe por outro emissor sem mexer em vendas |
| **Dados fiscais no produto** (NCM, CEST, CFOP, origem, CSOSN/CST, PIS/COFINS) | Falta em todos os projetos brasileiros analisados | Sem isso, nenhuma NFC-e é emitida |
| **Devolução parcial** com retorno ao estoque e **vale-troca** com saldo | LojaUp (`returns`, `vouchers`), Open Source POS (gift cards) | Troca é rotina diária no varejo de roupas |
| **Crediário** com parcelas e baixa parcial | LojaUp | Forma de pagamento muito usada em lojas brasileiras |
| **Perfis de acesso** e senha de gerente para desconto acima do limite | LojaUp, NexoPOS | Evitar desconto e cancelamento sem autorização |
| **Sessão em cookie HttpOnly**, bloqueio por tentativas e rate limit | Hórus PDV | Token fora do alcance de scripts da página |
| Migrações versionadas e nunca editadas | LojaUp (`MIGRATIONS`), Prisma | Atualizar clientes sem perder dados |
| Loja online usando **o mesmo estoque** do PDV | Odoo (website + POS), NexoPOS (pedidos) | Não vender online o que já saiu no balcão |
| Atalhos de teclado em todo o PDV | POS Awesome, Open Source POS | Atendimento rápido com leitor de código de barras |

## Projeto a projeto

### 01. Open Source POS (PHP / CodeIgniter / MySQL)
**Aproveitado:** fluxo de venda maduro, cartões-presente, kits de itens, etiquetas com código de barras,
recibos configuráveis, múltiplos locais de estoque.
**Evitado:** interface datada e sem suporte offline; nada de fiscal brasileiro.

### 02. NexoPOS (Laravel + Vue)
**Aproveitado:** arquitetura modular, vários caixas por loja, pedidos com pagamento parcial,
cupons de desconto, permissões detalhadas.
**Evitado:** depende de servidor sempre online; licença e estrutura de módulos complexas para um time pequeno.

### 03. Lakasir (Laravel)
**Aproveitado:** separação clara entre compras, vendas e estoque; telas simples de cadastro.
**Evitado:** escopo enxuto demais para varejo com grade e crediário.

### 04. ERPNext (Frappe / Python)
**Aproveitado:** o conceito de *Stock Ledger* (cada movimento gera um lançamento imutável) e a
valoração por custo médio.
**Evitado:** peso de um ERP inteiro (contabilidade completa, manufatura) para uma loja.

### 05. POS Awesome (Vue para ERPNext)
**Aproveitado:** catálogo visual, busca por código de barras instantânea, atalhos de teclado,
várias formas de pagamento na mesma venda, devoluções a partir da venda original.
**Evitado:** amarrado ao ERPNext.

### 06. Dolibarr + TakePOS (PHP)
**Aproveitado:** interface de toque simples, vários terminais.
**Evitado:** foco em restaurante; impressão depende de conector externo.

### 07. Odoo Community — Ponto de Venda
**Aproveitado:** o melhor modelo offline estudado: o caixa guarda os pedidos localmente com
identificador próprio e envia quando volta a conexão; sessão com controle de abertura e fechamento.
**Evitado:** complexidade da plataforma e da localização fiscal brasileira (módulos OCA).

### 08. Electron
Avaliado para o caixa desktop. **Decisão:** a primeira versão é PWA (instala pelo navegador, um código só).
A arquitetura deixa o caminho aberto para empacotar o mesmo front em Electron/Tauri se for preciso
acesso direto a gaveta e balança.

### 09. better-sqlite3
Excelente para banco local em desktop (é o que o LojaUp usa). **Decisão:** no PWA o banco local é o
IndexedDB (via Dexie), que cumpre o mesmo papel no navegador; o servidor usa PostgreSQL.

### 10. node-escpos
Referência para os comandos ESC/POS. **Decisão:** o Concept PDV traz um gerador ESC/POS próprio e
leve (`packages/shared/src/escpos.ts`), que pode mandar o cupom para a térmica pela Web Serial do
Chrome; e um modelo HTML de 80 mm/58 mm que imprime por qualquer driver Windows.

### 11. ZigMoney — valdiney/zig (PHP / MySQL)
**Aproveitado:** foco na persona do pequeno comerciante, dois modos de PDV (padrão e completo),
exportação de relatórios, log de acessos.
**Evitado:** sem commits desde 2023; sem estoque por movimento nem fiscal.

### 12. izaiasmorais/pdv (Next.js + shadcn/ui)
**Aproveitado:** a pilha de interface (React, Tailwind, React Query, Zod).
**Evitado:** só existe a listagem de produtos; não há regra de negócio para reaproveitar.

### 13. Hórus PDV (.NET 8 + React)
**Aproveitado:** segurança de sessão (JWT em cookie HttpOnly, bloqueio por tentativas, rate limit),
consulta de endereço pelo CEP, teste ponta a ponta.
**Evitado:** modelo de produto guarda preço e quantidade como texto; fiscal e pagamentos ainda no roadmap.

### 14. LojaUp (Electron + React + SQLite)
O projeto mais completo e mais próximo do caso de uso (loja de roupas).
**Aproveitado:** produto com variações, livro de estoque, compras com frete rateado e custo médio,
crediário com parcelas, devolução com vale-troca, sessões de caixa, perfis admin/vendedor com senha de
gerente, modelos de cupom/carnê/etiqueta, relatórios de curva ABC e encalhados.
**Evitado:** valores em ponto flutuante, banco preso a uma máquina Windows, sem loja online e cupom
apenas não fiscal.

## O que o Concept PDV acrescenta

- Fiscal de verdade: NFC-e (cupom fiscal) e NF-e por API de emissão, com fila de reenvio.
- Funciona sem internet **e** centraliza os dados de todas as lojas/caixas no servidor.
- Loja online integrada ao mesmo estoque, com reserva no pedido e baixa no faturamento.
- Envio de vendas idempotente: a mesma venda enviada duas vezes nunca é gravada duas vezes.
- Multiempresa desde o primeiro dia (cada registro pertence a uma empresa).

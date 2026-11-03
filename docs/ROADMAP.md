# Próximos passos

O que a versão atual **não** faz ainda, em ordem de prioridade sugerida.

## Fiscal

- **Contingência offline da NFC-e (tpEmis 9).** Hoje, sem internet, a venda é registrada e a NFC-e é
  emitida quando a conexão volta. A contingência legal exige assinar o XML no próprio caixa com o
  certificado, imprimir o DANFE em contingência e transmitir em até 24h. Requer um agente local
  (Electron/Tauri) com acesso ao certificado A1.
- **NF-e de devolução/entrada** para trocas de vendas com NFC-e já autorizada fora do prazo de cancelamento.
- **Carta de correção** (NF-e) e **inutilização** de numeração.
- **Lei da Transparência (12.741/2012)**: valor aproximado de tributos no cupom (tabela IBPT).
- Validar o mapeamento de campos da Focus NFe em homologação com o certificado da loja
  (formas de pagamento com cartão, CEST por NCM, regras específicas do estado).
- Reforma tributária (IBS/CBS) conforme os leiautes forem obrigatórios.

## Pagamentos

- **PIX com QR Code dinâmico** e baixa automática (Mercado Pago, Efí, Asaas, Banco do Brasil).
- **TEF / maquininha integrada** (Stone, Cielo, PagSeguro), preenchendo bandeira e autorização na nota.
- Pagamento online na loja (hoje o pagamento é confirmado manualmente pelo lojista).

## Hardware

- Agente local para **balança** (produtos por peso, etiquetas de balança com preço no código).
- Impressão de **etiquetas de código de barras** (Argox, Zebra, Elgin) pelo cadastro e pela entrada.

## Operação

- Promoções agendadas (leve 3 pague 2, desconto por categoria, cupom da loja online).
- Programa de fidelidade (pontos/cashback).
- Comissão por vendedor.
- Sugestão de compra pelo ritmo de vendas e grade (vendas × estoque por tamanho).
- Fluxo de caixa e DRE (contas a receber além do crediário).
- Frete calculado na loja online (Correios/Melhor Envio) e fotos múltiplas por produto.
- Backup agendado do banco e exportação para Excel.
- Migrações versionadas do Prisma (`prisma migrate`) a partir da primeira instalação em produção.

# CONTRATO — Módulo Financeiro + Relatório em PDF (v1.1)

Adendo ao CONTRATO.md do projeto `~/workspace/pedidos-acai-guri/`. Pedido do Gabriel (21/10/2026):
controle financeiro interno da loja, calculadora de lucro real por venda e PDF do relatório do dia.
Dinheiro sempre em centavos. Datas de lançamento são TEXTO `YYYY-MM-DD` escolhidas pelo usuário
(sem problema de fuso). Pedidos filtrados por dia LOCAL: `date(created_at,'localtime')=?`
(NUNCA `date(created_at)=date('now')` — bug já corrigido uma vez neste projeto).

## Tabelas novas (SQLite + equivalentes no supabase/schema.sql)
- `fin_lancamentos`: `id, loja_id, tipo ('investimento'|'receita_manual'|'despesa'), categoria TEXT,
  descricao TEXT, valor_centavos INTEGER, data TEXT (YYYY-MM-DD), created_at`
- `fin_insumos`: `id, loja_id, nome TEXT, quantidade REAL, unidade TEXT, custo_total_centavos INTEGER,
  data TEXT (YYYY-MM-DD), created_at`
Criação com `CREATE TABLE IF NOT EXISTS` na subida (bancos da v1.0 atualizam no lugar).

## Definições do cálculo (para a data D selecionada)
- `vendas_sistema` = Σ `total_centavos` dos pedidos `status='ENTREGUE'` com dia local = D
- `pedidos_concluidos` = contagem desses pedidos · `cancelados` = idem status CANCELADO
- `copos` = Σ `pedido_itens.quantidade` dos pedidos concluídos (todo item vendido conta)
- `taxas_entrega` = Σ `taxa_entrega_centavos` dos concluídos · `entregas` = concluídos com tipo='entrega'
- `receita_manual` = Σ fin_lancamentos tipo='receita_manual' em D
- `receita_total` = vendas_sistema + receita_manual  ← "receita acumulada"
- `investimento_manual` = Σ tipo='investimento' em D
- `insumos_total` = Σ fin_insumos.custo_total_centavos em D
- `despesas` = Σ tipo='despesa' em D
- `custo_total` = insumos_total + despesas + investimento_manual
- **`lucro_real` = receita_total − custo_total**
- `preco_medio_copo` = copos>0 ? round(vendas_sistema / copos) : 0
- **`custo_por_copo` = copos>0 ? round(custo_total / copos) : 0**
- **`lucro_por_copo` = preco_medio_copo − custo_por_copo**
- `custo_medio_entrega` = entregas>0 ? round(despesas / entregas) : 0 (despesas médias por entrega)
Arredondamento: round half up nos valores "por unidade"; totais sempre exatos em centavos.

## API (tudo autenticado, prefixo /api/painel/financeiro)
- `GET /lancamentos?data=&tipo=` → lista (sem data = todos os recentes, limite 200, ordem data desc, id desc)
- `POST /lancamentos {tipo,categoria,descricao,valor_centavos,data}` · `PUT /lancamentos/:id` · `DELETE /lancamentos/:id` (exclusão real — é controle interno dele)
- `GET /insumos?data=` · `POST /insumos {nome,quantidade,unidade,custo_total_centavos,data}` · `PUT /insumos/:id` · `DELETE /insumos/:id`
- `GET /calculo?data=YYYY-MM-DD` → TODAS as definições acima + listas de apoio:
  `{data, vendas_sistema, pedidos_concluidos, cancelados, copos, taxas_entrega, entregas,
    receita_manual, receita_total, investimento_manual, insumos_total, despesas, custo_total,
    lucro_real, preco_medio_copo, custo_por_copo, lucro_por_copo, custo_medio_entrega}`
  (data ausente = hoje local)
- Validação: tipo ∈ os 3; valor_centavos > 0; data válida YYYY-MM-DD → senão 422 pt-BR.

## Relatório em PDF
- `GET /api/painel/relatorio/pdf?data=YYYY-MM-DD` (autenticado) → `application/pdf`,
  `Content-Disposition: attachment; filename="relatorio-YYYY-MM-DD.pdf"`.
- Gerar com **pdfkit** (adicionar a dependência). Conteúdo (1–2 páginas, limpo):
  cabeçalho com nome da loja + "Relatório do dia — DD/MM/YYYY"; bloco VENDAS (pedidos concluídos,
  cancelados, faturamento, ticket médio); POR FORMA DE PAGAMENTO (pix/dinheiro/cartão + online);
  TOP PRODUTOS (nome × qtd × valor) e TOP OPÇÕES; bloco FINANCEIRO DO DIA (receita manual,
  investimento, insumos, despesas, **lucro real** em destaque); rodapé "Gerado em <data/hora local>".
- `GET /api/painel/relatorio` passa a aceitar `?data=YYYY-MM-DD` opcional (default hoje, mesmo
  filtro local já corrigido) para a tela e o PDF usarem o mesmo dia.

## Painel (public/painel.html/.css/.js — NÃO mexer em loja nem em outras views além do necessário)
- Menu ganha **💰 Financeiro** (item novo na sidebar, após Relatório).
- View Financeiro:
  - Seletor de data (default hoje) que comanda tudo na tela.
  - Cards de resumo (de GET /calculo): Vendas do sistema (auto) · Receitas manuais · **Receita acumulada** ·
    Investimento · Insumos · Despesas · **LUCRO REAL** (card grande, verde se positivo/vermelho se negativo).
  - **Lançamentos**: formulário (tipo com chips coloridos: Investimento=roxo, Receita manual=verde,
    Despesa=vermelho; categoria com datalist: Combustível, Manutenção da moto, Embalagens, Insumos,
    Aluguel, Energia, Outros; descrição; valor R$; data) + tabela do dia com excluir/editar simples.
    Nota explicativa curta: "Receita manual = dinheiro que entrou fora do sistema (balcão, outro app).
    Não lance o mesmo valor como investimento E como insumo — conte uma vez só."
  - **🧮 Lucro por Venda (calculadora)**: tabela de insumos do dia (nome, quantidade, unidade,
    custo total) com formulário de adicionar (ex.: "Pote de açaí", 5, "kg", R$ 100,00) e excluir;
    botão grande **CALCULAR** que chama GET /calculo e mostra o resultado em destaque:
    custo real por copo, preço médio por copo, **lucro por copo**, lucro real do dia,
    + detalhamento (copos vendidos, entregas, taxas de entrega recebidas, custo médio por entrega).
    Texto de ajuda: "Cadastrou produto novo? As vendas dele entram sozinhas — é só lançar os insumos."
- View Relatório: ganha seletor de data (liga no GET /relatorio?data=) e botão **📄 Salvar PDF do dia**
  que baixa o PDF via fetch com o token (blob) — não link direto, por causa do Authorization.

## Fora de escopo
Fluxo de caixa multi-mês avançado, contas a pagar com vencimento, DRE, gráficos. (Podem vir depois.)

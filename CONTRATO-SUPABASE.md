# CONTRATO — Banco dual SQLite/Postgres (Supabase)

Pedido do Gabriel (que já tinha sido feito antes e ficou pendente): deixar o
banco pronto pro Supabase. Objetivo: o MESMO código roda local em SQLite
(sem DATABASE_URL) e em produção no Postgres do Supabase (com DATABASE_URL),
sem mudar comportamento nem as telas.

## Arquitetura (decidida — não reinventar)

- `src/db.js` continua sendo o ÚNICO ponto de acesso ao banco, exportando
  `get, all, run, execSql, ADMIN_HASH, seed, db` (compat) + novos:
  `init()`, `tx(fn)`, `modoBanco()` ('sqlite'|'postgres'), `fechar()`.
- **Todas as funções de dados viram async (Promise) nos DOIS modos.**
  Todo call site passa a usar `await`. Arquivos a varrer: server.js,
  src/pedidos.js, src/notificacoes.js, src/pagamentos.js, src/financeiro.js,
  src/comanda.js (se usar db), src/eventos.js (idem).
- Modo: `DATABASE_URL` presente e não-vazia → Postgres (driver `pg`, nova
  dependência). Senão → SQLite atual (`node:sqlite`, data/pedidos.db, DDL e
  seed no require como hoje).

## Tradução de dialeto (só no modo PG, dentro de db.js)

- Placeholders `?` → `$1..$n` em ordem.
- `datetime('now')` → `now()`.
- `date('now','localtime')` → `(now() AT TIME ZONE 'America/Sao_Paulo')::date`.
- `date(<expr>,'localtime')` → `(<expr> AT TIME ZONE 'America/Sao_Paulo')::date`.
- `INSERT OR IGNORE INTO ...` → `INSERT INTO ... ON CONFLICT DO NOTHING`.
- `run()` devolve `{ lastInsertRowid, changes }` nos dois modos:
  PG: INSERT sem RETURNING ganha ` RETURNING id` ao final; lastInsertRowid =
  rows[0].id; changes = rowCount. UPDATE/DELETE: changes = rowCount.
- Parsers de tipo do `pg` (setTypeParser):
  - 20 (int8) → Number; 1700 (numeric) → Number.
  - 1184 (timestamptz) → string ISO: trocar ' ' por 'T' e normalizar o offset
    final `+00`/`-03` para `+00:00`/`-03:00` (o front já sabe ler ISO com fuso;
    NÃO devolver objeto Date).
- Pool: max 5; ssl `{ rejectUnauthorized: false }` quando o host não for
  localhost/127.0.0.1. Erros de conexão no init → mensagem clara no log.

## Transações

- `tx(fn)`: SQLite → BEGIN/COMMIT/ROLLBACK em volta de `await fn(q)`;
  PG → client dedicado do pool + AsyncLocalStorage pra que get/all/run
  chamados dentro de `fn` usem o client da transação.
- `src/pedidos.js` criarPedido: trocar o BEGIN/COMMIT manual por
  `await tx(async (q) => { ... })` usando q.get/q.all/q.run.

## Inicialização

- DDL/seed SQLite no require: INALTERADO.
- Módulos com DDL no load (financeiro.js, notificacoes.js): guardar com
  `if (modoBanco() === 'sqlite')`. No PG o DDL vem do supabase/schema.sql.
- notificacoes.js: a carga do cache de config (hoje síncrona no load) vira
  `async function preparar()` exportada: garante a linha id=1 em
  config_notificacoes e carrega o cache. getCfg() continua síncrono lendo o cache.
- server.js: criar `const pronto = (async () => { await db.init(); await notif.preparar(); })();`
  e um middleware no topo das rotas /api que faz `await pronto` (se rejeitar,
  500 `{erro:'Banco de dados indisponível.'}`). `notif.iniciar()` continua só
  no listen local. api/index.js não muda (o middleware cobre a Vercel).
- `db.init()` PG: cria pool, `SELECT 1`, confere se a tabela `lojas` existe
  (senão erro claro: "rode supabase/schema.sql no SQL Editor do Supabase"),
  e **semeia se vazio** (lojas vazia → mesmo seed do SQLite: loja, admin com
  ADMIN_HASH, categorias/produtos/grupos/opções/vínculos, bairros,
  config_recebimentos — replicar valores EXATOS do seed() de db.js).
  Idempotente: segundo boot não duplica nada.

## supabase/schema.sql — ALINHAR AO CÓDIGO (bug conhecido)

- O schema atual converte flags pra BOOLEAN — **o código usa INTEGER 0/1**
  (`WHERE ativo=1`, inserts com 0/1) e o Postgres recusaria. Reescrever os
  tipos: flags viram INTEGER DEFAULT 0/1 (espelho fiel do DDL do db.js);
  PKs AUTOINCREMENT → `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
  (ou SERIAL); conferir coluna a coluna contra o DDL de db.js +
  financeiro.js + notificacoes.js (incl. lojas.som_pedido,
  config_notificacoes completa) e contra os ALTERs guardados
  (som_pedido). Money continua INTEGER (centavos). created_at/updated_at:
  `TIMESTAMPTZ DEFAULT now()`.

## Docs

- `.env.example`: adicionar `DATABASE_URL=` comentado, com exemplo do
  pooler do Supabase (porta 6543) e nota "sem DATABASE_URL = SQLite local".
- README: seção "Rodando com Supabase (produção)" — criar projeto →
  SQL Editor → colar supabase/schema.sql → Database → Connection string
  (pooler) → definir DATABASE_URL na Vercel → deploy; o app semeia sozinho
  no primeiro boot. Login inicial admin/admin123 (trocar).

## FORA DE ESCOPO

- Uploads continuam em disco local (Supabase Storage é outro passo; não mexer).
- Poller do Telegram em serverless (webhook já cobre). Não mexer nas telas.

## Aceite (evidência obrigatória no relatório)

1. `node --check` limpo em todos os .js alterados.
2. **Regressão SQLite**: boot limpo (sem DATABASE_URL), suíte: login OK;
   cardápio OK; POST pedido com os itens do seed (opções [2,4,6,8,18],
   produto 1) → total **2900**; transições até ENTREGUE; PUT/GET
   configurações (máscara); financeiro: insumos 20700 + despesa 3000 +
   receita manual 2000 + venda ENTREGUE 10500/4 copos → lucro_real **-11200**,
   custo_por_copo **5925**; relatório do dia responde.
3. **Postgres real**: instalar Postgres local (apt-get install -y postgresql;
   se indisponível, pacote npm `embedded-postgres` numa pasta /tmp FORA do
   projeto), createdb de teste, aplicar supabase/schema.sql, boot com
   DATABASE_URL → MESMA suíte com os MESMOS números; reiniciar o server e
   provar: dados persistem e o seed NÃO duplicou (contagens iguais).
4. Relatório final: arquivos alterados, decisões, saídas dos testes (números),
   e o que ficou fora (uploads).

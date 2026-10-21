# 🍧 Sistema de Pedidos — Açaí do Guri

Loja web de pedidos (estilo iFood) para uma loja só, com painel de operação, notificações por
WhatsApp (Evolution) e Telegram (dono), impressão térmica e pagamento presencial + online
(Mercado Pago / Asaas). Roda **local** num PC da loja; preparada para subir para
**Supabase + Vercel + GitHub**.

## Rodando localmente (desenvolvimento e operação na loja)

```bash
npm install
cp .env.example .env   # ajuste o que for usar (tudo é opcional no início)
npm start              # http://localhost:3333
```

- **Loja do cliente:** `http://localhost:3333/`
- **Painel:** `http://localhost:3333/painel` — login **admin / admin123** (troque em seguida:
  Painel → trocar senha, ou `POST /api/auth/trocar-senha`).
- Banco local: SQLite em `data/pedidos.db` (criado e semeado na primeira subida).
- Sem Evolution/Telegram configurados, as notificações ficam com status **"simulada"**
  (visíveis no detalhe do pedido) — nada trava.
- Os dados do seed são **de EXEMPLO** (tamanhos, acompanhamentos, adicionais, bairros e taxas):
  edite tudo pelo painel (Cardápio, Grupos e Opções, Bairros) com o cardápio real da loja.

## Estrutura

- `server.js` — app Express (rotas sem SQL; exporta o app e só escuta quando executado direto)
- `src/db.js` — **DAL**: única porta de acesso a dados (`get/all/run/execSql/init/tx`) — SQLite local ou Postgres (Supabase) via `DATABASE_URL`, com tradução de dialeto interna
- `src/pedidos.js` — cardápio, cálculo de preço no servidor, criação de pedido, máquina de estados
- `src/pagamentos.js` — Meios de Recebimento, adaptadores Mercado Pago/Asaas, webhooks
- `src/notificacoes.js` — outbox (Evolution/Telegram/simulada), poller e handler do Telegram
- `src/storage.js` — uploads com driver trocável (`STORAGE_DRIVER=local|supabase`)
- `src/comanda.js` — comanda 80mm + envio TCP 9100 para impressora de rede
- `api/index.js` — entrada serverless da Vercel · `vercel.json` — rewrites
- `supabase/schema.sql` — DDL Postgres equivalente (para colar no SQL Editor do Supabase)
- `public/` — loja e painel (HTML/CSS/JS puros, de outros agentes) · `uploads/` — fotos e logo

## Meios de Recebimento (painel → seção expansível)

Presenciais (Pix com chave, Cartão na maquininha, Dinheiro com troco) e online por API
(**Mercado Pago** e **Asaas**: interruptor, ambiente sandbox/produção, credenciais mascaradas na
leitura, botão "Testar conexão"). O checkout só mostra meios **ativos e configurados**.
Pedido online nasce com o pagamento `pendente` (selo "⏳ aguardando pagamento" no painel);
o **webhook** do provedor confirma e avisa dono e cliente. Falha do gateway **nunca** bloqueia
a venda: o pedido nasce com `erro_config` para cobrança manual.

URLs de webhook (troque pelo seu domínio público/túnel):
`POST /api/webhooks/mercadopago` · `POST /api/webhooks/asaas` · `POST /api/webhooks/telegram`

## Rodando com Supabase (produção)

O mesmo código roda nos dois bancos: **sem** `DATABASE_URL` ele usa o SQLite
local (`data/pedidos.db`); **com** `DATABASE_URL` ele usa o Postgres — a troca
é só essa variável, nenhum código muda.

1. Crie um projeto no **Supabase** (plano free).
2. No **SQL Editor**, cole e rode todo o `supabase/schema.sql`.
3. Pegue a connection string em **Database → Connection string → pooler**
   (porta **6543**) — ela entra na variável `DATABASE_URL`.
4. Suba este repositório no **GitHub** e importe o projeto na **Vercel**.
5. Configure `DATABASE_URL` na Vercel (Project → Settings → Environment
   Variables) e faça o deploy.
6. **O app semeia sozinho no primeiro boot**: se o banco estiver vazio, ele
   cria a loja de exemplo e o usuário inicial — login **admin / admin123**
   (troque a senha ao entrar). Boots seguintes não duplicam nada.
7. Em **Storage**, crie um bucket **público** chamado `uploads` (para as fotos
   em produção) e configure também `STORAGE_DRIVER=supabase`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET=uploads`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID`, `EVOLUTION_*` se for usar WhatsApp por lá.
6. **Telegram em produção:** o poller local não roda em serverless — aponte o webhook do bot:
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://SEU-PROJETO.vercel.app/api/webhooks/telegram`
   (o endpoint reutiliza exatamente o mesmo handler do poller, com botões e fallbacks de texto).
7. **Webhooks de pagamento:** no painel do Mercado Pago e do Asaas, cadastre as URLs
   `https://SEU-PROJETO.vercel.app/api/webhooks/mercadopago` e `.../api/webhooks/asaas`.
8. Domínio próprio é opcional e pode vir depois (Vercel → Domains) — os webhooks e o link da
   bio do Instagram passam a apontar para ele.

> ⚠️ **Aviso do plano free do Supabase:** projetos free **pausam após ~7 dias sem uso**.
> Uma loja em operação diária gera acesso todo dia e **não é afetada**; se a loja ficar
> fechada por mais de uma semana, basta entrar no painel do Supabase e despausar.

## Pendências registradas (TODO)

- Credenciais de pagamento ficam em `config_recebimentos.credenciais_json` sem criptografia
  em repouso nesta v1 (banco local/privado). Antes de uso amplo em produção, criptografar.
- Uploads em produção ainda dependem de disco/Supabase Storage conforme
  `STORAGE_DRIVER` (ver `src/storage.js`); o banco dual (SQLite/Postgres) já
  está pronto no DAL (`src/db.js`, via `DATABASE_URL`).
- Mercado Pago (Pix) exige `payer.email`: usa o e-mail da loja (`lojas.email_pedidos`) ou
  `pedidos@acaidoguri.local` — limitação registrada no contrato.

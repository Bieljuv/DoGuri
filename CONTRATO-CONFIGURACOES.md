# CONTRATO — Menu Configurações: WhatsApp + Telegram pelo painel (v1.3)

Pedido do Gabriel (21/10/2026): falta um menu **Configurações** onde o dono configura
**WhatsApp (Evolution API)** e **Telegram** pela tela, "com as informações explicando certinho".
Hoje tudo vem de variáveis de ambiente (.env) — a configuração passa a viver no BANCO,
com o .env como reserva (fallback por campo). Segredos SEMPRE mascarados na leitura.

## Backend

### Tabela nova `config_notificacoes` (linha única, id=1)
`id, loja_id, whatsapp_ativo INTEGER (default 1), evolution_url TEXT, evolution_apikey TEXT,
evolution_instancia TEXT, telegram_ativo INTEGER (default 1), telegram_bot_token TEXT,
telegram_chat_id TEXT, telegram_ultimo_chat TEXT (JSON do último chat visto, p/ detecção),
updated_at` — CREATE TABLE IF NOT EXISTS na carga de src/notificacoes.js (mesmo padrão do
financeiro) + equivalente comentado no supabase/schema.sql.

### src/notificacoes.js — refatorar a fonte da config
- `getCfg()` com cache em memória: lê a linha do banco; cada campo vazio cai pro .env
  correspondente (EVOLUTION_API_URL/EVOLUTION_API_KEY/EVOLUTION_INSTANCE/TELEGRAM_BOT_TOKEN/
  TELEGRAM_CHAT_ID). Exportar `invalidarCfg()` (PUT chama).
- `evolutionConfigurado()` = whatsapp_ativo≠0 && url && apikey && instancia (da cfg efetiva).
  `telegramConfigurado()` = idem (telegram_ativo≠0 && token && chat_id).
- TODOS os usos internos (envio Evolution, envio Telegram, enfileirar destino do dono,
  chatAutorizado, webhook, poller) passam a usar getCfg() — nada mais lê process.env direto
  fora do getCfg.
- Poller do Telegram: lê a cfg a cada ciclo; se o token mudar ou deixar de estar configurado,
  o loop encerra sozinho; `iniciar()`/PUT religam quando configurado. Sem duplicar loops.
- Detecção de chat: quando um update do Telegram trouxer mensagem de qualquer chat,
  gravar em telegram_ultimo_chat `{id, nome, username, tipo, em}` (sem bloquear o fluxo).

### Endpoints (autenticados, /api/painel/configuracoes)
- `GET /` → `{ whatsapp: { ativo, evolution_url, evolution_instancia, apikey_configurada,
  apikey_mascarada, configurado }, telegram: { ativo, chat_id, token_configurado,
  token_mascarado, configurado } }` — mascarada = '••••' + últimos 4 (ou só '••••').
- `PUT /` → aceita `{ whatsapp_ativo, evolution_url, evolution_instancia, evolution_apikey,
  telegram_ativo, telegram_chat_id, telegram_bot_token }`. Segredo vazio/ausente = MANTÉM o
  salvo. URL inválida (sem http/https) → 422 pt-BR. Salva, invalida cache, religa poller,
  responde o mesmo formato do GET.
- `POST /testar-whatsapp` → usa a cfg SALVA: GET `{url}/instance/connectionState/{instancia}`
  (header apikey, timeout 8s). Responde `{ ok, mensagem }` pt-BR: estado 'open' → conectado ✅;
  outro estado → "a instância existe, mas o WhatsApp não está conectado nela — abra o painel
  da Evolution e leia o QR Code"; 401/403 → chave rejeitada; erro de rede → endereço
  inalcançável; sem config → 422 pedindo salvar os dados primeiro.
- `POST /testar-telegram` → getMe (valida token; devolve @usuario do bot) e, havendo chat_id,
  sendMessage de teste: "✅ Teste de configuração — Açaí do Guri. Se você recebeu isto, os
  avisos de pedido vão chegar aqui." Responde `{ ok, mensagem, bot_username? }` com o passo
  que falhou, se falhar.
- `POST /telegram/detectar-chat` → se houver telegram_ultimo_chat gravado, devolve
  `{ chat_id, nome, username, origem: 'ultima conversa' }`. Senão tenta getUpdates (timeout 0)
  e extrai os chats distintos das mensagens recentes `{ chats: [...] }`. 409/conflito do
  Telegram ou nada encontrado → `{ ok:false, mensagem }` orientando: "abra o bot, mande um
  'oi', aguarde uns segundos e tente de novo". Nunca 500 por isso.

## Painel (public/painel.html/.css/.js)
- Menu: **⚙️ Configurações** após Financeiro. View própria.
- Texto de abertura curto: "É aqui que você liga os avisos automáticos: o cliente recebe as
  confirmações no WhatsApp e você (dono) recebe os pedidos no Telegram. Sem configurar, o
  sistema fica em 'modo simulado': registra tudo, mas não envia de verdade."
- **Card 💬 WhatsApp dos clientes (Evolution API)**: pill de status (de GET /configuracoes:
  configurado), interruptor Ativo, campos Endereço da Evolution API (placeholder
  https://seu-servidor:8080), Nome da instância (placeholder acai-guri), Chave de API (senha,
  com botão mostrar e dica "salva — deixe em branco para manter"), botões **Salvar** e
  **Salvar e testar conexão** (PUT depois POST testar-whatsapp; mostra a mensagem retornada).
  Bloco "📖 Como configurar" (sempre visível, passos numerados):
  1) Você precisa de um servidor Evolution API rodando (instalamos num VPS ou você contrata
  um provedor que ofereça Evolution pronta).
  2) No painel da Evolution, crie uma instância (sugestão de nome: acai-guri) e conecte o
  WhatsApp da loja lendo o QR Code com o celular — igual ao WhatsApp Web.
  3) Copie pra cá o endereço do servidor, a chave de API (apikey) e o nome da instância.
  4) Salve e teste. Pronto: confirmação, "saiu pra entrega" e "entregue" chegam sozinhos pro
  cliente. A loja usa o número conectado na instância.
- **Card 🤖 Telegram do dono**: pill de status, interruptor Ativo, Token do bot (senha,
  mesma regra de manter), Chat ID + botão **Detectar meu chat** (POST detectar-chat →
  preenche o campo e mostra de quem é), botões Salvar / Salvar e testar (POST testar-telegram;
  a mensagem chega no Telegram dele).
  Bloco "📖 Como configurar":
  1) No Telegram, converse com o @BotFather, envie /newbot, escolha nome e usuário do bot —
  ele devolve um token (uma sequência longa). Cole o token aqui.
  2) Abra o SEU bot (link que o BotFather mostra), toque em Começar e mande um "oi".
  3) Volte aqui e clique em Detectar meu chat — o sistema descobre o número da conversa
  sozinho. (Se preferir, o @userinfobot também mostra seu ID.)
  4) Salve e teste: pedido novo passa a chegar aqui no Telegram com botões de Confirmar e
  Cancelar — mesmo você estando na rua fazendo entrega.
- Após salvar/testar: chamar carregarSaude() pra atualizar as pills do topo.
- Seguir os padrões visuais existentes (card-form, pill on/sim, toasts, grid-2). Nada de mexer
  nas outras views.

## Fora de escopo
Configurar provedor Evolution de dentro do painel (instalar servidor/criar instância pela UI),
webhook público automático do Telegram (o poller local segue valendo; em nuvem o webhook já
existe), múltiplos destinatários no Telegram.

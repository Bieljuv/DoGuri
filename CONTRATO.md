# CONTRATO — Sistema de Pedidos Açaí do Guri (v1 local)

Projeto em `~/workspace/pedidos-acai-guri/`. Node 24 (usa `node:sqlite` embutido), Express + multer.
Sem build de front: HTML/CSS/JS puros servidos de `public/`. Porta 3333.
Dinheiro SEMPRE em centavos (inteiro). Banco SQLite em `data/pedidos.db` (criar na subida, com seed).

## Arquivos e donos
- Backend: `package.json`, `server.js` (pode dividir em `src/`), `.env.example`, `data/`, `uploads/` (seed-logo.png já está lá)
- Loja: `public/index.html`, `public/loja.css`, `public/loja.js`
- Painel: `public/painel.html`, `public/painel.css`, `public/painel.js`
- Servir: `/` → index.html · `/painel` → painel.html · estáticos de `public/` · `/uploads/<arquivo>`

## Identidade (de identidade-visual.md, projeto irmão em your_files)
- Tokens: primary `#7E047D`, primary-hover `#66036A`, accent `#DB04E2`, violet `#902A88`,
  deep `#460545`, night `#1F0421`, bg `#FBF7FD`, ink `#2A0530`.
- Cabeçalho da loja com transição de cor na rolagem: transparente/roxo-noite no topo →
  interpola `#1F0421 → #460545 → #7E047D` em ~240px → fixo sólido em `#7E047D` com linha de
  acento gradiente magenta→violeta. (Gabriel achou a prévia suave: pode intensificar o fim —
  sombra/glow magenta sutil ao fixar — sem usar magenta como fundo de texto comum.)

## API

### Públicas
- `GET /api/public/loja` → `{id,nome,logo_url,capa_url,whatsapp,instagram,endereco_texto,tempo_preparo_min,tempo_entrega_min,pedido_minimo_centavos,taxa_unica_centavos,chave_pix,aberta (calculado: aberta_manual && !pausada && dentro do horário simples),pausada,mensagem_status}`
- `GET /api/public/cardapio` → `{categorias:[{id,nome,ordem}], produtos:[{id,categoria_id,nome,descricao,foto_url,preco_base_centavos,tipo:simples|montavel,destaque,esgotado,ordem,grupos:[{id,nome,tipo_escolha:unica|multipla,minimo,maximo,obrigatorio,excedente_vira_pago,preco_excedente_centavos,ordem,opcoes:[{id,nome,preco_adicional_centavos,esgotada,ordem}]}]}]}` (só ativos; esgotados marcados)
- `GET /api/public/bairros` → `[{id,bairro,taxa_centavos,ativo}]`
- `POST /api/public/pedidos` corpo `{cliente_nome,cliente_whatsapp,tipo:entrega|retirada,bairro_id,endereco:{rua,numero,complemento,referencia},forma_pagamento:pix|dinheiro|cartao,troco_para_centavos,observacao,itens:[{produto_id,quantidade,observacao,opcoes:[opcao_id,...]}]}`
  → valida loja aberta, itens/opções ativos, limites de grupo; **calcula tudo no servidor**;
  cria pedido + itens + opções snapshot + histórico + notificações; responde `201 {numero,token,total_centavos,status}`.
  Erros de validação: `422 {erro:"mensagem pt-BR"}`.
- `GET /api/public/pedidos/:token` → detalhe completo do pedido + histórico de status.

### Cálculo do item (servidor, regra única)
`unit = preco_base + Σ preco_adicional das opções + excedente`
- Grupo múltipla: se `excedente_vira_pago=false`, seleções ≤ maximo (se maximo != null).
  Se `true`, seleções além do maximo custam `preco_excedente_centavos` cada (somado ao adicional da opção, normalmente 0).
- Grupo única: no máximo 1 (mínimo 1 se obrigatório). Obrigatório: seleções ≥ max(minimo,1).
- Total pedido = Σ(unit × qtd) + taxa (bairro ou taxa_unica; retirada = 0) − desconto(0 na v1; coluna existe).

### Estados (máquina — só estes caminhos)
NOVO → EM_PREPARO | CANCELADO · EM_PREPARO → PRONTO | CANCELADO · PRONTO → SAIU_ENTREGA (só entrega) | ENTREGUE · SAIU_ENTREGA → ENTREGUE.
Toda transição grava histórico e gera notificações ao cliente.

### Painel (Authorization: Bearer <token de login>)
- `POST /api/auth/login {login,senha}` → `{token,nome,perfil}` · seed: **admin / admin123** (hash no banco)
- `POST /api/auth/trocar-senha {senha_atual,nova_senha}` (autenticado)
- `GET /api/painel/pedidos` (lista do dia, com itens resumidos) · `GET /api/painel/pedidos/:id` (completo + notificações + histórico)
- `POST /api/painel/pedidos/:id/transicao {para_status,motivo}` · `POST /api/painel/pedidos/:id/imprimir` → `{comanda}` texto 80mm (registra em impressoes; se IMPRESSORA_IP no .env, tenta enviar ESC/POS bruto via TCP 9100, sem bloquear em erro)
- CRUD genérico (GET lista, POST cria, PUT /:id edita, DELETE /:id = inativar lógico):
  `/api/painel/categorias`, `/api/painel/produtos`, `/api/painel/grupos`, `/api/painel/opcoes`, `/api/painel/bairros`
  - produto: `{categoria_id,nome,descricao,foto_url,preco_base_centavos,tipo,destaque,ativo,esgotado,ordem,grupo_ids:[...]}` (grupo_ids substitui vínculos)
  - grupo: `{nome,tipo_escolha,minimo,maximo,obrigatorio,excedente_vira_pago,preco_excedente_centavos,ativo,ordem}` · opção: `{grupo_id,nome,preco_adicional_centavos,ativa,esgotada,ordem}`
- `POST /api/painel/upload` (multipart, campo `arquivo`, imagens até 5MB) → `{url:"/uploads/..."}` — usado p/ foto de produto, logo e capa
- `GET /api/painel/loja` · `PATCH /api/painel/loja` (nome, logo_url, capa_url, whatsapp, instagram, endereco_texto, tempos, pedido_minimo_centavos, taxa_unica_centavos, chave_pix, aberta_manual, horario_abre, horario_fecha)
- `POST /api/painel/loja/pausar {minutos}` · `POST /api/painel/loja/reabrir`
- `GET /api/painel/relatorio` → `{pedidos_concluidos,cancelados,faturamento_centavos,ticket_medio_centavos,top_produtos:[{nome,qtd}],top_opcoes:[{nome,qtd}],por_pagamento:{pix,dinheiro,cartao}}` (dia atual)
- `GET /api/painel/saude` → `{whatsapp:{configurado},telegram:{configurado},banco:"ok"}`
- `GET /api/painel/stream` (SSE autenticado por query `?token=`) — eventos `pedido` e `loja` p/ atualização em tempo real

### Notificações (outbox)
Tabela `notificacoes` processada por worker interno:
- Se `.env` tiver `EVOLUTION_API_URL/EVOLUTION_API_KEY/EVOLUTION_INSTANCE` → envia texto ao cliente/empresa via `POST {url}/message/sendText/{instance}`.
- Se tiver `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` → aviso de pedido novo ao dono com **botões inline (Confirmar/Cancelar) E fallback por texto** (lição do Hermes: inline pode não entregar callback — aceitar também as respostas de texto "✅ Confirmar #N" / "❌ Cancelar #N" e comandos `/confirmar N`). Poller `getUpdates` tratando `callback_query` e `message` do chat autorizado. Confirmar pelo Telegram = mesma transição do painel (histórico registra "via Telegram").
- Sem configuração → status `simulada` (fica visível no detalhe do pedido no painel). NUNCA travar o pedido por falha de notificação.

### Seed (dados de EXEMPLO, editáveis — deixar claro no README e numa flag `exemplo` só no README, não na UI do cliente)
Loja: Açaí do Guri, logo `/uploads/seed-logo.png`, whatsapp 5547999842490, instagram @acaidoguri.bc, aberta_manual=true, horário 13:00–23:00.
Categorias: "Monte seu Açaí", "Prontos e Combos", "Bebidas".
Produto montável "Monte seu Açaí" (base 0) com grupos:
- "Tamanho" única obrigatória: 300ml 1800 · 500ml 2500 · 700ml 3200 (preço na opção)
- "Acompanhamentos inclusos (até 3)" múltipla max 3, preço 0: Leite Ninho, Leite em Pó, Banana, Morango, Granola, Paçoca, Sucrilhos, Amendoim
- "Adicionais" múltipla sem limite: Nutella 600, Creme de Ninho 500, Morango Extra 500, Bis 300, Ovomaltine 400, Leite Condensado Extra 300
- "Calda" única não obrigatória preço 0: Chocolate, Morango, Leite Condensado, Sem Calda
Produto montável "Açaí Trufado (exemplo)" base 2800 com grupos Tamanho + Adicionais.
Produto simples "Água de Coco 500ml (exemplo)" 800 · "Refrigerante Lata (exemplo)" 600.
Bairros: Centro 500 · Barra Sul 700 · Municípios 800.

## Meios de Recebimento (decisão do Gabriel, 20/10/2026 — vale sobre a spec original)

Formas aceitas: **Pix, Cartão, Dinheiro** (presenciais, na entrega/retirada) **+ pagamento ONLINE
via Mercado Pago e Asaas, ambos por API**. O checkout só mostra o que estiver **ligado e
configurado** no painel.

### Menu do painel — seção EXPANSÍVEL "Meios de Recebimento"
Item de menu que expande/recolhe (accordion) com subitens:
- **Presencial** — interruptores: Pix na entrega (mostra campo chave Pix), Cartão na entrega (maquininha), Dinheiro (com opção "aceita troco").
- **Mercado Pago (online)** — interruptor; ambiente (sandbox|produção); `access_token`, `public_key`, `webhook_secret`; botão "Testar conexão" (chama `GET /api/painel/recebimentos/mercadopago/testar`).
- **Asaas (online)** — interruptor; ambiente (sandbox|produção); `api_key`; botão "Testar conexão" (idem `/asaas/testar`).
Credenciais: salvas no banco (tabela `config_recebimentos`, 1 linha por meio), **nunca** devolvidas
integrais pela API (GET devolve mascarado, ex.: `••••••••a1b2`); PATCH com campo vazio/mascarado = mantém o atual.

### Modelo
- `config_recebimentos`: `{meio: pix_presencial|cartao_presencial|dinheiro|mercadopago|asaas, ativo, ambiente, credenciais_json (criptografia fica p/ depois; registrar TODO no código), extra_json (chave_pix etc.)}`
- `pagamentos`: `{id, pedido_id, meio, provedor: interno|mercadopago|asaas, valor_centavos, status: nao_aplicavel|pendente|pago|falhou|estornado|erro_config, externo_id, qr_texto (copia e cola), link_pagamento, criado_em, atualizado_em, ultimo_evento}`
- Pedido ganha `pagamento_status` espelhando `pagamentos.status` (presencial = `nao_aplicavel` até a entrega, quando o painel pode marcar "recebido" — opcional na v1).

### Checkout (loja)
- `GET /api/public/loja` inclui `metodos_pagamento:[{codigo,rotulo,online:bool}]` só com os meios ativos:
  `pix` (presencial), `cartao` (na entrega), `dinheiro`, `pix_mp`, `cartao_mp`, `pix_asaas`, `cartao_asaas`
  (cartão online = link de pagamento do provedor; Pix online = QR/copia-e-cola do provedor escolhido).
- `POST /api/public/pedidos` com método online → cria o pedido + registro em `pagamentos` e chama o adaptador:
  - **Mercado Pago:** `POST https://api.mercadopago.com/v1/payments` (Pix, `payment_method_id:"pix"`, `payer.email` = e-mail configurado na loja ou `pedidos@acaidoguri.local` se vazio — registrar essa limitação) para Pix; para cartão, `POST /checkout/preferences` e devolver `init_point` como `link_pagamento`.
  - **Asaas:** base `https://api.asaas.com/v3` (prod) ou `https://sandbox.asaas.com/api/v3`; garantir cliente (`POST /customers` com nome + celular) e criar cobrança `POST /payments` (`billingType: PIX` ou `CREDIT_CARD` com link — usar `billingType:"UNDEFINED"` + `POST /payments/{id}/payByLink`? Simplificação v1: Pix via `/payments` + buscar QR em `GET /payments/{id}/pixQrCode`; cartão via link de pagamento do retorno da cobrança UNDEFINED).
  - Resposta do POST de pedido inclui `pagamento:{status,qr_texto,link_pagamento}` quando online.
  - **Falha/não-configurado:** pedido é criado mesmo assim com `pagamento.status=erro_config` e a loja é avisada para cobrar manualmente — nunca bloquear a venda por erro do gateway.
- Pedido com pagamento online `pendente`: aparece no painel com selo **"⏳ aguardando pagamento"**; a loja pode preparar, mas o fluxo recomendado (e o aviso ao dono) deixa claro que ainda não pagou. Quando o webhook confirma → `pagamento_status=pago`, selo some, sai **nova notificação ao dono** ("💰 Pagamento do pedido #N confirmado") e o cliente recebe "Pagamento confirmado ✅" (além das mensagens de status normais).

### Webhooks (públicos, validação básica + log de eventos)
- `POST /api/webhooks/mercadopago` — recebe notificação, busca o pagamento na API do MP com o access token, atualiza `pagamentos` pelo `external_reference`/id (mapear status MP: approved→pago, rejected/cancelled→falhou, refunded→estornado).
- `POST /api/webhooks/asaas` — eventos `PAYMENT_RECEIVED`/`PAYMENT_CONFIRMED`→pago, `PAYMENT_OVERDUE`/`PAYMENT_DELETED`→falhou, `PAYMENT_REFUNDED`→estornado; validar header `asaas-access-token` contra um token de webhook configurado (campo extra no config do Asaas).
- Ambos: responder 200 sempre que processar (mesmo com erro interno, após registrar), ser idempotentes (mesmo evento 2x não duplica efeito) e gravar o payload resumido em `pagamentos.ultimo_evento`.
- URL pública dos webhooks = URL do túnel + caminho (mostrar no painel, na tela de cada provedor, com botão copiar — é o endereço que ele cola no painel do MP/Asaas).

### Painel — pedidos
Selo de pagamento no card/detalhe: `💰 online pago` · `⏳ aguardando pagamento` · `❌ pagamento falhou` · presencial sem selo (forma exibida como antes). Filtro rápido "aguardando pagamento" é opcional.

## Hospedagem e banco — ATUALIZAÇÃO (Gabriel, 20/10/2026 ~23:28)

- **Produção alvo: Supabase (plano free) como banco Postgres + Vercel (free) hospedando o sistema + GitHub com o código.** Domínio próprio: só depois, se ele quiser (começa no `*.vercel.app`).
- SQLite local segue como ambiente de desenvolvimento/teste imediato; a migração para o Supabase é por `supabase/schema.sql` (DDL Postgres gerado junto) + troca de env — sem reescrever rotas (acesso a dados isolado em um módulo).
- Uploads em produção vão para o **Supabase Storage** (Vercel não tem disco permanente): driver trocável por env `STORAGE_DRIVER=local|supabase`, mesmo contrato `{url}`.
- Telegram em nuvem usa **webhook** (`POST /api/webhooks/telegram`) em vez do poller (poller continua no modo local).
- Aviso registrado: Supabase free **pausa** o projeto após ~7 dias sem uso (reversível com 1 clique, sem perda); loja em operação diária não atinge isso.
- Impressão térmica continua local (janela de impressão do painel / helper local futuro) — independe de onde o sistema está hospedado.

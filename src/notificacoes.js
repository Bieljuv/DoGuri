'use strict';
// Outbox de notificações + worker (Evolution / Telegram / simulada).
// Falha de notificação NUNCA bloqueia pedido: tudo aqui é assíncrono e tolerante a erro.
//
// Configuração (v1.3): vive no BANCO (tabela config_notificacoes, linha única id=1),
// editável pelo painel em Configurações. Cada campo vazio no banco cai pro .env
// correspondente (fallback por campo). NADA fora de getCfg() lê process.env aqui.
const { get, all, run, execSql, modoBanco } = require('./db');
const { fmtBRL } = require('./util');

if (modoBanco() === 'sqlite') execSql(`
CREATE TABLE IF NOT EXISTS config_notificacoes (
  id INTEGER PRIMARY KEY,
  loja_id INTEGER NOT NULL DEFAULT 1,
  whatsapp_ativo INTEGER NOT NULL DEFAULT 1,
  evolution_url TEXT,
  evolution_apikey TEXT,
  evolution_instancia TEXT,
  telegram_ativo INTEGER NOT NULL DEFAULT 1,
  telegram_bot_token TEXT,
  telegram_chat_id TEXT,
  telegram_ultimo_chat TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
`);
if (modoBanco() === 'sqlite') run('INSERT OR IGNORE INTO config_notificacoes (id, loja_id) VALUES (1, 1)');

// ---------- Fonte única da configuração efetiva (banco → fallback .env) ----------
// A linha do banco é carregada UMA vez por preparar() (e recarregada a cada
// salvarCfg) e fica em memória: getCfg() segue SÍNCRONO lendo esse cache.
let cfgCache = null;
let cfgLinhaCache = {};
async function linhaCfg() {
  try { return (await get('SELECT * FROM config_notificacoes WHERE id=1')) || {}; } catch { return {}; }
}
async function preparar() {
  // Garante a linha única (id=1) e carrega o cache — chamado pelo server.js
  // no boot (promise `pronto`), antes de qualquer rota responder.
  await run('INSERT OR IGNORE INTO config_notificacoes (id, loja_id) VALUES (1, 1)');
  cfgLinhaCache = await linhaCfg();
  cfgCache = null;
}
function getCfg() {
  if (cfgCache) return cfgCache;
  const db = cfgLinhaCache || {};
  const pick = (valorBanco, valorEnv) => {
    const v = valorBanco != null ? String(valorBanco).trim() : '';
    return v || (valorEnv || '');
  };
  cfgCache = {
    whatsappAtivo: db.whatsapp_ativo == null ? 1 : Number(db.whatsapp_ativo),
    evolutionUrl: pick(db.evolution_url, process.env.EVOLUTION_API_URL),
    evolutionApikey: pick(db.evolution_apikey, process.env.EVOLUTION_API_KEY),
    evolutionInstancia: pick(db.evolution_instancia, process.env.EVOLUTION_INSTANCE),
    telegramAtivo: db.telegram_ativo == null ? 1 : Number(db.telegram_ativo),
    telegramBotToken: pick(db.telegram_bot_token, process.env.TELEGRAM_BOT_TOKEN),
    telegramChatId: pick(db.telegram_chat_id, process.env.TELEGRAM_CHAT_ID),
    telegramUltimoChat: db.telegram_ultimo_chat || null,
  };
  return cfgCache;
}
function invalidarCfg() { cfgCache = null; }

const evolutionConfigurado = () => {
  const c = getCfg();
  return c.whatsappAtivo !== 0 && !!c.evolutionUrl && !!c.evolutionApikey && !!c.evolutionInstancia;
};
const telegramConfigurado = () => {
  const c = getCfg();
  return c.telegramAtivo !== 0 && !!c.telegramBotToken && !!c.telegramChatId;
};

// ---------- Visão pública da config (segredos SEMPRE mascarados) ----------
function mascarar(segredo) {
  if (!segredo) return '';
  const s = String(segredo);
  return s.length <= 4 ? '••••' : '••••' + s.slice(-4);
}
function cfgPublica() {
  const c = getCfg();
  return {
    whatsapp: {
      ativo: c.whatsappAtivo !== 0,
      evolution_url: c.evolutionUrl,
      evolution_instancia: c.evolutionInstancia,
      apikey_configurada: !!c.evolutionApikey,
      apikey_mascarada: mascarar(c.evolutionApikey),
      configurado: evolutionConfigurado(),
    },
    telegram: {
      ativo: c.telegramAtivo !== 0,
      chat_id: c.telegramChatId,
      token_configurado: !!c.telegramBotToken,
      token_mascarado: mascarar(c.telegramBotToken),
      configurado: telegramConfigurado(),
    },
  };
}

// ---------- Salvar (PUT /api/painel/configuracoes) ----------
// Segredo vazio/ausente = MANTÉM o salvo. URL sem http/https → erro 422.
async function salvarCfg(dados = {}) {
  const atual = await linhaCfg();
  const prox = {
    whatsapp_ativo: atual.whatsapp_ativo == null ? 1 : Number(atual.whatsapp_ativo),
    evolution_url: atual.evolution_url || null,
    evolution_instancia: atual.evolution_instancia || null,
    evolution_apikey: atual.evolution_apikey || null,
    telegram_ativo: atual.telegram_ativo == null ? 1 : Number(atual.telegram_ativo),
    telegram_chat_id: atual.telegram_chat_id || null,
    telegram_bot_token: atual.telegram_bot_token || null,
  };
  const comoBool = (v) => (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
  if (dados.whatsapp_ativo !== undefined) prox.whatsapp_ativo = comoBool(dados.whatsapp_ativo);
  if (dados.telegram_ativo !== undefined) prox.telegram_ativo = comoBool(dados.telegram_ativo);
  if (dados.evolution_url !== undefined) {
    const url = String(dados.evolution_url || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) {
      return { ok: false, status: 422, erro: 'O endereço da Evolution API precisa começar com http:// ou https:// (ex.: https://seu-servidor:8080).' };
    }
    prox.evolution_url = url || null;
  }
  if (dados.evolution_instancia !== undefined) prox.evolution_instancia = String(dados.evolution_instancia || '').trim() || null;
  if (dados.telegram_chat_id !== undefined) prox.telegram_chat_id = String(dados.telegram_chat_id || '').trim() || null;
  if (typeof dados.evolution_apikey === 'string' && dados.evolution_apikey.trim()) prox.evolution_apikey = dados.evolution_apikey.trim();
  if (typeof dados.telegram_bot_token === 'string' && dados.telegram_bot_token.trim()) prox.telegram_bot_token = dados.telegram_bot_token.trim();

  await run('INSERT OR IGNORE INTO config_notificacoes (id, loja_id) VALUES (1, 1)');
  await run(`UPDATE config_notificacoes SET whatsapp_ativo=?, evolution_url=?, evolution_instancia=?, evolution_apikey=?,
       telegram_ativo=?, telegram_chat_id=?, telegram_bot_token=?, updated_at=datetime('now') WHERE id=1`,
    prox.whatsapp_ativo, prox.evolution_url, prox.evolution_instancia, prox.evolution_apikey,
    prox.telegram_ativo, prox.telegram_chat_id, prox.telegram_bot_token);
  cfgLinhaCache = await linhaCfg();
  invalidarCfg();
  iniciarPollerTelegram(); // religa se ficou configurado (o loop lê a cfg nova a cada ciclo)
  return { ok: true, cfg: cfgPublica() };
}

// ---------- Testes de conexão (botões "Salvar e testar") ----------
async function testarWhatsapp() {
  const c = getCfg();
  if (!c.evolutionUrl || !c.evolutionApikey || !c.evolutionInstancia) {
    return { status: 422, erro: 'Salve primeiro os dados do WhatsApp: endereço da Evolution API, chave de API e nome da instância.' };
  }
  const base = c.evolutionUrl.replace(/\/+$/, '');
  let resp;
  try {
    resp = await fetch(`${base}/instance/connectionState/${encodeURIComponent(c.evolutionInstancia)}`, {
      headers: { apikey: c.evolutionApikey }, signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, mensagem: 'Não consegui alcançar a Evolution API neste endereço. Confira se o endereço está certo, completo (com http:// ou https://) e se o servidor está no ar.' };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, mensagem: 'A Evolution respondeu, mas rejeitou a chave de API. Confira a apikey salva (no painel da Evolution ela fica nas configurações da instância/API).' };
  }
  if (resp.status === 404) {
    return { ok: false, mensagem: `A Evolution respondeu, mas não encontrou a instância "${c.evolutionInstancia}". Confira o nome da instância — precisa ser igualzinho ao do painel da Evolution.` };
  }
  if (!resp.ok) {
    return { ok: false, mensagem: `A Evolution respondeu com um erro inesperado (HTTP ${resp.status}). Confira o endereço e tente de novo.` };
  }
  const json = await resp.json().catch(() => null);
  const estado = (json && json.instance && json.instance.state) || (json && json.state) || '';
  if (estado === 'open') {
    return { ok: true, mensagem: 'WhatsApp conectado ✅ — a instância está aberta e pronta pra enviar as mensagens pros clientes.' };
  }
  return { ok: false, mensagem: 'A instância existe, mas o WhatsApp não está conectado nela — abra o painel da Evolution e leia o QR Code com o celular da loja.' };
}

const MSG_TESTE_TELEGRAM = '✅ Teste de configuração — Açaí do Guri. Se você recebeu isto, os avisos de pedido vão chegar aqui.';
async function tgApi(token, metodo, corpo) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
    method: corpo ? 'POST' : 'GET',
    headers: corpo ? { 'Content-Type': 'application/json' } : undefined,
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const json = await resp.json().catch(() => null);
  return { resp, json };
}
async function testarTelegram() {
  const c = getCfg();
  if (!c.telegramBotToken) {
    return { status: 422, erro: 'Salve primeiro o token do bot do Telegram (ele vem do @BotFather).' };
  }
  let me;
  try {
    me = await tgApi(c.telegramBotToken, 'getMe');
  } catch {
    return { ok: false, mensagem: 'Não consegui falar com o Telegram agora (rede). Tente de novo em alguns segundos.' };
  }
  if (!me.resp.ok || !me.json || !me.json.ok) {
    if (me.resp.status === 401) return { ok: false, mensagem: 'O Telegram rejeitou o token do bot — ele parece inválido. Confira se copiou o token inteiro que o @BotFather te passou, sem espaços.' };
    return { ok: false, mensagem: `O Telegram não validou o token (HTTP ${me.resp.status}). Confira o token salvo e tente de novo.` };
  }
  const botUsername = me.json.result && me.json.result.username ? '@' + me.json.result.username : null;
  if (!c.telegramChatId) {
    return { ok: false, bot_username: botUsername, mensagem: `O token está certo — bot ${botUsername || ''} encontrado ✅. Mas falta o Chat ID: abra o bot no Telegram, mande um "oi" e clique em "Detectar meu chat" aqui nesta tela.` };
  }
  try {
    const envio = await tgApi(c.telegramBotToken, 'sendMessage', { chat_id: c.telegramChatId, text: MSG_TESTE_TELEGRAM });
    if (!envio.resp.ok || !envio.json || !envio.json.ok) {
      return { ok: false, bot_username: botUsername, mensagem: `O bot ${botUsername || ''} está certo, mas não consegui entregar a mensagem de teste no Chat ID salvo. Confira se você já abriu o bot e mandou um "oi" pra ele (o bot só fala com quem já conversou) e se o Chat ID está certo — use o botão "Detectar meu chat".` };
    }
  } catch {
    return { ok: false, bot_username: botUsername, mensagem: 'O token é válido, mas a mensagem de teste não saiu (rede). Tente de novo em alguns segundos.' };
  }
  return { ok: true, bot_username: botUsername, mensagem: `Tudo certo ✅ Bot ${botUsername || ''} conectado e a mensagem de teste foi enviada — confira seu Telegram.` };
}

// ---------- Detecção do chat do dono ----------
async function registrarUltimoChat(chat) {
  if (!chat || chat.id == null) return;
  const nome = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || '';
  const info = { id: chat.id, nome, username: chat.username || null, tipo: chat.type || null, em: new Date().toISOString() };
  try {
    await run('INSERT OR IGNORE INTO config_notificacoes (id, loja_id) VALUES (1, 1)');
    await run('UPDATE config_notificacoes SET telegram_ultimo_chat=? WHERE id=1', JSON.stringify(info));
    cfgLinhaCache = { ...cfgLinhaCache, telegram_ultimo_chat: JSON.stringify(info) };
    if (cfgCache) cfgCache.telegramUltimoChat = JSON.stringify(info);
  } catch { /* detecção nunca bloqueia o fluxo */ }
}
function chatDeUpdate(upd) {
  if (!upd) return null;
  if (upd.message && upd.message.chat) return upd.message.chat;
  if (upd.edited_message && upd.edited_message.chat) return upd.edited_message.chat;
  if (upd.callback_query && upd.callback_query.message && upd.callback_query.message.chat) return upd.callback_query.message.chat;
  return null;
}
function descreverChat(chat) {
  return {
    chat_id: String(chat.id),
    nome: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || '',
    username: chat.username || null,
    tipo: chat.type || null,
  };
}
const MSG_DETECTAR_FALHA = 'Ainda não encontrei nenhuma conversa com o bot. Abra o bot no Telegram, toque em Começar (/start), mande um "oi", aguarde uns segundos e tente de novo.';
async function detectarChatTelegram() {
  const db = await linhaCfg();
  if (db.telegram_ultimo_chat) {
    try {
      const u = JSON.parse(db.telegram_ultimo_chat);
      if (u && u.id != null) {
        const chat = { chat_id: String(u.id), nome: u.nome || '', username: u.username || null, tipo: u.tipo || null, origem: 'ultima conversa' };
        return { ok: true, ...chat, chats: [chat] };
      }
    } catch { /* JSON quebrado: segue pro getUpdates */ }
  }
  const c = getCfg();
  if (!c.telegramBotToken) {
    return { ok: false, mensagem: 'Salve primeiro o token do bot nesta tela — sem ele eu não consigo procurar sua conversa.' };
  }
  let r;
  try {
    r = await tgApi(c.telegramBotToken, 'getUpdates?timeout=0');
  } catch {
    return { ok: false, mensagem: 'Não consegui falar com o Telegram agora (rede). Tente de novo em alguns segundos.' };
  }
  if (r.resp.status === 409 || (r.json && r.json.error_code === 409)) {
    return { ok: false, mensagem: MSG_DETECTAR_FALHA + ' (Detalhe: o Telegram está recebendo as conversas por outro caminho neste momento — mandar o "oi" e aguardar resolve na maioria das vezes.)' };
  }
  if (!r.resp.ok || !r.json || !r.json.ok) {
    if (r.resp.status === 401) return { ok: false, mensagem: 'O Telegram rejeitou o token do bot — ele parece inválido. Confira o token salvo e tente de novo.' };
    return { ok: false, mensagem: MSG_DETECTAR_FALHA };
  }
  const porId = new Map();
  for (const upd of r.json.result || []) {
    const chat = chatDeUpdate(upd);
    if (chat) { porId.set(String(chat.id), descreverChat(chat)); await registrarUltimoChat(chat); }
  }
  const chats = [...porId.values()];
  if (!chats.length) return { ok: false, mensagem: MSG_DETECTAR_FALHA };
  const recente = chats[chats.length - 1];
  return { ok: true, chat_id: recente.chat_id, nome: recente.nome, username: recente.username, origem: 'conversa recente', chats };
}

// ---------- Outbox ----------
let transicaoHandler = null; // injetado pelo server.js (evita dependência circular)
function setTransicaoHandler(fn) { transicaoHandler = fn; }

async function enfileirar({ canal, destino, corpo, pedidoId = null, telegramBotoes = null }) {
  const info = await run('INSERT INTO notificacoes (loja_id, pedido_id, canal, destino, corpo) VALUES (1, ?, ?, ?, ?)', pedidoId, canal, destino || '', corpo);
  if (telegramBotoes) telegramPendente.set(Number(info.lastInsertRowid), telegramBotoes);
  setImmediate(() => { processarFila().catch((e) => console.error('[notificacoes] fila:', e.message)); });
  return info.lastInsertRowid;
}
const telegramPendente = new Map(); // notifId -> {pedidoNumero} para montar botões

async function enviarEvolution(destino, texto) {
  const c = getCfg();
  const base = c.evolutionUrl.replace(/\/+$/, '');
  const resp = await fetch(`${base}/message/sendText/${encodeURIComponent(c.evolutionInstancia)}`, {
    method: 'POST', signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json', apikey: c.evolutionApikey },
    body: JSON.stringify({ number: destino, text: texto }),
  });
  if (!resp.ok) throw new Error('Evolution HTTP ' + resp.status);
  return await resp.json().catch(() => ({}));
}

/* Botões que acompanham o pedido: cada status oferece a PRÓXIMA ação,
   pro dono conduzir o pedido inteiro pelo Telegram (inclusive na rua). */
function tecladoDaEtapa(etapa, numero, tipo) {
  const b = (text, data) => ({ text, callback_data: `${data}:${numero}` });
  switch (etapa) {
    case 'NOVO': return [[b('✅ Confirmar', 'confirmar'), b('❌ Cancelar', 'cancelar')]];
    case 'EM_PREPARO': return [[b('✅ Marcar pronto', 'pronto')], [b('❌ Cancelar', 'cancelar')]];
    case 'PRONTO': return tipo === 'entrega'
      ? [[b('🛵 Saiu pra entrega', 'saiu')], [b('🏁 Entregue', 'entregue')]]
      : [[b('🏁 Entregue', 'entregue')]];
    case 'SAIU_ENTREGA': return [[b('🏁 Entregue', 'entregue')]];
    default: return null;
  }
}
async function enviarTelegram(texto, botoes) {
  const c = getCfg();
  const url = `https://api.telegram.org/bot${c.telegramBotToken}/sendMessage`;
  const body = { chat_id: c.telegramChatId, text: texto, parse_mode: 'Markdown' };
  if (botoes && botoes.pedidoNumero) {
    const kb = tecladoDaEtapa(botoes.etapa || 'NOVO', botoes.pedidoNumero, botoes.tipo);
    if (kb) body.reply_markup = { inline_keyboard: kb };
  }
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  if (!resp.ok) throw new Error('Telegram HTTP ' + resp.status);
  return await resp.json().catch(() => ({}));
}

let processando = false;
async function processarFila() {
  if (processando) return;
  processando = true;
  try {
    const pendentes = await all("SELECT * FROM notificacoes WHERE status='pendente' ORDER BY id ASC LIMIT 20");
    for (const n of pendentes) {
      try {
        if (n.canal === 'telegram_dono') {
          if (!telegramConfigurado()) throw Object.assign(new Error('Telegram não configurado'), { simulada: true });
          const botoes = telegramPendente.get(n.id);
          await enviarTelegram(n.corpo, botoes || null);
          telegramPendente.delete(n.id);
        } else { // whatsapp_cliente | whatsapp_empresa
          if (!evolutionConfigurado()) throw Object.assign(new Error('Evolution não configurado'), { simulada: true });
          await enviarEvolution(n.destino, n.corpo);
        }
        await run("UPDATE notificacoes SET status='enviada', enviada_em=datetime('now') WHERE id=?", n.id);
      } catch (e) {
        const status = e.simulada ? 'simulada' : 'falhou';
        await run('UPDATE notificacoes SET status=?, tentativas=tentativas+1, ultimo_erro=? WHERE id=?', status, String(e.message || e).slice(0, 300), n.id);
      }
    }
  } finally { processando = false; }
}

// ---------- Mensagens padrão ----------
function msgNovoPedidoDono(pedido, itens) {
  const linhas = itens.map(i => `• ${i.quantidade}x ${i.nome_snapshot}`).join('\n');
  return `🔔 *NOVO PEDIDO #${pedido.numero}* — Açaí do Guri\n${pedido.cliente_nome} • ${pedido.tipo === 'entrega' ? 'ENTREGA' : 'RETIRADA'}\n${linhas}\nTotal: *${fmtBRL(pedido.total_centavos)}* (${pedido.forma_pagamento})\n\nResponda *✅ Confirmar #${pedido.numero}* ou *❌ Cancelar #${pedido.numero}* (ou toque nos botões).`;
}
function msgClienteStatus(pedido, para) {
  const loja = 'Açaí do Guri';
  switch (para) {
    case 'NOVO': return `Olá, ${pedido.cliente_nome}! 👋 Recebemos seu pedido *#${pedido.numero}* no *${loja}*. Aguardando a confirmação da loja — te avisamos aqui mesmo.`;
    case 'EM_PREPARO': return `✅ Pedido *#${pedido.numero}* confirmado! Já estamos preparando seu açaí. 😋 — ${loja}`;
    case 'PRONTO': return pedido.tipo === 'retirada'
      ? `🎉 Seu pedido *#${pedido.numero}* está *pronto para retirada*! Pode vir buscar. — ${loja}`
      : `Seu pedido *#${pedido.numero}* está pronto e já vai sair para entrega. — ${loja}`;
    case 'SAIU_ENTREGA': return `🛵 Seu pedido *#${pedido.numero}* *saiu para entrega*! — ${loja}`;
    case 'ENTREGUE': return `Pedido *#${pedido.numero}* entregue. Bom açaí! 💜 — ${loja}`;
    case 'CANCELADO': return `😕 Seu pedido *#${pedido.numero}* foi cancelado.${pedido.motivo_cancelamento ? ' Motivo: ' + pedido.motivo_cancelamento + '.' : ''} Qualquer dúvida, chama a gente aqui. — ${loja}`;
    default: return null;
  }
}
async function notificarNovoPedido(pedido, itens) {
  // Cliente: "recebido"
  const mc = msgClienteStatus(pedido, 'NOVO');
  if (mc) await enfileirar({ canal: 'whatsapp_cliente', destino: pedido.cliente_whatsapp, corpo: mc, pedidoId: pedido.id });
  // Dono: Telegram (principal) + WhatsApp da empresa (se houver número diferente nas configs futuras)
  await enfileirar({ canal: 'telegram_dono', destino: getCfg().telegramChatId || '', corpo: msgNovoPedidoDono(pedido, itens), pedidoId: pedido.id, telegramBotoes: { pedidoNumero: pedido.numero, etapa: 'NOVO', tipo: pedido.tipo } });
}
/* Mensagem pro dono a cada mudança de status, já com o botão da próxima
   etapa (e a resposta por texto equivalente, caso o botão não entregue). */
function msgDonoStatus(pedido, para) {
  const n = pedido.numero;
  switch (para) {
    case 'EM_PREPARO': return `✅ *Pedido #${n}* confirmado — em preparo.\nQuando ficar pronto, toque no botão ou responda *✅ Pronto #${n}*.`;
    case 'PRONTO': return pedido.tipo === 'entrega'
      ? `✅ *Pedido #${n}* pronto!\nNa saída, toque no botão ou responda *🛵 Saiu #${n}*; ao entregar, *🏁 Entregue #${n}*.`
      : `✅ *Pedido #${n}* pronto pra retirada!\nQuando o cliente buscar, toque no botão ou responda *🏁 Entregue #${n}*.`;
    case 'SAIU_ENTREGA': return `🛵 *Pedido #${n}* saiu pra entrega.\nAo entregar, toque no botão ou responda *🏁 Entregue #${n}*.`;
    case 'ENTREGUE': return `🏁 *Pedido #${n}* entregue. 💰`;
    case 'CANCELADO': return `❌ *Pedido #${n}* cancelado.`;
    default: return null;
  }
}
async function notificarTransicao(pedido, para) {
  const mc = msgClienteStatus(pedido, para);
  if (mc) await enfileirar({ canal: 'whatsapp_cliente', destino: pedido.cliente_whatsapp, corpo: mc, pedidoId: pedido.id });
  const md = msgDonoStatus(pedido, para);
  if (md) await enfileirar({ canal: 'telegram_dono', destino: getCfg().telegramChatId || '', corpo: md, pedidoId: pedido.id, telegramBotoes: { pedidoNumero: pedido.numero, etapa: para, tipo: pedido.tipo } });
}
async function notificarDonoTexto(texto, pedidoId = null) {
  await enfileirar({ canal: 'telegram_dono', destino: getCfg().telegramChatId || '', corpo: texto, pedidoId });
}

// ---------- Poller do Telegram (callback_query + texto) ----------
// O loop lê a cfg a CADA ciclo: se o token mudar, ele encerra e religa com o
// token novo; se deixar de estar configurado, encerra sozinho. iniciar()/PUT
// chamam iniciarPollerTelegram(), que é idempotente (nunca duplica o loop).
let telegramOffset = 0;
let pollerRodando = false;
let tokenDoLoop = null;
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function cicloPoller() {
  tokenDoLoop = getCfg().telegramBotToken;
  while (pollerRodando) {
    const cfg = getCfg();
    if (!telegramConfigurado() || cfg.telegramBotToken !== tokenDoLoop) break;
    try {
      const url = `https://api.telegram.org/bot${tokenDoLoop}/getUpdates?timeout=25&offset=${telegramOffset}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(35000) });
      const json = await resp.json().catch(() => null);
      if (json && json.ok) {
        for (const upd of json.result || []) {
          telegramOffset = upd.update_id + 1;
          try { await tratarUpdateTelegram(upd); } catch (e) { console.error('[telegram] erro no update:', e.message); }
        }
      } else {
        await esperar(2000); // token rejeitado/conflito: não martelar a API
      }
    } catch { await esperar(1500); /* rede caiu: tenta de novo no próximo ciclo */ }
  }
  pollerRodando = false;
  tokenDoLoop = null;
  // Token trocado via painel enquanto o loop rodava: religa já com a cfg nova.
  if (telegramConfigurado()) iniciarPollerTelegram();
}
function iniciarPollerTelegram() {
  if (pollerRodando) return;
  if (!telegramConfigurado()) return;
  pollerRodando = true;
  cicloPoller().catch(() => { pollerRodando = false; tokenDoLoop = null; });
}
function chatAutorizado(chatId) { return String(chatId) === String(getCfg().telegramChatId); }
async function responderTelegram(chatId, texto) {
  try {
    await fetch(`https://api.telegram.org/bot${getCfg().telegramBotToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto }),
    });
  } catch { /* silencioso */ }
}
async function tratarUpdateTelegram(upd) {
  // Detecção: qualquer chat que falar com o bot fica gravado pra tela de
  // Configurações descobrir o Chat ID sozinha (não bloqueia o fluxo).
  const chatVisto = chatDeUpdate(upd);
  if (chatVisto) await registrarUltimoChat(chatVisto);

  let chatId = null, acao = null, numero = null, callbackId = null;
  if (upd.callback_query) {
    chatId = upd.callback_query.message && upd.callback_query.message.chat.id;
    callbackId = upd.callback_query.id;
    const m = String(upd.callback_query.data || '').match(/^(confirmar|pronto|saiu|entregue|cancelar):(\d+)$/);
    if (m) { acao = m[1]; numero = Number(m[2]); }
  } else if (upd.message && upd.message.text) {
    chatId = upd.message.chat.id;
    const t = upd.message.text.trim();
    const padroes = [
      ['confirmar', [/✅\s*Confirmar\s*#(\d+)/i, /^\/confirmar\s+(\d+)/i]],
      ['pronto', [/✅\s*Pronto\s*#(\d+)/i, /^\/pronto\s+(\d+)/i]],
      ['saiu', [/🛵\s*Saiu\s*#(\d+)/i, /^\/saiu\s+(\d+)/i]],
      ['entregue', [/🏁\s*Entregue\s*#(\d+)/i, /^\/entregue\s+(\d+)/i]],
      ['cancelar', [/❌\s*Cancelar\s*#(\d+)/i, /^\/cancelar\s+(\d+)/i]],
    ];
    for (const [nome, regs] of padroes) {
      const m = regs.map(r => t.match(r)).find(Boolean);
      if (m) { acao = nome; numero = Number(m[1]); break; }
    }
  }
  if (!chatId || !chatAutorizado(chatId)) return; // ignora qualquer outro chat silenciosamente
  if (callbackId) {
    fetch(`https://api.telegram.org/bot${getCfg().telegramBotToken}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackId }),
    }).catch(() => {});
  }
  if (!acao || !numero || !transicaoHandler) return;
  const pedido = await get('SELECT * FROM pedidos WHERE loja_id=1 AND numero=?', numero);
  if (!pedido) { await responderTelegram(chatId, `Pedido #${numero} não encontrado.`); return; }
  const MAPA = { confirmar: 'EM_PREPARO', pronto: 'PRONTO', saiu: 'SAIU_ENTREGA', entregue: 'ENTREGUE', cancelar: 'CANCELADO' };
  const ROTULO = { EM_PREPARO: 'em preparo', PRONTO: 'pronto', SAIU_ENTREGA: 'saiu pra entrega', ENTREGUE: 'entregue', CANCELADO: 'cancelado' };
  const para = MAPA[acao];
  if (!para) return;
  const r = await transicaoHandler(pedido.id, para, { origem: 'telegram', motivo: acao === 'cancelar' ? 'Cancelado pelo Telegram' : null });
  await responderTelegram(chatId, r.ok ? `Feito: pedido #${numero} → ${ROTULO[para]}.` : `Não consegui: ${r.erro}`);
}

function iniciar() {
  setInterval(() => { processarFila().catch((e) => console.error('[notificacoes] fila:', e.message)); }, 5000);
  iniciarPollerTelegram();
}

// O MESMO handler serve o poller local e o webhook (POST /api/webhooks/telegram,
// usado em produção na Vercel via setWebhook) — payload idêntico do Telegram.
module.exports = {
  enfileirar, processarFila, notificarNovoPedido, notificarTransicao, notificarDonoTexto,
  setTransicaoHandler, iniciar, evolutionConfigurado, telegramConfigurado, tratarUpdateTelegram,
  getCfg, invalidarCfg, cfgPublica, salvarCfg, testarWhatsapp, testarTelegram, detectarChatTelegram,
  iniciarPollerTelegram, preparar,
};

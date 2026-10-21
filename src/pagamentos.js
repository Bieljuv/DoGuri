'use strict';
// Meios de Recebimento + pagamentos online (Mercado Pago / Asaas).
// Regra de ouro do contrato: erro de gateway NUNCA bloqueia a venda — o pedido
// nasce com pagamento.status = 'erro_config' e a loja cobra manualmente.
const { get, all, run } = require('./db');
const { mascarar, ehMascarado } = require('./util');
const notif = require('./notificacoes');
const eventos = require('./eventos');

const MEIOS = ['pix_presencial', 'cartao_presencial', 'dinheiro', 'mercadopago', 'asaas'];
const CAMPOS_CREDENCIAIS = {
  mercadopago: ['access_token', 'public_key', 'webhook_secret'],
  asaas: ['api_key', 'webhook_token'],
};

async function getConfig(meio) {
  const row = await get('SELECT * FROM config_recebimentos WHERE loja_id=1 AND meio=?', meio);
  if (!row) return null;
  return { ...row, credenciais: JSON.parse(row.credenciais_json || '{}'), extra: JSON.parse(row.extra_json || '{}') };
}
async function listarConfigMascarado() {
  const saida = [];
  for (const meio of MEIOS) {
    const c = await getConfig(meio);
    if (!c) { saida.push({ meio, ativo: false, ambiente: 'sandbox', credenciais: {}, extra: {} }); continue; }
    const credenciais = {};
    for (const k of Object.keys(c.credenciais)) credenciais[k] = mascarar(c.credenciais[k]);
    saida.push({ meio, ativo: !!c.ativo, ambiente: c.ambiente, credenciais, extra: c.extra });
  }
  return saida;
}
async function atualizarConfig(meio, corpo) {
  const atual = await getConfig(meio);
  if (!atual) throw new Error('Meio de recebimento desconhecido.');
  const credenciais = { ...atual.credenciais };
  if (corpo.credenciais && typeof corpo.credenciais === 'object') {
    for (const [k, v] of Object.entries(corpo.credenciais)) {
      if (v === '' || v == null || ehMascarado(v)) continue; // vazio/mascarado = mantém
      credenciais[k] = String(v);
    }
  }
  const extra = corpo.extra && typeof corpo.extra === 'object' ? { ...atual.extra, ...corpo.extra } : atual.extra;
  await run('UPDATE config_recebimentos SET ativo=?, ambiente=?, credenciais_json=?, extra_json=? WHERE loja_id=1 AND meio=?',
    corpo.ativo === undefined ? atual.ativo : (corpo.ativo ? 1 : 0),
    corpo.ambiente || atual.ambiente,
    JSON.stringify(credenciais), JSON.stringify(extra), meio);
  return (await listarConfigMascarado()).find(x => x.meio === meio);
}

// Métodos que o checkout pode mostrar: só ativos E configurados (online).
async function metodosPublicos(loja) {
  const metodos = [];
  const pix = await getConfig('pix_presencial');
  if (pix && pix.ativo) metodos.push({ codigo: 'pix', rotulo: 'Pix (na entrega)', online: false });
  const cartao = await getConfig('cartao_presencial');
  if (cartao && cartao.ativo) metodos.push({ codigo: 'cartao', rotulo: 'Cartão (na entrega)', online: false });
  const din = await getConfig('dinheiro');
  if (din && din.ativo) metodos.push({ codigo: 'dinheiro', rotulo: 'Dinheiro', online: false });
  const mp = await getConfig('mercadopago');
  if (mp && mp.ativo && mp.credenciais.access_token) {
    metodos.push({ codigo: 'pix_mp', rotulo: 'Pix online (Mercado Pago)', online: true });
    metodos.push({ codigo: 'cartao_mp', rotulo: 'Cartão online (Mercado Pago)', online: true });
  }
  const asaas = await getConfig('asaas');
  if (asaas && asaas.ativo && asaas.credenciais.api_key) {
    metodos.push({ codigo: 'pix_asaas', rotulo: 'Pix online (Asaas)', online: true });
    metodos.push({ codigo: 'cartao_asaas', rotulo: 'Cartão online (Asaas)', online: true });
  }
  // chave pix da loja (cadastro) alimenta o pix_presencial se o extra estiver vazio
  if (loja && loja.chave_pix) { /* exibição fica a cargo do front via loja.chave_pix */ }
  return metodos;
}
const ehOnline = (metodo) => ['pix_mp', 'cartao_mp', 'pix_asaas', 'cartao_asaas'].includes(metodo);

// ---------------- Adaptadores ----------------
async function mpCriarPagamento(pedido, metodo) {
  const cfg = await getConfig('mercadopago');
  if (!cfg || !cfg.credenciais.access_token) throw new Error('Mercado Pago sem access_token.');
  const token = cfg.credenciais.access_token;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Idempotency-Key': `pedido-${pedido.id}` };
  const loja = await get('SELECT * FROM lojas WHERE id=1');
  if (metodo === 'pix_mp') {
    const resp = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST', headers, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        transaction_amount: pedido.total_centavos / 100,
        description: `Pedido #${pedido.numero} — Açaí do Guri`,
        payment_method_id: 'pix',
        external_reference: String(pedido.id),
        // MP exige payer.email; sem cadastro de e-mail do cliente usamos o da loja (limitação registrada no contrato)
        payer: { email: (loja && loja.email_pedidos) || 'pedidos@acaidoguri.local', first_name: pedido.cliente_nome },
      }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error('MP Pix HTTP ' + resp.status + ': ' + JSON.stringify(json).slice(0, 200));
    const td = json.point_of_interaction && json.point_of_interaction.transaction_data;
    return { externo_id: String(json.id), qr_texto: td ? td.qr_code : null, link_pagamento: td ? td.ticket_url : null };
  }
  // cartão: link via Checkout Pro (preference)
  const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST', headers, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      items: [{ title: `Pedido #${pedido.numero} — Açaí do Guri`, quantity: 1, unit_price: pedido.total_centavos / 100, currency_id: 'BRL' }],
      external_reference: String(pedido.id),
    }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('MP Preference HTTP ' + resp.status + ': ' + JSON.stringify(json).slice(0, 200));
  const link = cfg.ambiente === 'sandbox' ? (json.sandbox_init_point || json.init_point) : json.init_point;
  return { externo_id: String(json.id), qr_texto: null, link_pagamento: link };
}

function asaasBase(cfg) { return cfg.ambiente === 'sandbox' ? 'https://sandbox.asaas.com/api/v3' : 'https://api.asaas.com/v3'; }
async function asaasFetch(cfg, metodoHttp, caminho, corpo) {
  const resp = await fetch(asaasBase(cfg) + caminho, {
    method: metodoHttp, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', access_token: cfg.credenciais.api_key },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Asaas ${caminho} HTTP ` + resp.status + ': ' + JSON.stringify(json).slice(0, 200));
  return json;
}
async function asaasCriarPagamento(pedido, metodo) {
  const cfg = await getConfig('asaas');
  if (!cfg || !cfg.credenciais.api_key) throw new Error('Asaas sem api_key.');
  const fone = String(pedido.cliente_whatsapp || '').replace(/\D/g, '');
  const cliente = await asaasFetch(cfg, 'POST', '/customers', { name: pedido.cliente_nome, mobilePhone: fone });
  const vencimento = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const cobranca = await asaasFetch(cfg, 'POST', '/payments', {
    customer: cliente.id,
    billingType: metodo === 'pix_asaas' ? 'PIX' : 'UNDEFINED',
    value: pedido.total_centavos / 100,
    dueDate: vencimento,
    description: `Pedido #${pedido.numero} — Açaí do Guri`,
    externalReference: String(pedido.id),
  });
  let qr = null;
  if (metodo === 'pix_asaas') {
    try { const q = await asaasFetch(cfg, 'GET', `/payments/${cobranca.id}/pixQrCode`); qr = q.payload || null; } catch { /* QR opcional */ }
  }
  return { externo_id: String(cobranca.id), qr_texto: qr, link_pagamento: cobranca.invoiceUrl || null };
}

// Cria o registro de pagamento do pedido e, se online, chama o provedor.
async function iniciarPagamento(pedido, metodo) {
  if (!ehOnline(metodo)) {
    await run('INSERT INTO pagamentos (pedido_id, meio, provedor, valor_centavos, status) VALUES (?, ?, ?, ?, ?)',
      pedido.id, metodo, 'interno', pedido.total_centavos, 'nao_aplicavel');
    return { status: 'nao_aplicavel' };
  }
  const provedor = metodo.endsWith('_mp') ? 'mercadopago' : 'asaas';
  const info = await run('INSERT INTO pagamentos (pedido_id, meio, provedor, valor_centavos, status) VALUES (?, ?, ?, ?, ?)',
    pedido.id, metodo, provedor, pedido.total_centavos, 'pendente');
  const pagamentoId = Number(info.lastInsertRowid);
  try {
    const r = provedor === 'mercadopago' ? await mpCriarPagamento(pedido, metodo) : await asaasCriarPagamento(pedido, metodo);
    await run('UPDATE pagamentos SET externo_id=?, qr_texto=?, link_pagamento=?, atualizado_em=datetime(\'now\') WHERE id=?',
      r.externo_id, r.qr_texto, r.link_pagamento, pagamentoId);
    return { status: 'pendente', qr_texto: r.qr_texto, link_pagamento: r.link_pagamento };
  } catch (e) {
    await run('UPDATE pagamentos SET status=?, ultimo_evento=?, atualizado_em=datetime(\'now\') WHERE id=?',
      'erro_config', JSON.stringify({ erro: String(e.message || e).slice(0, 300) }), pagamentoId);
    await run('UPDATE pedidos SET pagamento_status=? WHERE id=?', 'erro_config', pedido.id);
    await notif.notificarDonoTexto(`⚠️ Pedido #${pedido.numero}: falha ao gerar pagamento online (${provedor}). Cobre manualmente na entrega.`, pedido.id);
    return { status: 'erro_config' };
  }
}

// Atualização vinda de webhook — idempotente: mesmo status não repete efeito.
async function aplicarStatusPagamento(pagamento, novoStatus, eventoResumo) {
  if (!pagamento) return;
  const anterior = pagamento.status;
  await run('UPDATE pagamentos SET status=?, ultimo_evento=?, atualizado_em=datetime(\'now\') WHERE id=?',
    novoStatus, JSON.stringify(eventoResumo || {}).slice(0, 2000), pagamento.id);
  await run('UPDATE pedidos SET pagamento_status=?, updated_at=datetime(\'now\') WHERE id=?', novoStatus, pagamento.pedido_id);
  if (anterior === novoStatus) return; // idempotência
  const pedido = await get('SELECT * FROM pedidos WHERE id=?', pagamento.pedido_id);
  if (!pedido) return;
  if (novoStatus === 'pago') {
    await notif.notificarDonoTexto(`💰 Pagamento do pedido #${pedido.numero} confirmado (${pagamento.provedor}).`, pedido.id);
    await notif.enfileirar({ canal: 'whatsapp_cliente', destino: pedido.cliente_whatsapp, corpo: `✅ Pagamento do pedido *#${pedido.numero}* confirmado! Obrigado. — Açaí do Guri`, pedidoId: pedido.id });
  }
  eventos.emitir('pedido', { acao: 'pagamento', pedido_id: pedido.id, numero: pedido.numero, pagamento_status: novoStatus });
}

// ---------------- Webhooks ----------------
async function webhookMercadoPago(corpo) {
  const cfg = await getConfig('mercadopago');
  const idPagamentoMp = (corpo && corpo.data && corpo.data.id) || (corpo && corpo.id);
  if (!idPagamentoMp || !cfg || !cfg.credenciais.access_token) return { processado: false };
  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${idPagamentoMp}`, {
    headers: { Authorization: `Bearer ${cfg.credenciais.access_token}` }, signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return { processado: false };
  const json = await resp.json().catch(() => ({}));
  const pag = await get('SELECT * FROM pagamentos WHERE provedor=? AND (externo_id=? OR pedido_id=?)',
    'mercadopago', String(json.id), Number(json.external_reference) || -1);
  if (!pag) return { processado: false };
  const mapa = { approved: 'pago', rejected: 'falhou', cancelled: 'falhou', refunded: 'estornado', charged_back: 'estornado', pending: 'pendente', in_process: 'pendente', authorized: 'pendente' };
  const novo = mapa[json.status];
  if (novo) await aplicarStatusPagamento(pag, novo, { provedor: 'mercadopago', status_mp: json.status, id: json.id });
  return { processado: true };
}
async function webhookAsaas(corpo, headers) {
  const cfg = await getConfig('asaas');
  const tokenEsperado = cfg && cfg.credenciais.webhook_token;
  if (tokenEsperado && headers['asaas-access-token'] !== tokenEsperado) return { processado: false, erro: 'token inválido' };
  const evento = corpo && corpo.event;
  const pay = (corpo && corpo.payment) || {};
  const pag = await get('SELECT * FROM pagamentos WHERE provedor=? AND (externo_id=? OR pedido_id=?)',
    'asaas', String(pay.id || ''), Number(pay.externalReference) || -1);
  if (!pag) return { processado: false };
  const mapa = { PAYMENT_RECEIVED: 'pago', PAYMENT_CONFIRMED: 'pago', PAYMENT_OVERDUE: 'falhou', PAYMENT_DELETED: 'falhou', PAYMENT_REFUNDED: 'estornado' };
  const novo = mapa[evento];
  if (novo) await aplicarStatusPagamento(pag, novo, { provedor: 'asaas', evento, id: pay.id });
  else await run('UPDATE pagamentos SET ultimo_evento=? WHERE id=?', JSON.stringify({ provedor: 'asaas', evento }).slice(0, 2000), pag.id);
  return { processado: true };
}

// ---------------- Teste de conexão ----------------
async function testarConexao(meio) {
  const cfg = await getConfig(meio);
  if (!cfg) return { ok: false, erro: 'Meio não encontrado.' };
  try {
    if (meio === 'mercadopago') {
      if (!cfg.credenciais.access_token) return { ok: false, erro: 'Access token não configurado.' };
      const resp = await fetch('https://api.mercadopago.com/users/me', { headers: { Authorization: `Bearer ${cfg.credenciais.access_token}` }, signal: AbortSignal.timeout(12000) });
      if (!resp.ok) return { ok: false, erro: 'Mercado Pago respondeu HTTP ' + resp.status };
      const json = await resp.json().catch(() => ({}));
      return { ok: true, detalhe: 'Conta conectada: ' + (json.nickname || json.email || json.id || 'ok') };
    }
    if (meio === 'asaas') {
      if (!cfg.credenciais.api_key) return { ok: false, erro: 'API key não configurada.' };
      const resp = await fetch(asaasBase(cfg) + '/myAccount', { headers: { access_token: cfg.credenciais.api_key }, signal: AbortSignal.timeout(12000) });
      if (!resp.ok) return { ok: false, erro: 'Asaas respondeu HTTP ' + resp.status };
      const json = await resp.json().catch(() => ({}));
      return { ok: true, detalhe: 'Conta conectada: ' + (json.name || json.email || json.id || 'ok') };
    }
    return { ok: true, detalhe: 'Meio presencial — nada para testar.' };
  } catch (e) {
    return { ok: false, erro: String(e.message || e).slice(0, 200) };
  }
}

module.exports = { MEIOS, CAMPOS_CREDENCIAIS, getConfig, listarConfigMascarado, atualizarConfig, metodosPublicos, ehOnline, iniciarPagamento, webhookMercadoPago, webhookAsaas, testarConexao };

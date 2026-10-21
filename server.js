'use strict';
// Servidor local do Sistema de Pedidos — Açaí do Guri.
// Rotas NÃO contêm SQL: todo acesso a dados passa por src/db.js (DAL) e pelos serviços.
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const db = require('./src/db');
const { get, all, run } = db;
const util = require('./src/util');
util.carregarEnv(path.join(__dirname, '.env'));

const pedidosCore = require('./src/pedidos');
const financeiro = require('./src/financeiro');
const notif = require('./src/notificacoes');
const pagamentos = require('./src/pagamentos');
const comanda = require('./src/comanda');
const storage = require('./src/storage');
const eventos = require('./src/eventos');

notif.setTransicaoHandler((id, para, opts) => pedidosCore.transicionar(id, para, opts));

const app = express();
app.use(express.json({ limit: '1mb' }));

// Boot do banco: init() (confere/semeia) + preparar() (cache da config de
// notificações). TODA rota /api aguarda essa promise — no SQLite é imediata;
// no Postgres (Supabase) é o que garante schema conferido e seed aplicado
// antes da primeira resposta. Se rejeitar, a API responde 500 com a causa.
const pronto = (async () => { await db.init(); await notif.preparar(); })();
pronto.catch((e) => console.error('[banco]', e.message));
app.use('/api', async (req, res, next) => {
  try { await pronto; next(); }
  catch { res.status(500).json({ erro: 'Banco de dados indisponível.' }); }
});

// Express 4 não captura rejeição de handler async: este wrapper encaminha
// pro middleware de erro (500 "Erro interno.") em vez de derrubar o processo.
const h = (fn) => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

// ---------------- Auth ----------------
async function autenticar(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ erro: 'Não autenticado.' });
  const sessao = await get('SELECT * FROM sessoes WHERE token=?', token);
  if (!sessao) return res.status(401).json({ erro: 'Sessão inválida. Faça login de novo.' });
  req.usuario = await get('SELECT id, nome, login, perfil FROM usuarios WHERE id=?', sessao.usuario_id);
  if (!req.usuario) return res.status(401).json({ erro: 'Usuário não encontrado.' });
  next();
}
const auth = h(autenticar);

app.post('/api/auth/login', h(async (req, res) => {
  const { login, senha } = req.body || {};
  const u = await get('SELECT * FROM usuarios WHERE login=? AND ativo=1', String(login || ''));
  if (!u || !util.verificaSenha(senha || '', u.senha_hash)) return res.status(401).json({ erro: 'Login ou senha inválidos.' });
  const token = util.tokenAleatorio(24);
  await run('INSERT INTO sessoes (token, usuario_id) VALUES (?, ?)', token, u.id);
  res.json({ token, nome: u.nome, perfil: u.perfil });
}));
app.post('/api/auth/trocar-senha', auth, h(async (req, res) => {
  const { senha_atual, nova_senha } = req.body || {};
  const u = await get('SELECT * FROM usuarios WHERE id=?', req.usuario.id);
  if (!util.verificaSenha(senha_atual || '', u.senha_hash)) return res.status(422).json({ erro: 'Senha atual incorreta.' });
  if (!nova_senha || String(nova_senha).length < 6) return res.status(422).json({ erro: 'A nova senha precisa de pelo menos 6 caracteres.' });
  await run('UPDATE usuarios SET senha_hash=? WHERE id=?', util.hashSenha(nova_senha), u.id);
  res.json({ ok: true });
}));

// ---------------- Públicas ----------------
app.get('/api/public/loja', h(async (req, res) => {
  const loja = await pedidosCore.getLoja();
  const estado = util.lojaEstaAberta(loja);
  // pix presencial: chave pode estar na loja ou no extra do meio
  const pixCfg = await pagamentos.getConfig('pix_presencial');
  const chavePix = (pixCfg && pixCfg.extra && pixCfg.extra.chave_pix) || loja.chave_pix || '';
  res.json({
    id: loja.id, nome: loja.nome, logo_url: loja.logo_url, capa_url: loja.capa_url,
    whatsapp: loja.whatsapp, instagram: loja.instagram, endereco_texto: loja.endereco_texto,
    tempo_preparo_min: loja.tempo_preparo_min, tempo_entrega_min: loja.tempo_entrega_min,
    pedido_minimo_centavos: loja.pedido_minimo_centavos, taxa_unica_centavos: loja.taxa_unica_centavos,
    chave_pix: chavePix, aberta: estado.aberta, pausada: estado.pausada, mensagem_status: estado.mensagem,
    metodos_pagamento: await pagamentos.metodosPublicos(loja),
  });
}));
app.get('/api/public/cardapio', h(async (req, res) => res.json(await pedidosCore.montarCardapio())));
app.get('/api/public/bairros', h(async (req, res) => res.json(await all('SELECT id, bairro, taxa_centavos, ativo FROM bairros WHERE loja_id=1 AND ativo=1 ORDER BY bairro'))));

app.post('/api/public/pedidos', h(async (req, res) => {
  try {
    // método online define a forma base (pix_mp/cartao_mp → provedor; forma_pagamento legado é derivado)
    const corpo = { ...(req.body || {}) };
    const metodo = String(corpo.metodo_pagamento || corpo.forma_pagamento || 'dinheiro');
    corpo.metodo_pagamento = metodo;
    if (!corpo.forma_pagamento) corpo.forma_pagamento = metodo.startsWith('pix') ? 'pix' : metodo.startsWith('cartao') ? 'cartao' : 'dinheiro';
    const { pedido } = await pedidosCore.criarPedido(corpo);
    let pagamentoResp = null;
    try {
      const pag = await pagamentos.iniciarPagamento(pedido, metodo);
      pagamentoResp = { status: pag.status, qr_texto: pag.qr_texto || null, link_pagamento: pag.link_pagamento || null };
      const pagRow = await get('SELECT status FROM pagamentos WHERE pedido_id=? ORDER BY id DESC LIMIT 1', pedido.id);
      if (pagRow && pagRow.status === 'pendente') {
        await notif.notificarDonoTexto(`⏳ Pedido #${pedido.numero} aguardando pagamento online (${metodo}).`, pedido.id);
      }
    } catch (e) {
      pagamentoResp = { status: 'erro_config' }; // nunca bloqueia a venda
    }
    res.status(201).json({ numero: pedido.numero, token: pedido.token, total_centavos: pedido.total_centavos, status: pedido.status, pagamento: pagamentoResp });
  } catch (e) {
    res.status(422).json({ erro: String(e.message || e) });
  }
}));
app.get('/api/public/pedidos/:token', h(async (req, res) => {
  const pedido = await get('SELECT * FROM pedidos WHERE token=?', req.params.token);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(await pedidosCore.detalhePedido(pedido));
}));

// ---------------- Webhooks públicos ----------------
app.post('/api/webhooks/mercadopago', async (req, res) => {
  try { await pagamentos.webhookMercadoPago(req.body || {}); } catch (e) { console.error('[webhook mp]', e.message); }
  res.status(200).json({ ok: true });
});
app.post('/api/webhooks/asaas', async (req, res) => {
  try { await pagamentos.webhookAsaas(req.body || {}, req.headers); } catch (e) { console.error('[webhook asaas]', e.message); }
  res.status(200).json({ ok: true });
});
// Telegram por webhook (produção/Vercel via setWebhook) — MESMO handler do poller local.
app.post('/api/webhooks/telegram', async (req, res) => {
  try { await notif.tratarUpdateTelegram(req.body || {}); } catch (e) { console.error('[webhook telegram]', e.message); }
  res.status(200).json({ ok: true });
});

// ---------------- Painel: pedidos ----------------
app.get('/api/painel/pedidos', auth, h(async (req, res) => {
  const lista = await all("SELECT * FROM pedidos WHERE loja_id=1 AND date(created_at,'localtime')=date('now','localtime') ORDER BY id DESC");
  const saida = [];
  for (const p of lista) saida.push({ ...p, itens: await pedidosCore.getItensPedido(p.id) });
  res.json(saida);
}));
app.get('/api/painel/pedidos/:id', auth, h(async (req, res) => {
  const p = await pedidosCore.getPedido(Number(req.params.id));
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(await pedidosCore.detalhePedido(p));
}));
app.post('/api/painel/pedidos/:id/transicao', auth, h(async (req, res) => {
  const { para_status, motivo } = req.body || {};
  const r = await pedidosCore.transicionar(Number(req.params.id), String(para_status || ''), { origem: 'painel', motivo: motivo || null });
  if (!r.ok) return res.status(422).json({ erro: r.erro });
  res.json({ ok: true, pedido: r.pedido });
}));
app.post('/api/painel/pedidos/:id/imprimir', auth, h(async (req, res) => {
  const p = await pedidosCore.getPedido(Number(req.params.id));
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  const detalhe = await pedidosCore.detalhePedido(p);
  const texto = comanda.montarComanda(detalhe);
  let impressaoStatus = 'registrada';
  if (process.env.IMPRESSORA_IP) {
    const r = await comanda.enviarParaImpressora(texto);
    impressaoStatus = r.enviado ? 'impressa' : 'falhou';
    await run('INSERT INTO impressoes (pedido_id, tipo, status, erro) VALUES (?, ?, ?, ?)', p.id, 'comanda', impressaoStatus, r.enviado ? null : r.motivo);
  } else {
    await run('INSERT INTO impressoes (pedido_id, tipo, status) VALUES (?, ?, ?)', p.id, 'comanda', 'registrada');
  }
  res.json({ comanda: texto, impressao: impressaoStatus });
}));

// ---------------- Painel: CRUD genérico ----------------
const CRUD = {
  categorias: { tabela: 'categorias', campos: ['nome', 'ordem', 'ativa'], numericos: ['ordem', 'ativa'], ordemLista: 'ordem, id', colunaAtivo: 'ativa' },
  produtos: { tabela: 'produtos', campos: ['categoria_id', 'nome', 'descricao', 'foto_url', 'preco_base_centavos', 'tipo', 'destaque', 'ativo', 'esgotado', 'ordem'], numericos: ['categoria_id', 'preco_base_centavos', 'destaque', 'ativo', 'esgotado', 'ordem'], ordemLista: 'ordem, id', colunaAtivo: 'ativo' },
  grupos: { tabela: 'grupos_opcoes', campos: ['nome', 'tipo_escolha', 'minimo', 'maximo', 'obrigatorio', 'excedente_vira_pago', 'preco_excedente_centavos', 'ativo', 'ordem'], numericos: ['minimo', 'maximo', 'obrigatorio', 'excedente_vira_pago', 'preco_excedente_centavos', 'ativo', 'ordem'], ordemLista: 'ordem, id', colunaAtivo: 'ativo' },
  opcoes: { tabela: 'opcoes', campos: ['grupo_id', 'nome', 'preco_adicional_centavos', 'ativa', 'esgotada', 'ordem'], numericos: ['grupo_id', 'preco_adicional_centavos', 'ativa', 'esgotada', 'ordem'], semLoja: true, ordemLista: 'grupo_id, ordem, id', colunaAtivo: 'ativa' },
  bairros: { tabela: 'bairros', campos: ['bairro', 'taxa_centavos', 'ativo'], numericos: ['taxa_centavos', 'ativo'], ordemLista: 'bairro, id', colunaAtivo: 'ativo' },
};
function valorCampo(cfg, campo, valor) {
  if (valor === undefined) return undefined;
  if (cfg.numericos.includes(campo)) {
    if (valor === null || valor === '') return campo === 'maximo' ? null : 0;
    if (typeof valor === 'boolean') return valor ? 1 : 0;
    return Number(valor);
  }
  return valor;
}
for (const [recurso, cfg] of Object.entries(CRUD)) {
  const base = '/api/painel/' + recurso;
  app.get(base, auth, h(async (req, res) => {
    const where = cfg.semLoja ? '' : ' WHERE loja_id=1';
    res.json(await all(`SELECT * FROM ${cfg.tabela}${where} ORDER BY ${cfg.ordemLista}`));
  }));
  app.post(base, auth, h(async (req, res) => {
    const corpo = req.body || {};
    const campos = cfg.campos.filter(c => corpo[c] !== undefined);
    const valores = campos.map(c => valorCampo(cfg, c, corpo[c]));
    const cols = (cfg.semLoja ? campos : ['loja_id', ...campos]);
    const vals = cfg.semLoja ? valores : [1, ...valores];
    const info = await run(`INSERT INTO ${cfg.tabela} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...vals);
    const id = Number(info.lastInsertRowid);
    if (recurso === 'produtos') await salvarGruposProduto(id, corpo.grupo_ids);
    res.status(201).json(await get(`SELECT * FROM ${cfg.tabela} WHERE id=?`, id));
  }));
  app.put(base + '/:id', auth, h(async (req, res) => {
    const id = Number(req.params.id);
    const atual = await get(`SELECT * FROM ${cfg.tabela} WHERE id=?`, id);
    if (!atual) return res.status(404).json({ erro: 'Registro não encontrado.' });
    const corpo = req.body || {};
    const campos = cfg.campos.filter(c => corpo[c] !== undefined);
    if (campos.length) {
      await run(`UPDATE ${cfg.tabela} SET ${campos.map(c => c + '=?').join(',')} WHERE id=?`, ...campos.map(c => valorCampo(cfg, c, corpo[c])), id);
    }
    if (recurso === 'produtos' && Array.isArray(corpo.grupo_ids)) await salvarGruposProduto(id, corpo.grupo_ids);
    res.json(await get(`SELECT * FROM ${cfg.tabela} WHERE id=?`, id));
  }));
  app.delete(base + '/:id', auth, h(async (req, res) => {
    const id = Number(req.params.id);
    await run(`UPDATE ${cfg.tabela} SET ${cfg.colunaAtivo}=0 WHERE id=?`, id);
    res.json({ ok: true });
  }));
}
async function salvarGruposProduto(produtoId, grupoIds) {
  if (!Array.isArray(grupoIds)) return;
  await run('DELETE FROM produto_grupos WHERE produto_id=?', produtoId);
  for (let i = 0; i < grupoIds.length; i++) {
    await run('INSERT INTO produto_grupos (produto_id, grupo_id, ordem) VALUES (?, ?, ?)', produtoId, Number(grupoIds[i]), i + 1);
  }
}
app.get('/api/painel/produtos/:id/grupos', auth, h(async (req, res) => {
  res.json(await all('SELECT grupo_id, ordem FROM produto_grupos WHERE produto_id=? ORDER BY ordem', Number(req.params.id)));
}));

// ---------------- Painel: upload ----------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
app.post('/api/painel/upload', auth, upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(422).json({ erro: 'Envie uma imagem (até 5MB) no campo "arquivo".' });
  try {
    const r = await storage.salvarArquivo(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: String(e.message || e) });
  }
});

// ---------------- Painel: loja ----------------
app.get('/api/painel/loja', auth, h(async (req, res) => res.json(await pedidosCore.getLoja())));
app.patch('/api/painel/loja', auth, h(async (req, res) => {
  const campos = ['nome', 'logo_url', 'capa_url', 'whatsapp', 'instagram', 'endereco_texto', 'tempo_preparo_min', 'tempo_entrega_min', 'pedido_minimo_centavos', 'taxa_unica_centavos', 'chave_pix', 'email_pedidos', 'aberta_manual', 'horario_abre', 'horario_fecha', 'som_pedido'];
  const corpo = req.body || {};
  const usar = campos.filter(c => corpo[c] !== undefined);
  if (usar.length) {
    const vals = usar.map(c => (typeof corpo[c] === 'boolean' ? (corpo[c] ? 1 : 0) : corpo[c]));
    await run(`UPDATE lojas SET ${usar.map(c => c + '=?').join(',')}, updated_at=datetime('now') WHERE id=1`, ...vals);
    eventos.emitir('loja', { acao: 'atualizada' });
  }
  res.json(await pedidosCore.getLoja());
}));
app.post('/api/painel/loja/pausar', auth, h(async (req, res) => {
  const minutos = Math.max(1, Number((req.body || {}).minutos || 30));
  const ate = new Date(Date.now() + minutos * 60000).toISOString();
  await run('UPDATE lojas SET pausada_ate=? WHERE id=1', ate);
  eventos.emitir('loja', { acao: 'pausada', ate });
  res.json({ ok: true, pausada_ate: ate });
}));
app.post('/api/painel/loja/reabrir', auth, h(async (req, res) => {
  await run('UPDATE lojas SET pausada_ate=NULL WHERE id=1');
  eventos.emitir('loja', { acao: 'reaberta' });
  res.json({ ok: true });
}));

// ---------------- Painel: Meios de Recebimento ----------------
app.get('/api/painel/recebimentos', auth, h(async (req, res) => res.json(await pagamentos.listarConfigMascarado())));
app.patch('/api/painel/recebimentos/:meio', auth, h(async (req, res) => {
  if (!pagamentos.MEIOS.includes(req.params.meio)) return res.status(404).json({ erro: 'Meio desconhecido.' });
  try { res.json(await pagamentos.atualizarConfig(req.params.meio, req.body || {})); }
  catch (e) { res.status(422).json({ erro: String(e.message || e) }); }
}));
app.post('/api/painel/recebimentos/:meio/testar', auth, async (req, res) => {
  if (!pagamentos.MEIOS.includes(req.params.meio)) return res.status(404).json({ erro: 'Meio desconhecido.' });
  res.json(await pagamentos.testarConexao(req.params.meio));
});

// ---------------- Painel: Financeiro (v1.1) ----------------
function tratarErroFinanceiro(res, e) {
  if (e && e.status === 422) return res.status(422).json({ erro: e.message });
  throw e;
}
app.get('/api/painel/financeiro/lancamentos', auth, h(async (req, res) => {
  const { data, tipo } = req.query;
  if (data && !financeiro.dataValida(String(data))) return res.status(422).json({ erro: 'Data inválida. Use o formato AAAA-MM-DD.' });
  if (tipo && !financeiro.TIPOS_LANCAMENTO.includes(String(tipo))) return res.status(422).json({ erro: 'Tipo de lançamento inválido.' });
  res.json(await financeiro.listarLancamentos({ data: data ? String(data) : null, tipo: tipo ? String(tipo) : null }));
}));
app.post('/api/painel/financeiro/lancamentos', auth, h(async (req, res) => {
  try { res.status(201).json(await financeiro.criarLancamento(req.body || {})); }
  catch (e) { tratarErroFinanceiro(res, e); }
}));
app.put('/api/painel/financeiro/lancamentos/:id', auth, h(async (req, res) => {
  try {
    const r = await financeiro.atualizarLancamento(Number(req.params.id), req.body || {});
    if (!r) return res.status(404).json({ erro: 'Lançamento não encontrado.' });
    res.json(r);
  } catch (e) { tratarErroFinanceiro(res, e); }
}));
app.delete('/api/painel/financeiro/lancamentos/:id', auth, h(async (req, res) => {
  if (!(await financeiro.excluirLancamento(Number(req.params.id)))) return res.status(404).json({ erro: 'Lançamento não encontrado.' });
  res.json({ ok: true });
}));
app.get('/api/painel/financeiro/insumos', auth, h(async (req, res) => {
  const { data } = req.query;
  if (data && !financeiro.dataValida(String(data))) return res.status(422).json({ erro: 'Data inválida. Use o formato AAAA-MM-DD.' });
  res.json(await financeiro.listarInsumos({ data: data ? String(data) : null }));
}));
app.post('/api/painel/financeiro/insumos', auth, h(async (req, res) => {
  try { res.status(201).json(await financeiro.criarInsumo(req.body || {})); }
  catch (e) { tratarErroFinanceiro(res, e); }
}));
app.put('/api/painel/financeiro/insumos/:id', auth, h(async (req, res) => {
  try {
    const r = await financeiro.atualizarInsumo(Number(req.params.id), req.body || {});
    if (!r) return res.status(404).json({ erro: 'Insumo não encontrado.' });
    res.json(r);
  } catch (e) { tratarErroFinanceiro(res, e); }
}));
app.delete('/api/painel/financeiro/insumos/:id', auth, h(async (req, res) => {
  if (!(await financeiro.excluirInsumo(Number(req.params.id)))) return res.status(404).json({ erro: 'Insumo não encontrado.' });
  res.json({ ok: true });
}));
app.get('/api/painel/financeiro/calculo', auth, h(async (req, res) => {
  const data = req.query.data ? String(req.query.data) : financeiro.dataHoje();
  if (!financeiro.dataValida(data)) return res.status(422).json({ erro: 'Data inválida. Use o formato AAAA-MM-DD.' });
  res.json(await financeiro.calcular(data));
}));

// ---------------- Painel: relatório, saúde, SSE ----------------
app.get('/api/painel/relatorio/pdf', auth, h(async (req, res) => {
  const data = req.query.data ? String(req.query.data) : financeiro.dataHoje();
  if (!financeiro.dataValida(data)) return res.status(422).json({ erro: 'Data inválida. Use o formato AAAA-MM-DD.' });
  const loja = await pedidosCore.getLoja();
  financeiro.gerarPdfRelatorio(await financeiro.resumoRelatorio(data), loja ? loja.nome : 'Loja', res);
}));
app.get('/api/painel/relatorio', auth, h(async (req, res) => {
  const data = req.query.data ? String(req.query.data) : financeiro.dataHoje();
  if (!financeiro.dataValida(data)) return res.status(422).json({ erro: 'Data inválida. Use o formato AAAA-MM-DD.' });
  const dia = "date(created_at,'localtime')=?";
  const diaP = "date(p.created_at,'localtime')=?";
  const concluidos = await get(`SELECT COUNT(*) c, COALESCE(SUM(total_centavos),0) s FROM pedidos WHERE loja_id=1 AND ${dia} AND status='ENTREGUE'`, data);
  const cancelados = await get(`SELECT COUNT(*) c FROM pedidos WHERE loja_id=1 AND ${dia} AND status='CANCELADO'`, data);
  res.json({
    data,
    pedidos_concluidos: concluidos.c,
    cancelados: cancelados.c,
    faturamento_centavos: concluidos.s,
    ticket_medio_centavos: concluidos.c ? Math.round(concluidos.s / concluidos.c) : 0,
    top_produtos: await all(`SELECT pi.nome_snapshot AS nome, SUM(pi.quantidade) AS qtd FROM pedido_itens pi JOIN pedidos p ON p.id=pi.pedido_id WHERE ${diaP} GROUP BY pi.nome_snapshot ORDER BY qtd DESC LIMIT 10`, data),
    top_opcoes: await all(`SELECT po.opcao_nome AS nome, COUNT(*) AS qtd FROM pedido_item_opcoes po JOIN pedido_itens pi ON pi.id=po.pedido_item_id JOIN pedidos p ON p.id=pi.pedido_id WHERE ${diaP} GROUP BY po.opcao_nome ORDER BY qtd DESC LIMIT 10`, data),
    por_pagamento: {
      pix: (await get(`SELECT COUNT(*) c FROM pedidos WHERE loja_id=1 AND ${dia} AND forma_pagamento='pix'`, data)).c,
      dinheiro: (await get(`SELECT COUNT(*) c FROM pedidos WHERE loja_id=1 AND ${dia} AND forma_pagamento='dinheiro'`, data)).c,
      cartao: (await get(`SELECT COUNT(*) c FROM pedidos WHERE loja_id=1 AND ${dia} AND forma_pagamento='cartao'`, data)).c,
    },
  });
}));
app.get('/api/painel/saude', auth, h(async (req, res) => {
  let banco = 'ok';
  try { await get('SELECT 1 AS um'); } catch { banco = 'erro'; }
  res.json({
    whatsapp: { configurado: notif.evolutionConfigurado() },
    telegram: { configurado: notif.telegramConfigurado() },
    storage: storage.driver(),
    banco,
  });
}));

// ---------------- Painel: Configurações (WhatsApp/Telegram — v1.3) ----------------
// A config vive no banco (config_notificacoes) com fallback por campo pro .env;
// segredos NUNCA voltam inteiros: GET/PUT devolvem só a versão mascarada.
app.get('/api/painel/configuracoes', auth, (req, res) => {
  res.json(notif.cfgPublica());
});
app.put('/api/painel/configuracoes', auth, h(async (req, res) => {
  const r = await notif.salvarCfg(req.body || {});
  if (!r.ok) return res.status(r.status || 422).json({ erro: r.erro });
  res.json(r.cfg);
}));
app.post('/api/painel/configuracoes/testar-whatsapp', auth, async (req, res) => {
  try {
    const r = await notif.testarWhatsapp();
    if (r.status === 422) return res.status(422).json({ erro: r.erro });
    res.json(r);
  } catch (e) { res.status(500).json({ erro: 'Erro interno ao testar o WhatsApp.' }); }
});
app.post('/api/painel/configuracoes/testar-telegram', auth, async (req, res) => {
  try {
    const r = await notif.testarTelegram();
    if (r.status === 422) return res.status(422).json({ erro: r.erro });
    res.json(r);
  } catch (e) { res.status(500).json({ erro: 'Erro interno ao testar o Telegram.' }); }
});
app.post('/api/painel/configuracoes/telegram/detectar-chat', auth, async (req, res) => {
  try {
    res.json(await notif.detectarChatTelegram()); // nunca 500 por conflito/nada encontrado
  } catch (e) { res.json({ ok: false, mensagem: 'Não consegui procurar sua conversa agora. Abra o bot, mande um "oi", aguarde uns segundos e tente de novo.' }); }
});
app.get('/api/painel/stream', h(async (req, res) => {
  const sessao = await get('SELECT * FROM sessoes WHERE token=?', String(req.query.token || ''));
  if (!sessao) return res.status(401).json({ erro: 'Não autenticado.' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('event: ola\ndata: {}\n\n');
  eventos.registrarCliente(res);
}));

// ---------------- Estáticos ----------------
app.use('/uploads', express.static(storage.UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/painel', (req, res) => {
  const f = path.join(__dirname, 'public', 'painel.html');
  if (fs.existsSync(f)) res.sendFile(f); else res.status(404).send('Painel ainda não construído.');
});
app.get('/', (req, res) => {
  const f = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(f)) res.sendFile(f); else res.status(404).send('Loja ainda não construída.');
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(422).json({ erro: 'Arquivo maior que 5MB.' });
  console.error(err);
  res.status(500).json({ erro: 'Erro interno.' });
});

module.exports = app;

// Só escuta quando executado direto (node server.js / npm start).
// Na Vercel, quem importa é api/index.js — sem listen.
if (require.main === module) {
  const porta = Number(process.env.PORT || 3333);
  app.listen(porta, () => console.log(`🍧 Pedidos Açaí do Guri ouvindo em http://localhost:${porta} (loja / · painel /painel)`));
  // Worker de notificações/poller só no processo local, e só depois do boot
  // do banco (a cfg do Telegram vem do cache carregado no preparar()).
  pronto.then(() => notif.iniciar(), () => notif.iniciar());
}

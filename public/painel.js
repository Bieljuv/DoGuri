'use strict';
/* ================= Painel da Empresa — Açaí do Guri ================= */
const $  = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const BRL = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' });
const fmtBRL = (cent) => BRL.format((Number(cent)||0)/100);
/* O banco guarda as datas em UTC ("2026-10-21 04:05:06", sem fuso). Sem o 'Z',
   o navegador lê como horário local e mostra 3h a mais — aqui convertemos certo
   pro horário de quem está vendo (Brasília). */
function dataServidor(iso) {
  if (!iso) return null;
  let s = String(iso);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

const state = {
  token: localStorage.getItem('painel_token') || '',
  user: JSON.parse(localStorage.getItem('painel_user') || 'null'),
  loja: null,
  pedidos: [],
  detalheId: null,
  categorias: [], produtos: [], grupos: [], bairros: [],
  recebimentos: {}, configuracoes: null,
  relData: '', finData: '', finTipoSel: 'investimento', finEditandoId: null, finCalculo: null,
  view: 'pedidos',
  audioCtx: null, somAtivo: false, somTimer: null,
  sse: null, pollTimer: null,
};

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const res = await fetch(path, { method: opts.method || 'GET', headers, body });
  if (res.status === 401) { sair(false); throw new Error('Sessão expirada. Entre de novo.'); }
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (!res.ok) throw new Error((data && (data.erro || data.message)) || ('Erro ' + res.status));
  return data;
}
async function uploadArquivo(file) {
  const fd = new FormData();
  fd.append('arquivo', file);
  const data = await api('/api/painel/upload', { method: 'POST', body: fd });
  return data.url;
}

/* ---------- Toast ---------- */
function toast(msg, erro = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (erro ? ' erro' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

/* ---------- Dinheiro (input R$ -> centavos) ---------- */
function wireMoney(input) {
  input.addEventListener('input', () => {
    const dig = input.value.replace(/\D/g, '');
    if (!dig) { input.value = ''; input.dataset.centavos = ''; return; }
    const cent = parseInt(dig, 10);
    input.dataset.centavos = String(cent);
    input.value = (cent/100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  });
}
function setMoney(input, cent) {
  if (cent === null || cent === undefined || cent === '') { input.value = ''; input.dataset.centavos = ''; return; }
  input.dataset.centavos = String(cent);
  input.value = (Number(cent)/100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function getMoney(input) {
  if (input.dataset.centavos === '' || input.dataset.centavos === undefined) {
    const dig = input.value.replace(/\D/g, '');
    return dig ? parseInt(dig, 10) : null;
  }
  return parseInt(input.dataset.centavos, 10);
}
$$('.money').forEach(wireMoney);

/* ---------- Modal genérico ---------- */
function openModal(titulo, html) {
  $('#modalTitulo').textContent = titulo;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $('#modalOverlay').classList.remove('hidden');
  $$('.money', $('#modalBody')).forEach(wireMoney);
  return $('#modalBody');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalOverlay').classList.add('hidden'); }
$('#modalFechar').addEventListener('click', closeModal);
$('#modalOverlay').addEventListener('click', closeModal);

/* ---------- Autenticação ---------- */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const erro = $('#loginErro'); erro.classList.add('hidden');
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: { login: $('#loginUser').value.trim(), senha: $('#loginPass').value } });
    state.token = data.token;
    state.user = { nome: data.nome, perfil: data.perfil };
    localStorage.setItem('painel_token', state.token);
    localStorage.setItem('painel_user', JSON.stringify(state.user));
    iniciarApp();
  } catch (err) {
    erro.textContent = err.message || 'Usuário ou senha inválidos.';
    erro.classList.remove('hidden');
  }
});
function sair(avisar = true) {
  state.token = ''; state.user = null;
  localStorage.removeItem('painel_token'); localStorage.removeItem('painel_user');
  if (state.sse) { state.sse.close(); state.sse = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  pararSom();
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  if (avisar) toast('Você saiu do painel.');
}
$('#btnSair').addEventListener('click', () => sair(true));

$('#btnTrocarSenha').addEventListener('click', () => {
  const body = openModal('Trocar senha', `
    <form id="formSenha">
      <label>Senha atual <input type="password" id="senhaAtual" autocomplete="current-password" required></label>
      <label>Nova senha <input type="password" id="senhaNova" autocomplete="new-password" minlength="6" required></label>
      <label>Repetir nova senha <input type="password" id="senhaNova2" autocomplete="new-password" minlength="6" required></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar nova senha</button></div>
    </form>`);
  $('#formSenha', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if ($('#senhaNova', body).value !== $('#senhaNova2', body).value) { toast('As senhas novas não conferem.', true); return; }
    try {
      await api('/api/auth/trocar-senha', { method: 'POST', body: { senha_atual: $('#senhaAtual', body).value, nova_senha: $('#senhaNova', body).value } });
      closeModal(); toast('Senha alterada com sucesso.');
    } catch (err) { toast(err.message, true); }
  });
});

/* ---------- Navegação ---------- */
const TITULOS = {
  pedidos: 'Pedidos', cardapio: 'Cardápio', grupos: 'Grupos e Opções', bairros: 'Bairros e Taxas',
  'rec-presencial': 'Meios de Recebimento — Presencial', 'rec-mp': 'Meios de Recebimento — Mercado Pago',
  'rec-asaas': 'Meios de Recebimento — Asaas', loja: 'Loja e Aparência', relatorio: 'Relatório do Dia',
  financeiro: 'Financeiro', configuracoes: 'Configurações',
};
function irPara(view) {
  state.view = view;
  $$('.menu-item[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(s => s.classList.add('hidden'));
  const sec = $('#view-' + view);
  if (sec) sec.classList.remove('hidden');
  $('#viewTitle').textContent = TITULOS[view] || view;
  if (view === 'pedidos') carregarPedidos();
  if (view === 'cardapio') carregarCardapio();
  if (view === 'grupos') carregarGrupos();
  if (view === 'bairros') carregarBairros();
  if (view.startsWith('rec-')) carregarRecebimentos();
  if (view === 'loja') preencherLoja();
  if (view === 'relatorio') carregarRelatorio();
  if (view === 'financeiro') carregarFinanceiro();
  if (view === 'configuracoes') carregarConfiguracoes();
}
$$('.menu-item[data-view]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.view.startsWith('rec-')) { $('#accReceb').classList.add('open'); $('#accRecebBtn').setAttribute('aria-expanded', 'true'); }
  irPara(b.dataset.view);
}));
$('#accRecebBtn').addEventListener('click', () => {
  const aberto = $('#accReceb').classList.toggle('open');
  $('#accRecebBtn').setAttribute('aria-expanded', String(aberto));
});

/* ---------- Loja: topo (aberta / pausar / saúde) ---------- */
function lojaAbertaCalc(l) {
  return l && l.aberta !== undefined ? !!l.aberta : !!(l && l.aberta_manual);
}
async function carregarLoja() {
  try {
    state.loja = await api('/api/painel/loja');
    const l = state.loja;
    $('#sideNome').textContent = l.nome || 'Minha loja';
    if (l.logo_url) { const img = $('#sideLogo'); img.src = l.logo_url; img.style.display = ''; }
    $('#toggleAberta').checked = !!l.aberta_manual;
    $('#lblAberta').textContent = l.aberta_manual ? 'Loja aberta' : 'Loja fechada';
    const pausada = !!l.pausada || (l.pausada_ate && new Date(l.pausada_ate) > new Date());
    $('#btnReabrir').classList.toggle('hidden', !pausada);
    $('#btnPausar').classList.toggle('hidden', pausada);
    $('#pausaInfo').textContent = pausada ? ('⏸ Pausada' + (l.pausada_ate && dataServidor(l.pausada_ate) ? ' até ' + dataServidor(l.pausada_ate).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }) : '')) : '';
  } catch { /* silencioso */ }
}
$('#toggleAberta').addEventListener('change', async (e) => {
  try {
    await api('/api/painel/loja', { method: 'PATCH', body: { aberta_manual: e.target.checked } });
    toast(e.target.checked ? 'Loja aberta para pedidos.' : 'Loja fechada. Nenhum pedido novo entra.');
    carregarLoja();
  } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
});
$('#btnPausar').addEventListener('click', () => $('#pausarMenu').classList.toggle('hidden'));
$$('#pausarMenu button').forEach(b => b.addEventListener('click', async () => {
  $('#pausarMenu').classList.add('hidden');
  try {
    await api('/api/painel/loja/pausar', { method: 'POST', body: { minutos: Number(b.dataset.min) } });
    toast(`Loja pausada por ${b.dataset.min} minutos.`);
    carregarLoja();
  } catch (err) { toast(err.message, true); }
}));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.pausar-wrap')) $('#pausarMenu').classList.add('hidden');
});
$('#btnReabrir').addEventListener('click', async () => {
  try { await api('/api/painel/loja/reabrir', { method: 'POST', body: {} }); toast('Loja reaberta.'); carregarLoja(); }
  catch (err) { toast(err.message, true); }
});

async function carregarSaude() {
  try {
    const s = await api('/api/painel/saude');
    const wa = s.whatsapp && s.whatsapp.configurado;
    const tg = s.telegram && s.telegram.configurado;
    $('#saudeBox').innerHTML =
      `<span class="pill ${wa ? 'on' : 'sim'}">WhatsApp: ${wa ? 'conectado' : 'modo simulado'}</span>` +
      `<span class="pill ${tg ? 'on' : 'sim'}">Telegram: ${tg ? 'conectado' : 'modo simulado'}</span>` +
      `<span class="pill ${s.banco === 'ok' ? 'on' : 'sim'}">Sistema: ${s.banco === 'ok' ? 'ok' : esc(s.banco || '—')}</span>`;
  } catch { $('#saudeBox').innerHTML = '<span class="pill sim">Saúde: indisponível</span>'; }
}

/* ---------- Tempo real (SSE + fallback polling) ---------- */
function conectarStream() {
  if (state.sse) state.sse.close();
  try {
    const es = new EventSource('/api/painel/stream?token=' + encodeURIComponent(state.token));
    state.sse = es;
    const aoEvento = () => { carregarPedidos(true); carregarLoja(); };
    es.addEventListener('pedido', aoEvento);
    es.addEventListener('loja', aoEvento);
    es.onmessage = aoEvento;
    es.onerror = () => { /* polling cobre */ };
  } catch { /* polling cobre */ }
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => { if (state.view === 'pedidos') carregarPedidos(true); }, 10000);
}

/* ---------- Som de alerta de novo pedido ---------- */
let audioArquivo = null;
function somSelecionado() { return (state.loja && state.loja.som_pedido) || 'padrao'; }
function bip() {
  try {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = state.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    [880, 1174, 1568].forEach((freq, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = freq; o.type = 'triangle';
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.55, ctx.currentTime + i * 0.16 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.15);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.16); o.stop(ctx.currentTime + i * 0.16 + 0.17);
    });
  } catch { /* sem áudio */ }
}
function tocarToque(sel, emLoop) {
  if (!sel || sel === 'padrao') { bip(); return; }
  if (!audioArquivo) audioArquivo = new Audio();
  const src = '/sons/' + sel;
  if (audioArquivo.dataset.src !== src) { audioArquivo.src = src; audioArquivo.dataset.src = src; }
  audioArquivo.loop = !!emLoop;
  audioArquivo.volume = 1;
  try { audioArquivo.currentTime = 0; } catch { /* início */ }
  audioArquivo.play().catch(() => { /* navegador libera após 1ª interação */ });
}
function atualizarSom() {
  const temNovo = state.pedidos.some(p => p.status === 'NOVO');
  if (temNovo && !state.somAtivo) {
    state.somAtivo = true;
    const sel = somSelecionado();
    if (sel && sel !== 'padrao') tocarToque(sel, true);
    else { bip(); state.somTimer = setInterval(bip, 2500); }
  } else if (!temNovo) pararSom();
}
function pararSom() {
  state.somAtivo = false;
  if (state.somTimer) { clearInterval(state.somTimer); state.somTimer = null; }
  if (audioArquivo) { try { audioArquivo.pause(); audioArquivo.currentTime = 0; } catch { /* ok */ } }
}
document.addEventListener('pointerdown', () => { if (state.somAtivo) pararSom(); });

/* ================= PEDIDOS ================= */
const FORMA_ROTULO = { pix:'Pix', dinheiro:'Dinheiro', cartao:'Cartão', pix_mp:'Pix MP', cartao_mp:'Cartão MP', pix_asaas:'Pix Asaas', cartao_asaas:'Cartão Asaas' };
const STATUS_ROTULO = { NOVO:'Novo', EM_PREPARO:'Em preparo', PRONTO:'Pronto', SAIU_ENTREGA:'Saiu p/ entrega', ENTREGUE:'Entregue', CANCELADO:'Cancelado' };
const COLUNAS = [
  { titulo:'🆕 Novos', status:['NOVO'] },
  { titulo:'👨‍🍳 Em preparo', status:['EM_PREPARO'] },
  { titulo:'✅ Prontos', status:['PRONTO'] },
  { titulo:'🛵 Saiu p/ entrega', status:['SAIU_ENTREGA'] },
  { titulo:'🏁 Finalizados hoje', status:['ENTREGUE','CANCELADO'] },
];
function nomeItem(it) { return it.nome || it.nome_snapshot || it.produto_nome || 'Item'; }
function nomeOpcao(op) { return op.nome || op.opcao_nome || op.nome_snapshot || ''; }
function grupoOpcao(op) { return op.grupo_nome || op.grupo || ''; }
function seloPagamento(p) {
  const st = p.pagamento_status;
  if (st === 'pendente') return '<span class="selo pag-pendente">⏳ aguardando pagamento</span>';
  if (st === 'pago') return '<span class="selo pag-pago">💰 pago</span>';
  if (st === 'falhou') return '<span class="selo pag-falhou">❌ pagamento falhou</span>';
  if (st === 'erro_config') return '<span class="selo pag-falhou">❌ pagamento não gerado</span>';
  if (st === 'estornado') return '<span class="selo pag-falhou">↩️ estornado</span>';
  return '';
}
function selosPedido(p) {
  return `<span class="selo ${p.tipo === 'entrega' ? 'entrega' : 'retirada'}">${p.tipo === 'entrega' ? 'ENTREGA' : 'RETIRADA'}</span>`
    + `<span class="selo">${esc(FORMA_ROTULO[p.forma_pagamento] || p.forma_pagamento || '')}</span>`
    + seloPagamento(p);
}
function minutosDesde(iso) {
  const d = dataServidor(iso) || new Date();
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
}
function classeTempo(min) { return min > 20 ? 'danger' : min > 10 ? 'warn' : ''; }
function resumoItens(p) {
  if (Array.isArray(p.itens)) return p.itens.map(it => `${it.quantidade || 1}x ${nomeItem(it)}`).join('\n');
  return p.itens_resumo || p.resumo || '';
}
async function carregarPedidos(silencioso = false) {
  try {
    const data = await api('/api/painel/pedidos');
    state.pedidos = Array.isArray(data) ? data : (data.pedidos || []);
    renderBoard();
    atualizarSom();
    const novos = state.pedidos.filter(p => p.status === 'NOVO').length;
    const badge = $('#badgeNovos');
    badge.textContent = String(novos); badge.classList.toggle('hidden', novos === 0);
    document.title = (novos ? `(${novos}) ` : '') + 'Painel — Açaí do Guri';
    if (state.detalheId) abrirDetalhe(state.detalheId, true);
  } catch (err) { if (!silencioso) toast(err.message, true); }
}
function renderBoard() {
  const soAguard = $('#filtroAguardando').checked;
  const lista = state.pedidos.filter(p => !soAguard || p.pagamento_status === 'pendente');
  $('#board').innerHTML = COLUNAS.map(col => {
    const itens = lista.filter(p => col.status.includes(p.status));
    return `<div class="coluna"><h4>${col.titulo} <span class="qtd">${itens.length}</span></h4>` +
      (itens.map(p => {
        const min = minutosDesde(p.created_at || p.criado_em);
        const ativo = !['ENTREGUE','CANCELADO'].includes(p.status);
        return `<article class="pcard ${p.status === 'NOVO' ? 'novo' : ''}" data-id="${p.id}">
          <div class="pcard-top"><span class="pcard-num">#${p.numero}</span>
          ${ativo ? `<span class="pcard-tempo ${classeTempo(min)}">${min} min</span>` : `<span class="pcard-tempo">${STATUS_ROTULO[p.status]}</span>`}</div>
          <div class="pcard-cliente">${esc(p.cliente_nome || 'Cliente')}</div>
          <div class="pcard-itens">${esc(resumoItens(p))}</div>
          <div class="pcard-bottom"><span class="pcard-total">${fmtBRL(p.total_centavos)}</span><span class="selos">${selosPedido(p)}</span></div>
        </article>`;
      }).join('') || '<div class="dica" style="text-align:center;padding:.6rem">—</div>') + '</div>';
  }).join('');
  $$('#board .pcard').forEach(c => c.addEventListener('click', () => abrirDetalhe(c.dataset.id)));
  $('#pedidosVazio').classList.toggle('hidden', state.pedidos.length > 0);
  $('#pedidosInfo').textContent = state.pedidos.length ? `${state.pedidos.length} pedido(s) hoje` : '';
}
$('#filtroAguardando').addEventListener('change', renderBoard);
$('#btnAtualizarPedidos').addEventListener('click', () => carregarPedidos());
setInterval(() => { if (state.view === 'pedidos' && state.pedidos.length) renderBoard(); }, 30000);

/* ---------- Detalhe do pedido ---------- */
const TRANSICOES = {
  NOVO: [ { para:'EM_PREPARO', rotulo:'✅ Confirmar pedido', cls:'btn-ok' }, { para:'CANCELADO', rotulo:'❌ Cancelar', cls:'btn-danger', motivo:true } ],
  EM_PREPARO: [ { para:'PRONTO', rotulo:'✅ Marcar pronto', cls:'btn-ok' }, { para:'CANCELADO', rotulo:'❌ Cancelar', cls:'btn-danger', motivo:true } ],
  PRONTO: [], // montado conforme o tipo (entrega/retirada)
  SAIU_ENTREGA: [ { para:'ENTREGUE', rotulo:'🏁 Marcar entregue', cls:'btn-ok' } ],
  ENTREGUE: [], CANCELADO: [],
};
function transicoesDo(p) {
  if (p.status === 'PRONTO') {
    const arr = [];
    if (p.tipo === 'entrega') arr.push({ para:'SAIU_ENTREGA', rotulo:'🛵 Saiu para entrega', cls:'btn-primary' });
    arr.push({ para:'ENTREGUE', rotulo:'🏁 Marcar entregue', cls:'btn-ok' });
    return arr;
  }
  return TRANSICOES[p.status] || [];
}
function enderecoTexto(p) {
  const e = p.endereco;
  if (!e) return p.endereco_texto || '';
  if (typeof e === 'string') { try { return enderecoTexto({ endereco: JSON.parse(e) }); } catch { return e; } }
  return [e.rua && `${e.rua}${e.numero ? ', ' + e.numero : ''}`, e.complemento, p.bairro || e.bairro].filter(Boolean).join(' — ');
}
async function abrirDetalhe(id, silencioso = false) {
  try {
    const p = await api('/api/painel/pedidos/' + id);
    state.detalheId = id;
    $('#drawerTitulo').textContent = `Pedido #${p.numero} — ${STATUS_ROTULO[p.status] || p.status}`;
    const itens = (p.itens || []).map(it => `
      <div class="det-item">
        <div class="det-item-top"><span>${it.quantidade || 1}x ${esc(nomeItem(it))}</span><span>${fmtBRL(it.subtotal_centavos ?? ((it.preco_unitario_centavos || 0) * (it.quantidade || 1)))}</span></div>
        ${(it.opcoes && it.opcoes.length) ? `<div class="det-opcoes">${it.opcoes.map(op => `• ${grupoOpcao(op) ? esc(grupoOpcao(op)) + ': ' : ''}${esc(nomeOpcao(op))}${op.preco_adicional_centavos ? ' (+' + fmtBRL(op.preco_adicional_centavos) + ')' : ''}`).join('<br>')}</div>` : ''}
        ${it.observacao ? `<div class="det-obs">⚠️ OBS: ${esc(it.observacao)}</div>` : ''}
      </div>`).join('');
    const end = enderecoTexto(p);
    const ref = (p.endereco && typeof p.endereco === 'object' && p.endereco.referencia) || p.referencia || '';
    const troco = (p.forma_pagamento === 'dinheiro' && p.troco_para_centavos && Number(p.troco_para_centavos) > Number(p.total_centavos))
      ? `<div class="troco-box">💵 Troco: ${fmtBRL(Number(p.troco_para_centavos) - Number(p.total_centavos))} (cliente deu ${fmtBRL(p.troco_para_centavos)})</div>` : '';
    const hist = (p.historico || []).map(h => `
      <div class="hist-item"><span>${esc(STATUS_ROTULO[h.de_status] || h.de_status || '—')} → <strong>${esc(STATUS_ROTULO[h.para_status] || h.para_status || '')}</strong>${h.motivo ? ' (' + esc(h.motivo) + ')' : ''}${h.origem ? ' · ' + esc(h.origem) : ''}</span><span>${(h.created_at || h.criado_em) && dataServidor(h.created_at || h.criado_em) ? dataServidor(h.created_at || h.criado_em).toLocaleTimeString('pt-BR') : ''}</span></div>`).join('');
    const notifs = (p.notificacoes || []).map(n => `
      <div class="notif-item"><span>${esc(n.template || n.tipo || 'mensagem')} → ${esc(n.destino || '')}</span><span class="notif-status">${esc(n.status || '')}${n.erro ? ' (' + esc(n.erro) + ')' : ''}</span></div>`).join('');
    const tel = String(p.cliente_whatsapp || '').replace(/\D/g, '');
    const acoes = transicoesDo(p).map((t, i) => `<button class="btn ${t.cls}" data-trans="${i}">${t.rotulo}</button>`).join('');
    $('#drawerBody').innerHTML = `
      <div class="det-secao"><span class="selos">${selosPedido(p)}</span>
        <span class="dica" style="margin-left:.4rem">${(dataServidor(p.created_at || p.criado_em) || new Date()).toLocaleString('pt-BR')}</span></div>
      <div class="det-secao"><h5>Itens</h5>${itens || '<p class="dica">Sem itens.</p>'}
        ${p.observacao ? `<div class="det-obs">⚠️ OBS do pedido: ${esc(p.observacao)}</div>` : ''}</div>
      <div class="det-secao"><h5>Cliente</h5>
        <p><strong>${esc(p.cliente_nome || '')}</strong> — ${esc(p.cliente_whatsapp || '')}
        ${tel ? `<a class="wa-link" target="_blank" rel="noopener" href="https://wa.me/${tel}">💬 Chamar no WhatsApp</a>` : ''}</p>
        ${p.tipo === 'entrega' ? `<p>📍 ${esc(end)}${ref ? `<br>Referência: <strong>${esc(ref)}</strong>` : ''}${p.bairro ? `<br>Bairro: ${esc(p.bairro)}` : ''}</p>` : '<p>🏪 Retirada na loja</p>'}
      </div>
      <div class="det-secao"><h5>Pagamento</h5>
        <div class="det-totais">
          <div class="linha"><span>Subtotal</span><span>${fmtBRL(p.subtotal_centavos)}</span></div>
          <div class="linha"><span>Taxa de entrega</span><span>${fmtBRL(p.taxa_entrega_centavos)}</span></div>
          ${p.desconto_centavos ? `<div class="linha"><span>Desconto</span><span>− ${fmtBRL(p.desconto_centavos)}</span></div>` : ''}
          <div class="linha total"><span>Total (${esc(FORMA_ROTULO[p.forma_pagamento] || p.forma_pagamento || '')})</span><span>${fmtBRL(p.total_centavos)}</span></div>
        </div>
        ${p.pagamento_status && p.pagamento_status !== 'nao_aplicavel' ? `<p style="margin-top:.4rem">${seloPagamento(p)}</p>` : ''}
        ${troco}
      </div>
      <div class="det-acoes">${acoes}
        <button class="btn btn-ghost" id="btnImprimir">🖨️ Imprimir comanda</button>
      </div>
      ${hist ? `<div class="det-secao"><h5>Histórico</h5>${hist}</div>` : ''}
      ${notifs ? `<div class="det-secao"><h5>Notificações enviadas</h5>${notifs}</div>` : ''}`;
    $('#drawer').classList.remove('hidden');
    $('#drawerOverlay').classList.remove('hidden');
    $$('#drawerBody [data-trans]').forEach(btn => btn.addEventListener('click', () => {
      const t = transicoesDo(p)[Number(btn.dataset.trans)];
      if (t.motivo) pedirMotivoCancelamento(p); else fazerTransicao(p.id, t.para);
    }));
    $('#btnImprimir').addEventListener('click', () => imprimirComanda(p.id));
  } catch (err) { if (!silencioso) toast(err.message, true); }
}
function fecharDrawer() {
  state.detalheId = null;
  $('#drawer').classList.add('hidden');
  $('#drawerOverlay').classList.add('hidden');
}
$('#drawerFechar').addEventListener('click', fecharDrawer);
$('#drawerOverlay').addEventListener('click', fecharDrawer);

/* Som de dinheiro ao confirmar a entrega 💰 */
let audioDinheiro = null;
function tocarSomDinheiro() {
  try {
    if (!audioDinheiro) audioDinheiro = new Audio('/sons/money-soundfx.mp3');
    audioDinheiro.volume = 1;
    audioDinheiro.currentTime = 0;
    audioDinheiro.play().catch(() => { /* navegador libera após interação */ });
  } catch { /* sem áudio */ }
}
async function fazerTransicao(id, para, motivo) {
  try {
    await api(`/api/painel/pedidos/${id}/transicao`, { method: 'POST', body: { para_status: para, motivo: motivo || undefined } });
    if (para === 'ENTREGUE') tocarSomDinheiro();
    toast(`Pedido atualizado: ${STATUS_ROTULO[para]}.`);
    carregarPedidos(true);
    abrirDetalhe(id, true);
  } catch (err) { toast(err.message, true); }
}
function pedirMotivoCancelamento(p) {
  const body = openModal('Cancelar pedido #' + p.numero, `
    <form id="formCancelar">
      <label>Motivo do cancelamento (o cliente recebe este aviso)
        <select id="cancelMotivo" required>
          <option value="">Selecione...</option>
          <option>Item sem estoque</option>
          <option>Endereço fora da área de entrega</option>
          <option>Cliente não respondeu</option>
          <option>Pedido suspeito (trote)</option>
          <option>Outro</option>
        </select>
      </label>
      <label>Detalhe (opcional) <input type="text" id="cancelDetalhe" placeholder="Ex.: acabou o morango"></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="cancelVoltar">Voltar</button>
        <button type="submit" class="btn btn-danger">Confirmar cancelamento</button>
      </div>
    </form>`);
  $('#cancelVoltar', body).addEventListener('click', closeModal);
  $('#formCancelar', body).addEventListener('submit', (ev) => {
    ev.preventDefault();
    const motivo = [$('#cancelMotivo', body).value, $('#cancelDetalhe', body).value].filter(Boolean).join(' — ');
    closeModal();
    fazerTransicao(p.id, 'CANCELADO', motivo);
  });
}
async function imprimirComanda(id) {
  try {
    const data = await api(`/api/painel/pedidos/${id}/imprimir`, { method: 'POST', body: {} });
    const w = window.open('', '_blank', 'width=420,height=640');
    if (!w) { toast('Permita pop-ups para ver a comanda.', true); return; }
    w.document.write(`<!DOCTYPE html><html><head><title>Comanda</title><style>body{font-family:'Courier New',monospace;font-size:13px;padding:10px}pre{white-space:pre-wrap}@media print{button{display:none}}</style></head><body><button onclick="window.print()">🖨️ Imprimir</button><pre>${esc(data.comanda || '')}</pre></body></html>`);
    w.document.close();
    toast('Comanda gerada.');
  } catch (err) { toast(err.message, true); }
}

/* ================= CARDÁPIO ================= */
async function carregarCardapio() {
  try {
    const [cats, prods, grupos] = await Promise.all([
      api('/api/painel/categorias'), api('/api/painel/produtos'), api('/api/painel/grupos'),
    ]);
    state.categorias = Array.isArray(cats) ? cats : (cats.categorias || []);
    state.produtos = Array.isArray(prods) ? prods : (prods.produtos || []);
    state.grupos = Array.isArray(grupos) ? grupos : (grupos.grupos || []);
    renderCategorias(); renderProdutos();
  } catch (err) { toast(err.message, true); }
}
function nomeCategoria(id) {
  const c = state.categorias.find(x => String(x.id) === String(id));
  return c ? c.nome : '—';
}
function ativoDe(x) { return x.ativo === undefined ? true : !!x.ativo; }

function renderCategorias() {
  $('#categoriasList').innerHTML = state.categorias.map(c => `
    <span class="cat-chip ${ativoDe(c) ? '' : 'inativa'}">${esc(c.nome)}
      <button class="mini" data-cat-edit="${c.id}">Editar</button>
      <button class="mini" data-cat-del="${c.id}">${ativoDe(c) ? 'Inativar' : 'Reativar'}</button>
    </span>`).join('') || '<span class="dica">Nenhuma categoria ainda.</span>';
  $$('#categoriasList [data-cat-edit]').forEach(b => b.addEventListener('click', () => modalCategoria(state.categorias.find(c => String(c.id) === b.dataset.catEdit))));
  $$('#categoriasList [data-cat-del]').forEach(b => b.addEventListener('click', async () => {
    const c = state.categorias.find(x => String(x.id) === b.dataset.catDel);
    try {
      if (ativoDe(c)) { await api('/api/painel/categorias/' + c.id, { method: 'DELETE' }); toast('Categoria inativada.'); }
      else { await api('/api/painel/categorias/' + c.id, { method: 'PUT', body: { nome: c.nome, ordem: c.ordem, ativo: true } }); toast('Categoria reativada.'); }
      carregarCardapio();
    } catch (err) { toast(err.message, true); }
  }));
}
function modalCategoria(cat) {
  const edit = !!cat; cat = cat || { nome: '', ordem: 0, ativo: true };
  const body = openModal(edit ? 'Editar categoria' : 'Nova categoria', `
    <form id="formCat">
      <label>Nome <input type="text" id="catNome" value="${esc(cat.nome)}" required></label>
      <label>Ordem de exibição <input type="number" id="catOrdem" value="${cat.ordem || 0}"></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar</button></div>
    </form>`);
  $('#formCat', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = { nome: $('#catNome', body).value.trim(), ordem: Number($('#catOrdem', body).value) || 0, ativo: ativoDe(cat) };
    try {
      if (edit) await api('/api/painel/categorias/' + cat.id, { method: 'PUT', body: payload });
      else await api('/api/painel/categorias', { method: 'POST', body: payload });
      closeModal(); toast('Categoria salva.'); carregarCardapio();
    } catch (err) { toast(err.message, true); }
  });
}
$('#btnNovaCategoria').addEventListener('click', () => modalCategoria(null));

function renderProdutos() {
  const busca = ($('#buscaProduto').value || '').toLowerCase();
  const lista = state.produtos.filter(p => !busca || (p.nome || '').toLowerCase().includes(busca));
  $('#produtosList').innerHTML = lista.map(p => `
    <div class="prod-row ${ativoDe(p) ? '' : 'inativo'}">
      <img src="${esc(p.foto_url || '')}" alt="" onerror="this.style.visibility='hidden'">
      <div class="prod-info">
        <div class="prod-nome">${esc(p.nome)}</div>
        <div class="prod-meta">${esc(nomeCategoria(p.categoria_id))} · ${p.tipo === 'montavel' ? 'montável' : 'simples'}${ativoDe(p) ? '' : ' · INATIVO'}</div>
      </div>
      ${p.destaque ? '<span class="tag destaque">⭐ destaque</span>' : ''}
      ${p.tipo === 'montavel' ? '<span class="tag montavel">montável</span>' : ''}
      ${p.esgotado ? '<span class="tag esgotado">esgotado</span>' : ''}
      <span class="prod-preco">${fmtBRL(p.preco_base_centavos)}</span>
      <button class="btn btn-ghost btn-sm" data-prod-edit="${p.id}">Editar</button>
      <button class="btn btn-ghost btn-sm" data-prod-del="${p.id}">${ativoDe(p) ? 'Inativar' : 'Reativar'}</button>
    </div>`).join('') || '<p class="dica">Nenhum produto encontrado.</p>';
  $$('#produtosList [data-prod-edit]').forEach(b => b.addEventListener('click', () => modalProduto(state.produtos.find(p => String(p.id) === b.dataset.prodEdit))));
  $$('#produtosList [data-prod-del]').forEach(b => b.addEventListener('click', async () => {
    const p = state.produtos.find(x => String(x.id) === b.dataset.prodDel);
    try {
      if (ativoDe(p)) { await api('/api/painel/produtos/' + p.id, { method: 'DELETE' }); toast('Produto inativado (some da loja, histórico preservado).'); }
      else { await api('/api/painel/produtos/' + p.id, { method: 'PUT', body: { ...p, ativo: true } }); toast('Produto reativado.'); }
      carregarCardapio();
    } catch (err) { toast(err.message, true); }
  }));
}
$('#buscaProduto').addEventListener('input', renderProdutos);
$('#btnNovoProduto').addEventListener('click', () => modalProduto(null));

function modalProduto(prod) {
  const edit = !!prod;
  prod = prod || { nome:'', descricao:'', categoria_id: state.categorias[0]?.id || '', tipo:'simples', preco_base_centavos:0, foto_url:'', destaque:false, esgotado:false, ativo:true, ordem:0, grupo_ids: [] };
  const vinculados = new Set((prod.grupo_ids || (prod.grupos || []).map(g => g.id) || []).map(String));
  const body = openModal(edit ? 'Editar produto' : 'Novo produto', `
    <form id="formProd">
      <div class="foto-edit">
        <img id="prodFotoPreview" src="${esc(prod.foto_url || '')}" alt="" onerror="this.style.opacity=.3">
        <div>
          <label class="btn btn-ghost btn-sm" style="margin:0">📷 Enviar foto<input type="file" id="prodFotoFile" accept="image/*" hidden></label>
          <div class="dica" style="margin-top:.4rem">A foto aparece na página de pedidos.</div>
          <input type="hidden" id="prodFotoUrl" value="${esc(prod.foto_url || '')}">
        </div>
      </div>
      <label>Nome <input type="text" id="prodNome" value="${esc(prod.nome)}" required></label>
      <label>Descrição <textarea id="prodDesc" rows="2">${esc(prod.descricao || '')}</textarea></label>
      <div class="grid-2">
        <label>Categoria
          <select id="prodCategoria">${state.categorias.map(c => `<option value="${c.id}" ${String(c.id) === String(prod.categoria_id) ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select>
        </label>
        <label>Tipo
          <select id="prodTipo">
            <option value="simples" ${prod.tipo === 'simples' ? 'selected' : ''}>Simples (preço fechado)</option>
            <option value="montavel" ${prod.tipo === 'montavel' ? 'selected' : ''}>Montável (com grupos de opções)</option>
          </select>
        </label>
        <label>Preço base (R$) <input type="text" class="money" id="prodPreco" inputmode="numeric" placeholder="0,00"></label>
        <label>Ordem <input type="number" id="prodOrdem" value="${prod.ordem || 0}"></label>
      </div>
      <span style="font-size:.85rem;font-weight:600">Grupos de opções vinculados (produto montável)</span>
      <div class="grupos-checks">
        ${state.grupos.map(g => `<label class="chk"><input type="checkbox" class="prod-grupo" value="${g.id}" ${vinculados.has(String(g.id)) ? 'checked' : ''}> ${esc(g.nome)}</label>`).join('') || '<span class="dica">Nenhum grupo criado ainda — crie em "Grupos e Opções".</span>'}
      </div>
      <div class="form-row" style="display:flex;gap:1.2rem;flex-wrap:wrap">
        <label class="chk"><input type="checkbox" id="prodAtivo" ${ativoDe(prod) ? 'checked' : ''}> Ativo (visível na loja)</label>
        <label class="chk"><input type="checkbox" id="prodEsgotado" ${prod.esgotado ? 'checked' : ''}> Esgotado</label>
        <label class="chk"><input type="checkbox" id="prodDestaque" ${prod.destaque ? 'checked' : ''}> Destaque ⭐</label>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar produto</button></div>
    </form>`);
  setMoney($('#prodPreco', body), prod.preco_base_centavos || 0);
  $('#prodFotoFile', body).addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    const local = URL.createObjectURL(f);
    $('#prodFotoPreview', body).src = local; $('#prodFotoPreview', body).style.opacity = 1;
    try {
      const url = await uploadArquivo(f);
      $('#prodFotoUrl', body).value = url;
      $('#prodFotoPreview', body).src = url;
      toast('Foto enviada.');
    } catch (err) { toast('Falha no upload: ' + err.message, true); }
  });
  $('#formProd', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = {
      nome: $('#prodNome', body).value.trim(),
      descricao: $('#prodDesc', body).value.trim(),
      categoria_id: $('#prodCategoria', body).value ? Number($('#prodCategoria', body).value) : null,
      tipo: $('#prodTipo', body).value,
      preco_base_centavos: getMoney($('#prodPreco', body)) || 0,
      foto_url: $('#prodFotoUrl', body).value || null,
      ordem: Number($('#prodOrdem', body).value) || 0,
      ativo: $('#prodAtivo', body).checked,
      esgotado: $('#prodEsgotado', body).checked,
      destaque: $('#prodDestaque', body).checked,
      grupo_ids: $$('.prod-grupo', body).filter(x => x.checked).map(x => Number(x.value)),
    };
    try {
      if (edit) await api('/api/painel/produtos/' + prod.id, { method: 'PUT', body: payload });
      else await api('/api/painel/produtos', { method: 'POST', body: payload });
      closeModal(); toast('Produto salvo.'); carregarCardapio();
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= GRUPOS E OPÇÕES ================= */
async function carregarGrupos() {
  try {
    const [grupos, opcoes] = await Promise.all([api('/api/painel/grupos'), api('/api/painel/opcoes')]);
    state.grupos = Array.isArray(grupos) ? grupos : (grupos.grupos || []);
    const ops = Array.isArray(opcoes) ? opcoes : (opcoes.opcoes || []);
    state.opcoesPorGrupo = {};
    ops.forEach(o => { (state.opcoesPorGrupo[o.grupo_id] = state.opcoesPorGrupo[o.grupo_id] || []).push(o); });
    state.grupos.forEach(g => { if (g.opcoes && !state.opcoesPorGrupo[g.id]) state.opcoesPorGrupo[g.id] = g.opcoes; });
    renderGrupos();
  } catch (err) { toast(err.message, true); }
}
function renderGrupos() {
  $('#gruposList').innerHTML = state.grupos.map(g => {
    const ops = (state.opcoesPorGrupo[g.id] || []).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    return `<div class="grupo-card">
      <div class="grupo-head">
        <div>
          <div class="grupo-nome">${esc(g.nome)} ${ativoDe(g) ? '' : '<span class="tag esgotado">inativo</span>'}</div>
          <div class="grupo-meta">${g.tipo_escolha === 'unica' ? 'Escolha única' : 'Múltipla'} · mín ${g.minimo || 0}${g.maximo ? ' · máx ' + g.maximo : ' · sem limite'} · ${g.obrigatorio ? 'obrigatório' : 'opcional'}${g.excedente_vira_pago ? ` · excedente pago (${fmtBRL(g.preco_excedente_centavos)} cada)` : ''} · ordem ${g.ordem || 0}</div>
        </div>
        <div style="display:flex;gap:.4rem">
          <button class="btn btn-ghost btn-sm" data-grupo-edit="${g.id}">Editar grupo</button>
          <button class="btn btn-ghost btn-sm" data-grupo-del="${g.id}">${ativoDe(g) ? 'Inativar' : 'Reativar'}</button>
        </div>
      </div>
      <table class="opcoes-table">
        <thead><tr><th>Opção</th><th>Preço adicional</th><th>Ordem</th><th>Ativa</th><th>Esgotada</th><th></th></tr></thead>
        <tbody>
        ${ops.map(o => `<tr class="${(o.ativa === undefined ? true : !!o.ativa) ? '' : 'inativa'}">
          <td>${esc(o.nome)}</td>
          <td>${Number(o.preco_adicional_centavos) ? '+ ' + fmtBRL(o.preco_adicional_centavos) : 'incluso'}</td>
          <td>${o.ordem || 0}</td>
          <td><input type="checkbox" data-op-ativa="${o.id}" ${(o.ativa === undefined ? true : !!o.ativa) ? 'checked' : ''}></td>
          <td><input type="checkbox" data-op-esgotada="${o.id}" ${o.esgotada ? 'checked' : ''}></td>
          <td style="white-space:nowrap">
            <button class="btn btn-ghost btn-sm" data-op-edit="${o.id}">Editar</button>
            <button class="btn btn-ghost btn-sm" data-op-del="${o.id}">Inativar</button>
          </td></tr>`).join('') || '<tr><td colspan="6" class="dica">Nenhuma opção neste grupo ainda.</td></tr>'}
        </tbody>
      </table>
      <form class="add-opcao" data-add-opcao="${g.id}">
        <input type="text" name="nome" placeholder="Nova opção (ex.: Nutella)" required>
        <input type="text" name="preco" class="money" placeholder="Preço extra R$">
        <input type="number" name="ordem" placeholder="Ordem" value="0">
        <button class="btn btn-primary btn-sm" type="submit">+ Adicionar</button>
      </form>
    </div>`;
  }).join('') || '<p class="dica">Nenhum grupo criado ainda.</p>';
  $$('#gruposList .money').forEach(wireMoney);
  $$('#gruposList [data-grupo-edit]').forEach(b => b.addEventListener('click', () => modalGrupo(state.grupos.find(g => String(g.id) === b.dataset.grupoEdit))));
  $$('#gruposList [data-grupo-del]').forEach(b => b.addEventListener('click', async () => {
    const g = state.grupos.find(x => String(x.id) === b.dataset.grupoDel);
    try {
      if (ativoDe(g)) { await api('/api/painel/grupos/' + g.id, { method: 'DELETE' }); toast('Grupo inativado.'); }
      else { await api('/api/painel/grupos/' + g.id, { method: 'PUT', body: { ...g, ativo: true } }); toast('Grupo reativado.'); }
      carregarGrupos();
    } catch (err) { toast(err.message, true); }
  }));
  const todasOpcoes = () => Object.values(state.opcoesPorGrupo).flat();
  $$('#gruposList [data-op-edit]').forEach(b => b.addEventListener('click', () => modalOpcao(todasOpcoes().find(o => String(o.id) === b.dataset.opEdit))));
  $$('#gruposList [data-op-del]').forEach(b => b.addEventListener('click', async () => {
    try { await api('/api/painel/opcoes/' + b.dataset.opDel, { method: 'DELETE' }); toast('Opção inativada.'); carregarGrupos(); }
    catch (err) { toast(err.message, true); }
  }));
  $$('#gruposList [data-op-ativa]').forEach(chk => chk.addEventListener('change', async () => {
    const o = todasOpcoes().find(x => String(x.id) === chk.dataset.opAtiva);
    try { await api('/api/painel/opcoes/' + o.id, { method: 'PUT', body: { ...o, ativa: chk.checked } }); toast('Opção atualizada.'); }
    catch (err) { toast(err.message, true); chk.checked = !chk.checked; }
  }));
  $$('#gruposList [data-op-esgotada]').forEach(chk => chk.addEventListener('change', async () => {
    const o = todasOpcoes().find(x => String(x.id) === chk.dataset.opEsgotada);
    try { await api('/api/painel/opcoes/' + o.id, { method: 'PUT', body: { ...o, esgotada: chk.checked } }); toast(chk.checked ? 'Opção marcada como esgotada.' : 'Opção disponível de novo.'); carregarGrupos(); }
    catch (err) { toast(err.message, true); chk.checked = !chk.checked; }
  }));
  $$('#gruposList [data-add-opcao]').forEach(f => f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const gid = f.dataset.addOpcao;
    const precoInput = $('input[name="preco"]', f);
    try {
      await api('/api/painel/opcoes', { method: 'POST', body: {
        grupo_id: Number(gid), nome: $('input[name="nome"]', f).value.trim(),
        preco_adicional_centavos: getMoney(precoInput) || 0,
        ativa: true, esgotada: false, ordem: Number($('input[name="ordem"]', f).value) || 0,
      } });
      toast('Opção adicionada.'); carregarGrupos();
    } catch (err) { toast(err.message, true); }
  }));
}
function modalGrupo(g) {
  const edit = !!g;
  g = g || { nome:'', tipo_escolha:'multipla', minimo:0, maximo:null, obrigatorio:false, excedente_vira_pago:false, preco_excedente_centavos:0, ativo:true, ordem:0 };
  const body = openModal(edit ? 'Editar grupo' : 'Novo grupo', `
    <form id="formGrupo">
      <label>Nome do grupo <input type="text" id="grNome" value="${esc(g.nome)}" placeholder="Ex.: Tamanho, Acompanhamentos, Calda" required></label>
      <div class="grid-2">
        <label>Tipo de escolha
          <select id="grTipo">
            <option value="unica" ${g.tipo_escolha === 'unica' ? 'selected' : ''}>Única (radio)</option>
            <option value="multipla" ${g.tipo_escolha !== 'unica' ? 'selected' : ''}>Múltipla (checkbox)</option>
          </select>
        </label>
        <label>Ordem <input type="number" id="grOrdem" value="${g.ordem || 0}"></label>
        <label>Mínimo de escolhas <input type="number" id="grMin" min="0" value="${g.minimo || 0}"></label>
        <label>Máximo de escolhas <input type="number" id="grMax" min="0" value="${g.maximo ?? ''}" placeholder="Vazio = sem limite"></label>
      </div>
      <label>Preço do excedente (R$) <input type="text" class="money" id="grPrecoExc" inputmode="numeric" placeholder="0,00"></label>
      <div class="form-row" style="display:flex;gap:1.2rem;flex-wrap:wrap">
        <label class="chk"><input type="checkbox" id="grObrig" ${g.obrigatorio ? 'checked' : ''}> Obrigatório</label>
        <label class="chk"><input type="checkbox" id="grExcPago" ${g.excedente_vira_pago ? 'checked' : ''}> Excedente vira pago</label>
        <label class="chk"><input type="checkbox" id="grAtivo" ${ativoDe(g) ? 'checked' : ''}> Ativo</label>
      </div>
      <p class="dica">Ex.: "Acompanhamentos inclusos (até 3)": múltipla, máx 3, excedente pago desligado (trava em 3) — ou ligado com preço se quiser cobrar cada extra.</p>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar grupo</button></div>
    </form>`);
  setMoney($('#grPrecoExc', body), g.preco_excedente_centavos || 0);
  $('#formGrupo', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const maxVal = $('#grMax', body).value;
    const payload = {
      nome: $('#grNome', body).value.trim(),
      tipo_escolha: $('#grTipo', body).value,
      minimo: Number($('#grMin', body).value) || 0,
      maximo: maxVal === '' ? null : Number(maxVal),
      obrigatorio: $('#grObrig', body).checked,
      excedente_vira_pago: $('#grExcPago', body).checked,
      preco_excedente_centavos: getMoney($('#grPrecoExc', body)) || 0,
      ativo: $('#grAtivo', body).checked,
      ordem: Number($('#grOrdem', body).value) || 0,
    };
    try {
      if (edit) await api('/api/painel/grupos/' + g.id, { method: 'PUT', body: payload });
      else await api('/api/painel/grupos', { method: 'POST', body: payload });
      closeModal(); toast('Grupo salvo.'); carregarGrupos();
    } catch (err) { toast(err.message, true); }
  });
}
$('#btnNovoGrupo').addEventListener('click', () => modalGrupo(null));

function modalOpcao(o) {
  if (!o) return;
  const body = openModal('Editar opção', `
    <form id="formOpcao">
      <label>Nome <input type="text" id="opNome" value="${esc(o.nome)}" required></label>
      <div class="grid-2">
        <label>Preço adicional (R$) <input type="text" class="money" id="opPreco" inputmode="numeric"></label>
        <label>Ordem <input type="number" id="opOrdem" value="${o.ordem || 0}"></label>
      </div>
      <div class="form-row" style="display:flex;gap:1.2rem">
        <label class="chk"><input type="checkbox" id="opAtiva" ${(o.ativa === undefined ? true : !!o.ativa) ? 'checked' : ''}> Ativa</label>
        <label class="chk"><input type="checkbox" id="opEsgotada" ${o.esgotada ? 'checked' : ''}> Esgotada</label>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar opção</button></div>
    </form>`);
  setMoney($('#opPreco', body), o.preco_adicional_centavos || 0);
  $('#formOpcao', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/painel/opcoes/' + o.id, { method: 'PUT', body: {
        grupo_id: o.grupo_id, nome: $('#opNome', body).value.trim(),
        preco_adicional_centavos: getMoney($('#opPreco', body)) || 0,
        ordem: Number($('#opOrdem', body).value) || 0,
        ativa: $('#opAtiva', body).checked, esgotada: $('#opEsgotada', body).checked,
      } });
      closeModal(); toast('Opção salva.'); carregarGrupos();
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= BAIRROS ================= */
async function carregarBairros() {
  try {
    const data = await api('/api/painel/bairros');
    state.bairros = Array.isArray(data) ? data : (data.bairros || []);
    $('#bairrosList').innerHTML = `
      <table class="simple-table"><thead><tr><th>Bairro</th><th>Taxa de entrega</th><th>Ativo</th><th></th></tr></thead>
      <tbody>${state.bairros.map(b => `<tr>
        <td>${esc(b.bairro)}</td><td>${fmtBRL(b.taxa_centavos)}</td>
        <td>${ativoDe(b) ? '✅ Sim' : '🚫 Não'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost btn-sm" data-bairro-edit="${b.id}">Editar</button>
          <button class="btn btn-ghost btn-sm" data-bairro-del="${b.id}">${ativoDe(b) ? 'Inativar' : 'Reativar'}</button>
        </td></tr>`).join('') || '<tr><td colspan="4" class="dica">Nenhum bairro cadastrado.</td></tr>'}</tbody></table>`;
    $$('#bairrosList [data-bairro-edit]').forEach(x => x.addEventListener('click', () => modalBairro(state.bairros.find(b => String(b.id) === x.dataset.bairroEdit))));
    $$('#bairrosList [data-bairro-del]').forEach(x => x.addEventListener('click', async () => {
      const b = state.bairros.find(y => String(y.id) === x.dataset.bairroDel);
      try {
        if (ativoDe(b)) { await api('/api/painel/bairros/' + b.id, { method: 'DELETE' }); toast('Bairro inativado.'); }
        else { await api('/api/painel/bairros/' + b.id, { method: 'PUT', body: { bairro: b.bairro, taxa_centavos: b.taxa_centavos, ativo: true } }); toast('Bairro reativado.'); }
        carregarBairros();
      } catch (err) { toast(err.message, true); }
    }));
  } catch (err) { toast(err.message, true); }
}
function modalBairro(b) {
  const edit = !!b; b = b || { bairro: '', taxa_centavos: 0, ativo: true };
  const body = openModal(edit ? 'Editar bairro' : 'Novo bairro', `
    <form id="formBairro">
      <label>Bairro <input type="text" id="bNome" value="${esc(b.bairro)}" required></label>
      <label>Taxa de entrega (R$) <input type="text" class="money" id="bTaxa" inputmode="numeric"></label>
      <label class="chk"><input type="checkbox" id="bAtivo" ${ativoDe(b) ? 'checked' : ''}> Ativo (aparece no checkout)</label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Salvar</button></div>
    </form>`);
  setMoney($('#bTaxa', body), b.taxa_centavos || 0);
  $('#formBairro', body).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = { bairro: $('#bNome', body).value.trim(), taxa_centavos: getMoney($('#bTaxa', body)) || 0, ativo: $('#bAtivo', body).checked };
    try {
      if (edit) await api('/api/painel/bairros/' + b.id, { method: 'PUT', body: payload });
      else await api('/api/painel/bairros', { method: 'POST', body: payload });
      closeModal(); toast('Bairro salvo.'); carregarBairros();
    } catch (err) { toast(err.message, true); }
  });
}
$('#btnNovoBairro').addEventListener('click', () => modalBairro(null));

/* ================= MEIOS DE RECEBIMENTO ================= */
function normalizarRecebimentos(data) {
  const map = {};
  const arr = Array.isArray(data) ? data : (data && (data.recebimentos || data.meios)) || [];
  if (Array.isArray(arr)) arr.forEach(c => { if (c && c.meio) map[c.meio] = c; });
  else if (data && typeof data === 'object') Object.entries(data).forEach(([k, v]) => { if (v && typeof v === 'object') map[k] = v; });
  return map;
}
function credDe(cfg, campo) {
  if (!cfg) return '';
  const c = cfg.credenciais || cfg.credenciais_json || {};
  const v = typeof c === 'string' ? (() => { try { return JSON.parse(c)[campo] || ''; } catch { return ''; } })() : (c[campo] || '');
  return v || cfg[campo] || '';
}
function extraDe(cfg, campo) {
  if (!cfg) return undefined;
  const e = cfg.extra || cfg.extra_json || {};
  const obj = typeof e === 'string' ? (() => { try { return JSON.parse(e); } catch { return {}; } })() : e;
  return obj[campo];
}
function prepararCampoSegredo(input, mascaraAtual) {
  input.value = '';
  input.placeholder = mascaraAtual ? `Atual: ${mascaraAtual} — deixe vazio para manter` : 'Cole a credencial aqui';
  input.dataset.mascara = mascaraAtual || '';
}
async function carregarRecebimentos() {
  // URLs públicas dos webhooks (origem atual + caminho do contrato)
  $('#mpWebhookUrl').value = location.origin + '/api/webhooks/mercadopago';
  $('#asaasWebhookUrl').value = location.origin + '/api/webhooks/asaas';
  try {
    const data = await api('/api/painel/recebimentos');
    state.recebimentos = normalizarRecebimentos(data);
    const R = state.recebimentos;
    // Presencial
    const pix = R['pix_presencial'] || {};
    $('#pixPresAtivo').checked = !!pix.ativo;
    $('#pixPresChave').value = extraDe(pix, 'chave_pix') || pix.chave_pix || state.loja?.chave_pix || '';
    const cart = R['cartao_presencial'] || {};
    $('#cartaoPresAtivo').checked = !!cart.ativo;
    const din = R['dinheiro'] || {};
    $('#dinheiroAtivo').checked = !!din.ativo;
    $('#dinheiroTroco').checked = extraDe(din, 'aceita_troco') !== false;
    // Mercado Pago
    const mp = R['mercadopago'] || {};
    $('#mpAtivo').checked = !!mp.ativo;
    $('#mpAmbiente').value = mp.ambiente || 'sandbox';
    prepararCampoSegredo($('#mpAccessToken'), credDe(mp, 'access_token'));
    prepararCampoSegredo($('#mpPublicKey'), credDe(mp, 'public_key'));
    prepararCampoSegredo($('#mpWebhookSecret'), credDe(mp, 'webhook_secret'));
    // Asaas
    const as = R['asaas'] || {};
    $('#asaasAtivo').checked = !!as.ativo;
    $('#asaasAmbiente').value = as.ambiente || 'sandbox';
    prepararCampoSegredo($('#asaasApiKey'), credDe(as, 'api_key'));
    prepararCampoSegredo($('#asaasWebhookToken'), credDe(as, 'webhook_token'));
  } catch (err) { toast('Recebimentos: ' + err.message, true); }
}
async function salvarRecebimento(meio, payload) {
  await api('/api/painel/recebimentos/' + meio, { method: 'PATCH', body: payload });
  toast('Meio de recebimento salvo.');
  carregarRecebimentos();
}
$('#formPixPresencial').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await salvarRecebimento('pix_presencial', { ativo: $('#pixPresAtivo').checked, extra: { chave_pix: $('#pixPresChave').value.trim() } }); }
  catch (err) { toast(err.message, true); }
});
$('#formCartaoPresencial').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await salvarRecebimento('cartao_presencial', { ativo: $('#cartaoPresAtivo').checked }); }
  catch (err) { toast(err.message, true); }
});
$('#formDinheiro').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await salvarRecebimento('dinheiro', { ativo: $('#dinheiroAtivo').checked, extra: { aceita_troco: $('#dinheiroTroco').checked } }); }
  catch (err) { toast(err.message, true); }
});
$('#formMP').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cred = {};
  if ($('#mpAccessToken').value.trim()) cred.access_token = $('#mpAccessToken').value.trim();
  if ($('#mpPublicKey').value.trim()) cred.public_key = $('#mpPublicKey').value.trim();
  if ($('#mpWebhookSecret').value.trim()) cred.webhook_secret = $('#mpWebhookSecret').value.trim();
  try { await salvarRecebimento('mercadopago', { ativo: $('#mpAtivo').checked, ambiente: $('#mpAmbiente').value, credenciais: cred }); }
  catch (err) { toast(err.message, true); }
});
$('#formAsaas').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cred = {};
  if ($('#asaasApiKey').value.trim()) cred.api_key = $('#asaasApiKey').value.trim();
  if ($('#asaasWebhookToken').value.trim()) cred.webhook_token = $('#asaasWebhookToken').value.trim();
  try { await salvarRecebimento('asaas', { ativo: $('#asaasAtivo').checked, ambiente: $('#asaasAmbiente').value, credenciais: cred }); }
  catch (err) { toast(err.message, true); }
});
$$('[data-copy]').forEach(b => b.addEventListener('click', async () => {
  const input = document.getElementById(b.dataset.copy);
  try { await navigator.clipboard.writeText(input.value); toast('URL do webhook copiada.'); }
  catch { input.select(); document.execCommand('copy'); toast('URL do webhook copiada.'); }
}));
async function testarProvedor(meio, resultEl) {
  resultEl.textContent = 'Testando...'; resultEl.className = 'teste-result';
  try {
    const data = await api(`/api/painel/recebimentos/${meio}/testar`, { method: 'POST', body: {} });
    const ok = data.ok !== false && data.sucesso !== false;
    resultEl.textContent = ok ? '✅ ' + (data.mensagem || 'Conexão OK') : '❌ ' + (data.mensagem || data.erro || 'Falhou');
    resultEl.classList.add(ok ? 'ok' : 'erro');
  } catch (err) {
    resultEl.textContent = '❌ ' + err.message;
    resultEl.classList.add('erro');
  }
}
$('#btnTestarMP').addEventListener('click', () => testarProvedor('mercadopago', $('#mpTesteResult')));
$('#btnTestarAsaas').addEventListener('click', () => testarProvedor('asaas', $('#asaasTesteResult')));

/* ================= LOJA E APARÊNCIA ================= */
function preencherLoja() {
  const l = state.loja;
  if (!l) { carregarLoja().then(preencherLoja); return; }
  $('#lojaNome').value = l.nome || '';
  $('#lojaWhatsapp').value = l.whatsapp || '';
  $('#lojaInstagram').value = l.instagram || '';
  $('#lojaEndereco').value = l.endereco_texto || '';
  $('#lojaTempoPreparo').value = l.tempo_preparo_min ?? '';
  $('#lojaTempoEntrega').value = l.tempo_entrega_min ?? '';
  setMoney($('#lojaPedidoMinimo'), l.pedido_minimo_centavos || 0);
  setMoney($('#lojaTaxaUnica'), l.taxa_unica_centavos);
  $('#lojaChavePix').value = l.chave_pix || '';
  $('#lojaAbre').value = l.horario_abre || '';
  $('#lojaFecha').value = l.horario_fecha || '';
  $('#lojaAbertaManual').checked = !!l.aberta_manual;
  $('#lojaSom').value = l.som_pedido || 'padrao';
  $('#lojaLogoUrl').value = l.logo_url || '';
  $('#lojaCapaUrl').value = l.capa_url || '';
  const lp = $('#logoPreview'); lp.src = l.logo_url || ''; lp.style.opacity = l.logo_url ? 1 : .3;
  const cp = $('#capaPreview'); cp.src = l.capa_url || ''; cp.style.opacity = l.capa_url ? 1 : .3;
}
async function uploadLojaImagem(file, hiddenId, previewId) {
  const preview = $(previewId);
  preview.src = URL.createObjectURL(file); preview.style.opacity = 1;
  try {
    const url = await uploadArquivo(file);
    $(hiddenId).value = url; preview.src = url;
    toast('Imagem enviada. Clique em "Salvar loja" para aplicar.');
  } catch (err) { toast('Falha no upload: ' + err.message, true); }
}
$('#btnTestarSom').addEventListener('click', () => { pararSom(); tocarToque($('#lojaSom').value, false); });
$('#fileLogo').addEventListener('change', (e) => { if (e.target.files[0]) uploadLojaImagem(e.target.files[0], '#lojaLogoUrl', '#logoPreview'); });
$('#fileCapa').addEventListener('change', (e) => { if (e.target.files[0]) uploadLojaImagem(e.target.files[0], '#lojaCapaUrl', '#capaPreview'); });
$('#formLoja').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    nome: $('#lojaNome').value.trim(),
    whatsapp: $('#lojaWhatsapp').value.replace(/\D/g, ''),
    instagram: $('#lojaInstagram').value.trim(),
    endereco_texto: $('#lojaEndereco').value.trim(),
    tempo_preparo_min: Number($('#lojaTempoPreparo').value) || 0,
    tempo_entrega_min: Number($('#lojaTempoEntrega').value) || 0,
    pedido_minimo_centavos: getMoney($('#lojaPedidoMinimo')) || 0,
    taxa_unica_centavos: getMoney($('#lojaTaxaUnica')),
    chave_pix: $('#lojaChavePix').value.trim(),
    horario_abre: $('#lojaAbre').value || null,
    horario_fecha: $('#lojaFecha').value || null,
    aberta_manual: $('#lojaAbertaManual').checked,
    som_pedido: $('#lojaSom').value,
    logo_url: $('#lojaLogoUrl').value || null,
    capa_url: $('#lojaCapaUrl').value || null,
  };
  try {
    await api('/api/painel/loja', { method: 'PATCH', body: payload });
    toast('Loja salva.');
    carregarLoja();
  } catch (err) { toast(err.message, true); }
});

/* ================= RELATÓRIO ================= */
function hojeLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDataBR(iso) {
  if (!iso) return '';
  const [a, m, d] = String(iso).split('-');
  return (d && m && a) ? `${d}/${m}/${a}` : iso;
}
function comoLista(data, chave) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[chave])) return data[chave];
  if (data && Array.isArray(data.itens)) return data.itens;
  return [];
}
async function carregarRelatorio() {
  if (!state.relData) state.relData = hojeLocal();
  const inp = $('#relData');
  if (inp && inp.value !== state.relData) inp.value = state.relData;
  try {
    const r = await api('/api/painel/relatorio?data=' + encodeURIComponent(state.relData));
    $('#relCards').innerHTML = `
      <div class="rel-card fin-vendas"><div class="num">${r.pedidos_concluidos ?? 0}</div><div class="rot">Pedidos concluídos</div></div>
      <div class="rel-card fin-despesas"><div class="num">${r.cancelados ?? 0}</div><div class="rot">Cancelados</div></div>
      <div class="rel-card fin-receitas"><div class="num">${fmtBRL(r.faturamento_centavos)}</div><div class="rot">Faturamento do dia</div></div>
      <div class="rel-card fin-insumos"><div class="num">${fmtBRL(r.ticket_medio_centavos)}</div><div class="rot">Ticket médio</div></div>`;
    const lista = (arr, vazio) => (arr && arr.length)
      ? arr.map(x => `<div class="rel-linha"><span>${esc(x.nome)}</span><strong>${x.qtd ?? x.quantidade ?? ''}</strong></div>`).join('')
      : `<p class="dica">${vazio}</p>`;
    $('#relTopProdutos').innerHTML = lista(r.top_produtos, 'Nenhuma venda concluída neste dia.');
    $('#relTopOpcoes').innerHTML = lista(r.top_opcoes, 'Nenhuma opção registrada neste dia.');
    const pp = r.por_pagamento || {};
    $('#relPorPagamento').innerHTML = Object.keys(pp).length
      ? Object.entries(pp).map(([k, v]) => `<div class="rel-linha"><span>${esc(FORMA_ROTULO[k] || k)}</span><strong>${typeof v === 'number' && v > 500 ? fmtBRL(v) : esc(v)}</strong></div>`).join('')
      : '<p class="dica">Sem pagamentos registrados neste dia.</p>';
  } catch (err) { toast(err.message, true); }
}
$('#relData').addEventListener('change', (e) => {
  state.relData = e.target.value || hojeLocal();
  carregarRelatorio();
});
$('#btnRelPdf').addEventListener('click', async () => {
  const data = state.relData || hojeLocal();
  const btn = $('#btnRelPdf');
  btn.disabled = true;
  try {
    const res = await fetch('/api/painel/relatorio/pdf?data=' + encodeURIComponent(data), {
      headers: state.token ? { 'Authorization': 'Bearer ' + state.token } : {},
    });
    if (res.status === 401) { sair(false); throw new Error('Sessão expirada. Entre de novo.'); }
    if (!res.ok) throw new Error('Não foi possível gerar o PDF (erro ' + res.status + ').');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'relatorio-' + data + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('PDF do relatório de ' + fmtDataBR(data) + ' salvo.');
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});

/* ================= FINANCEIRO ================= */
const FIN_TIPO_ROTULO = { investimento: 'Investimento', receita_manual: 'Receita manual', despesa: 'Despesa' };

function finSyncDataInputs() {
  const d = state.finData;
  if ($('#finData').value !== d) $('#finData').value = d;
  if (!$('#finLancData').value || state.finEditandoId === null) $('#finLancData').value = d;
}
async function carregarFinanceiro() {
  if (!state.finData) state.finData = hojeLocal();
  finSyncDataInputs();
  await Promise.all([carregarFinCalculo(false), carregarFinLancamentos(), carregarFinInsumos()]);
}
async function carregarFinCalculo(mostrarResultado = true) {
  try {
    const c = await api('/api/painel/financeiro/calculo?data=' + encodeURIComponent(state.finData));
    state.finCalculo = c;
    renderFinCards(c);
    if (mostrarResultado) renderFinResultado(c);
  } catch (err) { toast(err.message, true); }
}
function renderFinCards(c) {
  $('#finCards').innerHTML = `
    <div class="rel-card fin-vendas"><div class="num">${fmtBRL(c.vendas_sistema)}</div><div class="rot">🧾 Vendas do sistema (automático)</div></div>
    <div class="rel-card fin-receitas"><div class="num">${fmtBRL(c.receita_manual)}</div><div class="rot">✍️ Receitas manuais</div></div>
    <div class="rel-card destaque-card fin-acumulada"><div class="num">${fmtBRL(c.receita_total)}</div><div class="rot">💰 Receita acumulada (vendas + manual)</div></div>
    <div class="rel-card fin-investimento"><div class="num">${fmtBRL(c.investimento_manual)}</div><div class="rot">🟡 Investimento</div></div>
    <div class="rel-card fin-insumos"><div class="num">${fmtBRL(c.insumos_total)}</div><div class="rot">🔵 Insumos</div></div>
    <div class="rel-card fin-despesas"><div class="num">${fmtBRL(c.despesas)}</div><div class="rot">🔴 Despesas</div></div>`;
  const lucro = Number(c.lucro_real) || 0;
  $('#finLucroCard').innerHTML = `
    <div class="fin-lucro ${lucro >= 0 ? 'pos' : 'neg'}">
      <div>
        <div class="rot">${lucro >= 0 ? '✅' : '⚠️'} LUCRO REAL DO DIA ${fmtDataBR(state.finData)}</div>
        <div class="num">${fmtBRL(lucro)}</div>
        <div class="sub">Receita acumulada ${fmtBRL(c.receita_total)} − custos ${fmtBRL(c.custo_total)} (investimento + insumos + despesas)</div>
      </div>
      <div class="sub">${c.pedidos_concluidos ?? 0} pedido(s) concluído(s) · ${c.copos ?? 0} copo(s)/item(ns) vendido(s)</div>
    </div>`;
}
function renderFinResultado(c) {
  const box = $('#finResultado');
  box.classList.remove('hidden');
  const lucroCopo = Number(c.lucro_por_copo) || 0;
  $('#finResCustoCopo').textContent = fmtBRL(c.custo_por_copo);
  $('#finResPrecoCopo').textContent = fmtBRL(c.preco_medio_copo);
  const el = $('#finResLucroCopo');
  el.textContent = fmtBRL(lucroCopo);
  el.className = lucroCopo >= 0 ? 'pos' : 'neg';
  $('#finResLucroDia').textContent = fmtBRL(c.lucro_real);
  const linhas = [
    ['Copos/itens vendidos no dia', String(c.copos ?? 0)],
    ['Pedidos concluídos', String(c.pedidos_concluidos ?? 0)],
    ['Número de entregas', String(c.entregas ?? 0)],
    ['Taxas de entrega recebidas', fmtBRL(c.taxas_entrega)],
    ['Custo médio por entrega (despesas ÷ entregas)', fmtBRL(c.custo_medio_entrega)],
    ['Vendas do sistema', fmtBRL(c.vendas_sistema)],
    ['Receitas manuais', fmtBRL(c.receita_manual)],
    ['Custo total (investimento + insumos + despesas)', fmtBRL(c.custo_total)],
  ];
  $('#finResDetalhe').innerHTML = linhas.map(([k, v]) => `<div class="rel-linha"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
}
$('#finData').addEventListener('change', (e) => {
  state.finData = e.target.value || hojeLocal();
  cancelarEdicaoLancamento();
  finSyncDataInputs();
  $('#finResultado').classList.add('hidden');
  carregarFinanceiro();
});

/* ----- Lançamentos ----- */
function finSelecionarTipo(tipo) {
  state.finTipoSel = tipo;
  $$('#finTipos .fin-chip').forEach(ch => ch.classList.toggle('sel', ch.dataset.tipo === tipo));
}
$$('#finTipos .fin-chip').forEach(ch => ch.addEventListener('click', () => finSelecionarTipo(ch.dataset.tipo)));

function cancelarEdicaoLancamento() {
  state.finEditandoId = null;
  $('#formLancamento').reset();
  setMoney($('#finLancValor'), null);
  $('#finLancData').value = state.finData || hojeLocal();
  finSelecionarTipo(state.finTipoSel);
  $('#btnSalvarLancamento').textContent = 'Adicionar lançamento';
  $('#btnCancelarEdicaoLanc').classList.add('hidden');
}
$('#btnCancelarEdicaoLanc').addEventListener('click', cancelarEdicaoLancamento);

$('#formLancamento').addEventListener('submit', async (e) => {
  e.preventDefault();
  const valor = getMoney($('#finLancValor'));
  if (!valor || valor <= 0) { toast('Informe um valor maior que zero.', true); return; }
  const payload = {
    tipo: state.finTipoSel,
    categoria: $('#finLancCategoria').value.trim(),
    descricao: $('#finLancDescricao').value.trim(),
    valor_centavos: valor,
    data: $('#finLancData').value || state.finData || hojeLocal(),
  };
  try {
    if (state.finEditandoId) {
      await api('/api/painel/financeiro/lancamentos/' + state.finEditandoId, { method: 'PUT', body: payload });
      toast('Lançamento atualizado.');
    } else {
      await api('/api/painel/financeiro/lancamentos', { method: 'POST', body: payload });
      toast('Lançamento adicionado.');
    }
    const editando = !!state.finEditandoId;
    cancelarEdicaoLancamento();
    if (payload.data !== state.finData && !editando) { state.finData = payload.data; }
    await carregarFinanceiro();
  } catch (err) { toast(err.message, true); }
});

async function carregarFinLancamentos() {
  try {
    const data = await api('/api/painel/financeiro/lancamentos?data=' + encodeURIComponent(state.finData));
    const lista = comoLista(data, 'lancamentos');
    const box = $('#finLancamentosList');
    if (!lista.length) {
      box.innerHTML = '<p class="dica">Nenhum lançamento neste dia. Adicione investimentos, receitas manuais e despesas no formulário acima.</p>';
      return;
    }
    box.innerHTML = `
      <table class="simple-table">
        <thead><tr><th>Tipo</th><th>Categoria</th><th>Descrição</th><th>Valor</th><th></th></tr></thead>
        <tbody>${lista.map(l => `
          <tr>
            <td><span class="fin-tipo ${esc(l.tipo)}">${esc(FIN_TIPO_ROTULO[l.tipo] || l.tipo)}</span></td>
            <td>${esc(l.categoria || '—')}</td>
            <td>${esc(l.descricao || '—')}</td>
            <td><strong>${fmtBRL(l.valor_centavos)}</strong></td>
            <td style="white-space:nowrap">
              <button class="btn btn-ghost btn-sm" data-fin-edit="${l.id}">Editar</button>
              <button class="btn btn-ghost btn-sm" data-fin-del="${l.id}">Excluir</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    $$('[data-fin-del]', box).forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Excluir este lançamento?')) return;
      try {
        await api('/api/painel/financeiro/lancamentos/' + b.dataset.finDel, { method: 'DELETE' });
        toast('Lançamento excluído.');
        if (String(state.finEditandoId) === String(b.dataset.finDel)) cancelarEdicaoLancamento();
        await carregarFinanceiro();
      } catch (err) { toast(err.message, true); }
    }));
    $$('[data-fin-edit]', box).forEach(b => b.addEventListener('click', () => {
      const l = lista.find(x => String(x.id) === String(b.dataset.finEdit));
      if (!l) return;
      state.finEditandoId = l.id;
      finSelecionarTipo(l.tipo);
      $('#finLancCategoria').value = l.categoria || '';
      $('#finLancDescricao').value = l.descricao || '';
      setMoney($('#finLancValor'), l.valor_centavos);
      $('#finLancData').value = l.data || state.finData;
      $('#btnSalvarLancamento').textContent = 'Salvar alterações';
      $('#btnCancelarEdicaoLanc').classList.remove('hidden');
      $('#formLancamento').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  } catch (err) { toast(err.message, true); }
}

/* ----- Insumos / Lucro por Venda ----- */
function fmtQtd(q) {
  const n = Number(q);
  if (!isFinite(n)) return esc(q ?? '');
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}
$('#formInsumo').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = $('#finInsumoNome').value.trim();
  const qtd = parseFloat($('#finInsumoQtd').value.replace(',', '.'));
  const custo = getMoney($('#finInsumoCusto'));
  if (!nome) { toast('Informe o nome do insumo.', true); return; }
  if (!isFinite(qtd) || qtd <= 0) { toast('Informe uma quantidade válida.', true); return; }
  if (!custo || custo <= 0) { toast('Informe o custo total do insumo.', true); return; }
  try {
    await api('/api/painel/financeiro/insumos', {
      method: 'POST',
      body: { nome, quantidade: qtd, unidade: $('#finInsumoUnidade').value.trim(), custo_total_centavos: custo, data: state.finData || hojeLocal() },
    });
    toast('Insumo adicionado.');
    e.target.reset();
    setMoney($('#finInsumoCusto'), null);
    await Promise.all([carregarFinInsumos(), carregarFinCalculo(false)]);
  } catch (err) { toast(err.message, true); }
});
async function carregarFinInsumos() {
  try {
    const data = await api('/api/painel/financeiro/insumos?data=' + encodeURIComponent(state.finData));
    const lista = comoLista(data, 'insumos');
    const box = $('#finInsumosList');
    if (!lista.length) {
      box.innerHTML = '<p class="dica">Nenhum insumo lançado neste dia. Ex.: Pote de açaí 5 kg — R$ 100,00 · Embalagens 100 un — R$ 50,00 · Morango 4 bandejas — R$ 25,00.</p>';
      return;
    }
    const total = lista.reduce((s, i) => s + (Number(i.custo_total_centavos) || 0), 0);
    box.innerHTML = `
      <table class="simple-table">
        <thead><tr><th>Insumo</th><th>Quantidade</th><th>Unidade</th><th>Custo total</th><th></th></tr></thead>
        <tbody>${lista.map(i => `
          <tr>
            <td>${esc(i.nome)}</td>
            <td>${fmtQtd(i.quantidade)}</td>
            <td>${esc(i.unidade || '—')}</td>
            <td><strong>${fmtBRL(i.custo_total_centavos)}</strong></td>
            <td><button class="btn btn-ghost btn-sm" data-ins-del="${i.id}">Excluir</button></td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr><td colspan="3"><strong>Total de insumos do dia</strong></td><td><strong>${fmtBRL(total)}</strong></td><td></td></tr></tfoot>
      </table>`;
    $$('[data-ins-del]', box).forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Excluir este insumo?')) return;
      try {
        await api('/api/painel/financeiro/insumos/' + b.dataset.insDel, { method: 'DELETE' });
        toast('Insumo excluído.');
        await Promise.all([carregarFinInsumos(), carregarFinCalculo(false)]);
      } catch (err) { toast(err.message, true); }
    }));
  } catch (err) { toast(err.message, true); }
}
$('#btnCalcularLucro').addEventListener('click', async () => {
  await carregarFinCalculo(true);
  const box = $('#finResultado');
  if (!box.classList.contains('hidden')) {
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('Lucro real calculado para ' + fmtDataBR(state.finData) + '.');
  }
});

/* ================= CONFIGURAÇÕES (WhatsApp + Telegram) ================= */
function cfgPill(el, configurado) {
  if (!el) return;
  el.textContent = configurado ? 'Configurado' : 'Não configurado';
  el.className = 'cfg-pill ' + (configurado ? 'on' : 'sim');
}
function cfgResultado(el, ok, mensagem) {
  if (!el) return;
  el.textContent = (ok ? '✅ ' : '❌ ') + (mensagem || (ok ? 'Tudo certo.' : 'Algo deu errado.'));
  el.className = 'cfg-result ' + (ok ? 'ok' : 'erro');
}
function cfgPrepararSegredo(input, configurado, mascara, placeholderVazio) {
  input.value = '';
  input.type = 'password';
  input.placeholder = configurado
    ? `Salvo (${mascara || '••••'}) — deixe em branco para manter`
    : placeholderVazio;
}
function preencherConfiguracoes(c) {
  state.configuracoes = c;
  const w = (c && c.whatsapp) || {};
  cfgPill($('#cfgWhatsPill'), !!w.configurado);
  $('#cfgWhatsAtivo').checked = w.ativo === undefined ? true : !!w.ativo;
  $('#cfgWhatsUrl').value = w.evolution_url || '';
  $('#cfgWhatsInstancia').value = w.evolution_instancia || '';
  cfgPrepararSegredo($('#cfgWhatsApikey'), !!w.apikey_configurada, w.apikey_mascarada, 'Cole a chave de API aqui');
  $('#cfgWhatsApikeyDica').textContent = w.apikey_configurada
    ? `🔑 Chave salva (${w.apikey_mascarada || '••••'}). Deixe o campo em branco para manter a atual — preencha só se for trocar.`
    : 'Você encontra a chave no painel da Evolution API (apikey). Ela fica guardada só no servidor.';
  const t = (c && c.telegram) || {};
  cfgPill($('#cfgTgPill'), !!t.configurado);
  $('#cfgTgAtivo').checked = t.ativo === undefined ? true : !!t.ativo;
  cfgPrepararSegredo($('#cfgTgToken'), !!t.token_configurado, t.token_mascarado, 'Cole o token do bot aqui');
  $('#cfgTgTokenDica').textContent = t.token_configurado
    ? `🔑 Token salvo (${t.token_mascarado || '••••'}). Deixe o campo em branco para manter o atual — preencha só se for trocar.`
    : 'O token é a sequência longa que o @BotFather devolve quando o bot é criado. Ele fica guardado só no servidor.';
  $('#cfgTgChatId').value = t.chat_id || '';
  $$('[data-mostrar]').forEach(b => { b.textContent = '👁 Mostrar'; });
}
async function carregarConfiguracoes() {
  try {
    const c = await api('/api/painel/configuracoes');
    preencherConfiguracoes(c);
  } catch (err) { toast(err.message, true); }
}
/* Mostrar / ocultar os campos de segredo (chave de API e token) */
$$('[data-mostrar]').forEach(b => b.addEventListener('click', () => {
  const input = document.getElementById(b.dataset.mostrar);
  if (!input) return;
  const mostrar = input.type === 'password';
  input.type = mostrar ? 'text' : 'password';
  b.textContent = mostrar ? '🙈 Ocultar' : '👁 Mostrar';
}));

/* ----- WhatsApp (Evolution API) ----- */
async function salvarCfgWhats() {
  const payload = {
    whatsapp_ativo: $('#cfgWhatsAtivo').checked,
    evolution_url: $('#cfgWhatsUrl').value.trim(),
    evolution_instancia: $('#cfgWhatsInstancia').value.trim(),
  };
  const chave = $('#cfgWhatsApikey').value.trim();
  if (chave) payload.evolution_apikey = chave; // em branco = mantém a chave salva
  const c = await api('/api/painel/configuracoes', { method: 'PUT', body: payload });
  preencherConfiguracoes(c);
  carregarSaude();
  return c;
}
$('#formCfgWhats').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await salvarCfgWhats(); toast('WhatsApp salvo.'); }
  catch (err) { toast(err.message, true); }
});
$('#btnCfgWhatsTestar').addEventListener('click', async () => {
  const res = $('#cfgWhatsResult');
  res.className = 'cfg-result';
  res.textContent = 'Salvando e testando a conexão...';
  try {
    await salvarCfgWhats();
    const data = await api('/api/painel/configuracoes/testar-whatsapp', { method: 'POST', body: {} });
    cfgResultado(res, !!data.ok, data.mensagem);
    if (data.ok) { toast('Conexão com o WhatsApp confirmada.'); carregarSaude(); }
  } catch (err) { cfgResultado(res, false, err.message); }
});

/* ----- Telegram do dono ----- */
async function salvarCfgTelegram() {
  const payload = {
    telegram_ativo: $('#cfgTgAtivo').checked,
    telegram_chat_id: $('#cfgTgChatId').value.trim(),
  };
  const token = $('#cfgTgToken').value.trim();
  if (token) payload.telegram_bot_token = token; // em branco = mantém o token salvo
  const c = await api('/api/painel/configuracoes', { method: 'PUT', body: payload });
  preencherConfiguracoes(c);
  carregarSaude();
  return c;
}
$('#formCfgTelegram').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await salvarCfgTelegram(); toast('Telegram salvo.'); }
  catch (err) { toast(err.message, true); }
});
$('#btnCfgTgDetectar').addEventListener('click', async () => {
  const info = $('#cfgTgDetect');
  const btn = $('#btnCfgTgDetectar');
  btn.disabled = true;
  info.className = 'cfg-result';
  info.textContent = 'Procurando sua conversa com o bot...';
  try {
    const data = await api('/api/painel/configuracoes/telegram/detectar-chat', { method: 'POST', body: {} });
    if (data && data.ok === false) {
      cfgResultado(info, false, data.mensagem || 'Nenhuma conversa encontrada. Abra o bot, mande um "oi", aguarde uns segundos e tente de novo.');
      btn.disabled = false;
      return;
    }
    let chatId = data ? (data.chat_id ?? data.id) : null;
    let nome = data ? data.nome : '';
    let username = data ? data.username : '';
    let aviso = '';
    if ((chatId === null || chatId === undefined || chatId === '') && data && Array.isArray(data.chats) && data.chats.length) {
      const primeiro = data.chats[0] || {};
      chatId = primeiro.chat_id ?? primeiro.id;
      nome = primeiro.nome || nome;
      username = primeiro.username || username;
      if (data.chats.length > 1) aviso = ` Encontramos ${data.chats.length} conversas e usamos a primeira — confira se é a sua.`;
    }
    if (chatId !== null && chatId !== undefined && chatId !== '') {
      $('#cfgTgChatId').value = String(chatId);
      const quem = String(nome || 'conversa').trim();
      const userTxt = username ? ' (@' + String(username).replace(/^@/, '') + ')' : '';
      cfgResultado(info, true, `Detectado: ${quem}${userTxt} — Chat ID ${chatId}.${aviso} Agora clique em "Salvar Telegram" para gravar.`);
    } else {
      cfgResultado(info, false, (data && data.mensagem) || 'Nenhuma conversa encontrada. Abra o bot, mande um "oi", aguarde uns segundos e tente de novo.');
    }
  } catch (err) { cfgResultado(info, false, err.message); }
  btn.disabled = false;
});
$('#btnCfgTgTestar').addEventListener('click', async () => {
  const res = $('#cfgTgResult');
  res.className = 'cfg-result';
  res.textContent = 'Salvando e testando...';
  try {
    await salvarCfgTelegram();
    const data = await api('/api/painel/configuracoes/testar-telegram', { method: 'POST', body: {} });
    let mensagem = data.mensagem || '';
    if (data.bot_username) {
      const bot = '@' + String(data.bot_username).replace(/^@/, '');
      mensagem = (mensagem ? mensagem + ' ' : '') + `Bot: ${bot}.`;
    }
    cfgResultado(res, !!data.ok, mensagem);
    if (data.ok) { toast('Teste enviado pro seu Telegram.'); carregarSaude(); }
  } catch (err) { cfgResultado(res, false, err.message); }
});

/* ================= INICIALIZAÇÃO ================= */
function iniciarApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  if (state.user) $('#userNome').textContent = state.user.nome || 'Admin';
  carregarLoja();
  carregarSaude();
  irPara('pedidos');
  conectarStream();
}
if (state.token) {
  // valida a sessão carregando a loja; se 401, o api() desloga sozinho
  iniciarApp();
}

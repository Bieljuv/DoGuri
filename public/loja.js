'use strict';
/* ============================================================
   Açaí do Guri — loja do cliente (JS puro, sem build)
   API conforme CONTRATO.md · dinheiro sempre em centavos
   ============================================================ */

/* ---------- utilitários ---------- */
const $  = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const fmtBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const R$ = (centavos) => fmtBRL.format((centavos || 0) / 100);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const semAcento = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const formatarHora = (iso) => {
  if (!iso) return '';
  let s = String(iso);
  /* Datas do banco vêm em UTC sem fuso marcado — sem o 'Z' o navegador
     mostraria 3h a mais. Convertendo, sai o horário de Brasília. */
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return isNaN(d) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

/* ---------- estado global ---------- */
let loja = null;
let categorias = [];
let produtos = [];
const produtosPorId = new Map();
let bairros = [];
let carrinho = carregarCarrinho();
let buscaAtual = '';

function carregarCarrinho() {
  try {
    const c = JSON.parse(localStorage.getItem('guri_carrinho') || '[]');
    return Array.isArray(c) ? c : [];
  } catch { return []; }
}
function salvarCarrinho() {
  try { localStorage.setItem('guri_carrinho', JSON.stringify(carrinho)); } catch {}
  renderBarraCarrinho();
}
const subtotalCarrinho = () =>
  carrinho.reduce((s, i) => s + i.preco_unitario_centavos * i.quantidade, 0);
const qtdCarrinho = () => carrinho.reduce((s, i) => s + i.quantidade, 0);

/* ---------- cabeçalho: transição de cor dirigida pela rolagem ---------- */
const hdr = $('#hdr');
const reduzMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const PARADAS_COR = [[31, 4, 33], [70, 5, 69], [126, 4, 125]]; // #1F0421 → #460545 → #7E047D
function corCabecalho(t) {
  let a, b, lt;
  if (t < 0.5) { a = PARADAS_COR[0]; b = PARADAS_COR[1]; lt = t * 2; }
  else { a = PARADAS_COR[1]; b = PARADAS_COR[2]; lt = (t - 0.5) * 2; }
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * lt));
  const alpha = Math.min(1, t * 2.4); // transparente no topo → sólido ao fixar
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
let rolagemPendente = false;
function atualizarCabecalho() {
  const y = window.scrollY || 0;
  let t = Math.min(1, y / 240);
  if (reduzMotion) t = y > 40 ? 1 : 0; // sem interpolação: troca direta ao fixar
  hdr.style.setProperty('--hdr-bg', corCabecalho(t));
  hdr.style.setProperty('--accop', t >= 1 ? '1' : String((t * 0.7).toFixed(2)));
  hdr.classList.toggle('compacto', t >= 1);
  rolagemPendente = false;
}
window.addEventListener('scroll', () => {
  if (!rolagemPendente) { rolagemPendente = true; requestAnimationFrame(atualizarCabecalho); }
}, { passive: true });

/* ---------- overlays ---------- */
function abrirOverlay(id) { $('#overlay-' + id).hidden = false; document.body.style.overflow = 'hidden'; }
function fecharOverlay(id) {
  $('#overlay-' + id).hidden = true;
  if ($$('.overlay:not([hidden])').length === 0) document.body.style.overflow = '';
}
$$('.overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.hidden = true, document.body.style.overflow = ''; });
});
$$('[data-fechar]').forEach((b) => b.addEventListener('click', () => fecharOverlay(b.dataset.fechar)));

/* ---------- cálculo de preço (espelha a regra do servidor) ---------- */
function calcularUnitario(produto, selecionadas) {
  let total = produto.preco_base_centavos || 0;
  for (const g of produto.grupos || []) {
    const ops = (g.opcoes || []).filter((o) => selecionadas.has(o.id));
    total += ops.reduce((s, o) => s + (o.preco_adicional_centavos || 0), 0);
    if (g.tipo_escolha === 'multipla' && g.excedente_vira_pago && g.maximo != null) {
      total += Math.max(0, ops.length - g.maximo) * (g.preco_excedente_centavos || 0);
    }
  }
  return total;
}
function precoMinimo(produto) {
  if (produto.tipo !== 'montavel') return produto.preco_base_centavos || 0;
  let t = produto.preco_base_centavos || 0;
  for (const g of produto.grupos || []) {
    const disp = (g.opcoes || []).filter((o) => !o.esgotada)
      .map((o) => o.preco_adicional_centavos || 0).sort((a, b) => a - b);
    if (!disp.length) continue;
    if (g.tipo_escolha === 'unica') { if (g.obrigatorio) t += disp[0]; }
    else {
      const min = g.obrigatorio ? Math.max(g.minimo || 0, 1) : 0;
      for (let i = 0; i < Math.min(min, disp.length); i++) t += disp[i];
    }
  }
  return t;
}
function validarGrupo(g, qtdSel) {
  if (g.tipo_escolha === 'unica') {
    if (g.obrigatorio && qtdSel < 1) return 'Escolha uma opção para continuar.';
    return null;
  }
  if (qtdSel === 0) {
    if (g.obrigatorio) return `Escolha pelo menos ${Math.max(g.minimo || 0, 1)} opção(ões).`;
    return null;
  }
  if ((g.minimo || 0) > 0 && qtdSel < g.minimo) return `Escolha pelo menos ${g.minimo} opções.`;
  return null;
}
function dicaGrupo(g) {
  const partes = [];
  if (g.tipo_escolha === 'unica') partes.push(g.obrigatorio ? 'Escolha 1 (obrigatório)' : 'Escolha 1 (opcional)');
  else {
    if (g.maximo != null) partes.push(`Escolha até ${g.maximo}`);
    if ((g.minimo || 0) > 0) partes.push(`mínimo ${g.minimo}`);
    if (g.obrigatorio && (g.minimo || 0) === 0) partes.push('obrigatório');
    if (g.excedente_vira_pago && g.maximo != null && (g.preco_excedente_centavos || 0) > 0)
      partes.push(`extras por +${R$(g.preco_excedente_centavos)} cada`);
    if (!partes.length) partes.push('Escolha quantos quiser');
  }
  return partes.join(' · ');
}
function resumoDoItem(produto, selecionadas) {
  const linhas = [];
  for (const g of produto.grupos || []) {
    const nomes = (g.opcoes || []).filter((o) => selecionadas.has(o.id)).map((o) => o.nome);
    if (nomes.length) linhas.push(`${g.nome}: ${nomes.join(', ')}`);
  }
  return linhas;
}

/* ---------- carregamento inicial ---------- */
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function iniciar() {
  atualizarCabecalho();
  try {
    const [lj, card, br] = await Promise.all([
      getJSON('/api/public/loja'),
      getJSON('/api/public/cardapio'),
      getJSON('/api/public/bairros'),
    ]);
    loja = lj;
    categorias = (card.categorias || []).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    produtos = (card.produtos || []).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    produtos.forEach((p) => produtosPorId.set(p.id, p));
    bairros = (br || []).filter((b) => b.ativo !== false);
    renderLoja();
    renderCardapio();
    renderBarraCarrinho();
  } catch (e) {
    $('#hero-status').textContent = 'Não foi possível carregar a loja agora. Verifique sua conexão e recarregue a página.';
    $('#hero-status').className = 'hero-status fechada';
  }
  roteador();
}

function renderLoja() {
  document.title = `${loja.nome} — Peça online`;
  $('#hdr-nome').textContent = loja.nome;
  $('#hero-nome').textContent = loja.nome;
  if (loja.logo_url) {
    const hl = $('#hdr-logo'); hl.src = loja.logo_url; hl.hidden = false;
    const gl = $('#hero-logo'); gl.src = loja.logo_url; gl.hidden = false;
  }
  const aberta = !!loja.aberta && !loja.pausada;
  const txtStatus = loja.pausada ? '⏸️ Pausada no momento' : (aberta ? '🟢 Aberta agora' : '🔴 Fechada no momento');
  const hs = $('#hdr-status');
  hs.textContent = loja.pausada ? 'Pausada' : (aberta ? 'Aberta' : 'Fechada');
  hs.className = 'hstatus ' + (aberta ? 'aberta' : 'fechada');
  const hero = $('#hero-status');
  hero.textContent = txtStatus;
  hero.className = 'hero-status ' + (aberta ? 'aberta' : 'fechada');

  const infos = [];
  if (loja.tempo_entrega_min) infos.push(`⏱️ Entrega em ~${loja.tempo_entrega_min} min`);
  else if (loja.tempo_preparo_min) infos.push(`⏱️ Preparo em ~${loja.tempo_preparo_min} min`);
  if (loja.taxa_unica_centavos != null) infos.push(`🛵 Entrega ${loja.taxa_unica_centavos === 0 ? 'grátis' : R$(loja.taxa_unica_centavos)}`);
  if (loja.pedido_minimo_centavos > 0) infos.push(`Pedido mínimo ${R$(loja.pedido_minimo_centavos)}`);
  $('#hero-info').textContent = infos.join('  •  ');

  if (loja.instagram) {
    const a = $('#hero-insta');
    const user = String(loja.instagram).replace(/^@/, '');
    a.href = 'https://www.instagram.com/' + user + '/';
    a.textContent = '📷 @' + user;
    a.hidden = false;
  }
  if (loja.whatsapp) {
    const a = $('#hero-zap');
    a.href = 'https://wa.me/' + soDigitos(loja.whatsapp);
    a.hidden = false;
  }
  if (loja.endereco_texto) $('#rodape-endereco').textContent = '📍 ' + loja.endereco_texto;

  const banner = $('#banner-fechada');
  if (!aberta) {
    banner.textContent = loja.mensagem_status ||
      (loja.pausada
        ? 'A loja está pausada e não está recebendo pedidos no momento. Volte em instantes! 💜'
        : 'A loja está fechada e não está recebendo pedidos no momento. Você pode olhar o cardápio; volte no horário de funcionamento! 💜');
    banner.hidden = false;
  } else banner.hidden = true;
}

/* ---------- cardápio ---------- */
function produtosDaCategoria(catId) {
  return produtos.filter((p) => p.categoria_id === catId);
}
function renderChips() {
  const nav = $('#chips');
  nav.innerHTML = '';
  for (const c of categorias) {
    if (!produtosDaCategoria(c.id).length) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = c.nome;
    b.dataset.alvo = 'secao-' + c.id;
    b.addEventListener('click', () => {
      const alvo = document.getElementById('secao-' + c.id);
      if (alvo) alvo.scrollIntoView({ behavior: reduzMotion ? 'auto' : 'smooth' });
      $$('.chip', nav).forEach((x) => x.classList.toggle('ativo', x === b));
    });
    nav.appendChild(b);
  }
}
function cardProduto(p) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card-produto' + (p.esgotado ? ' esgotado' : '');
  card.disabled = !!p.esgotado;
  const min = precoMinimo(p);
  const precoHTML = p.tipo === 'montavel'
    ? `<span class="apartir">a partir de</span> ${R$(min)}`
    : R$(min);
  const foto = p.foto_url
    ? `<img class="cp-foto" src="${esc(p.foto_url)}" alt="" loading="lazy">`
    : `<div class="cp-foto-vazia" aria-hidden="true">🫐</div>`;
  const selos = [
    p.destaque ? '<span class="selo selo-destaque">⭐ Mais pedido</span>' : '',
    p.esgotado ? '<span class="selo selo-esgotado">Esgotado</span>' : '',
  ].join('');
  card.innerHTML = `
    <div class="cp-textos">
      ${selos ? `<div class="cp-selos">${selos}</div>` : ''}
      <span class="cp-nome">${esc(p.nome)}</span>
      ${p.descricao ? `<span class="cp-desc">${esc(p.descricao)}</span>` : ''}
      <span class="cp-preco">${precoHTML}</span>
    </div>${foto}`;
  card.addEventListener('click', () => abrirMontador(p, null));
  return card;
}
function renderCardapio() {
  renderChips();
  const cont = $('#cardapio');
  cont.innerHTML = '';
  const termo = semAcento(buscaAtual.trim());
  let algum = false;
  for (const c of categorias) {
    let lista = produtosDaCategoria(c.id);
    if (termo) lista = lista.filter((p) => semAcento(p.nome).includes(termo) || semAcento(p.descricao || '').includes(termo));
    if (!lista.length) continue;
    algum = true;
    const sec = document.createElement('section');
    sec.className = 'secao';
    sec.id = 'secao-' + c.id;
    const h = document.createElement('h2');
    h.className = 'secao-titulo';
    h.textContent = c.nome;
    sec.appendChild(h);
    lista.forEach((p) => sec.appendChild(cardProduto(p)));
    cont.appendChild(sec);
  }
  $('#sem-resultado').hidden = algum;
  observarSecoes();
}
let observadorSecoes = null;
function observarSecoes() {
  if (observadorSecoes) observadorSecoes.disconnect();
  observadorSecoes = new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (e.isIntersecting) {
        $$('.chip').forEach((ch) => ch.classList.toggle('ativo', ch.dataset.alvo === e.target.id));
      }
    }
  }, { rootMargin: '-30% 0px -60% 0px' });
  $$('.secao').forEach((s) => observadorSecoes.observe(s));
}
$('#busca').addEventListener('input', (e) => { buscaAtual = e.target.value; renderCardapio(); });

/* ============================================================
   MONTADOR
   ============================================================ */
let mont = null; // { produto, selecionadas:Set, qtd, editandoIdx }

function abrirMontador(produto, itemCarrinho) {
  mont = {
    produto,
    selecionadas: new Set(itemCarrinho ? itemCarrinho.opcoes : []),
    qtd: itemCarrinho ? itemCarrinho.quantidade : 1,
    editandoIdx: itemCarrinho ? carrinho.indexOf(itemCarrinho) : -1,
  };
  $('#montador-titulo').textContent = produto.nome;
  const foto = $('#montador-foto');
  if (produto.foto_url) { foto.src = produto.foto_url; foto.hidden = false; } else foto.hidden = true;
  $('#montador-desc').textContent = produto.descricao || '';
  $('#montador-obs').value = itemCarrinho ? (itemCarrinho.observacao || '') : '';
  renderGruposMontador();
  atualizarRodapeMontador();
  abrirOverlay('montador');
}
function grupoDoMontador(gid) {
  return (mont.produto.grupos || []).find((g) => g.id === gid);
}
function qtdSelecionadas(gid) {
  const g = grupoDoMontador(gid);
  return (g.opcoes || []).filter((o) => mont.selecionadas.has(o.id)).length;
}
function renderGruposMontador() {
  const cont = $('#montador-grupos');
  cont.innerHTML = '';
  const grupos = (mont.produto.grupos || []).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
  for (const g of grupos) {
    const div = document.createElement('div');
    div.className = 'grupo';
    div.id = 'grupo-' + g.id;
    const contSel = qtdSelecionadas(g.id);
    const contador = g.tipo_escolha === 'multipla' && g.maximo != null
      ? `${contSel}/${g.maximo}` : (contSel ? `${contSel} selecionado(s)` : '');
    div.innerHTML = `
      <div class="grupo-topo">
        <span class="grupo-nome">${esc(g.nome)}</span>
        <span class="grupo-contador">${esc(contador)}</span>
      </div>
      <p class="grupo-dica">${esc(dicaGrupo(g))}</p>
      <p class="grupo-erro" hidden></p>`;
    const ops = (g.opcoes || []).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    const noLimite = g.tipo_escolha === 'multipla' && !g.excedente_vira_pago &&
      g.maximo != null && contSel >= g.maximo;
    for (const o of ops) {
      const sel = mont.selecionadas.has(o.id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opcao' + (g.tipo_escolha === 'multipla' ? ' multipla' : '') +
        (sel ? ' selecionada' : '') + (o.esgotada ? ' esgotada' : '') +
        (!sel && noLimite ? ' bloqueada' : '');
      b.disabled = !!o.esgotada;
      const preco = (o.preco_adicional_centavos || 0) > 0
        ? `<span class="op-preco">+ ${R$(o.preco_adicional_centavos)}</span>`
        : `<span class="op-preco gratis">incluso</span>`;
      b.innerHTML = `<span class="op-marcador">${sel ? '✓' : ''}</span>
        <span class="op-nome">${esc(o.nome)}${o.esgotada ? ' (esgotado)' : ''}</span>${preco}`;
      b.addEventListener('click', () => alternarOpcao(g, o));
      div.appendChild(b);
    }
    cont.appendChild(div);
  }
}
function alternarOpcao(g, o) {
  const sel = mont.selecionadas;
  if (g.tipo_escolha === 'unica') {
    const ja = sel.has(o.id);
    (g.opcoes || []).forEach((x) => sel.delete(x.id));
    if (!ja || g.obrigatorio) sel.add(o.id); // opcional permite desmarcar
  } else {
    if (sel.has(o.id)) sel.delete(o.id);
    else {
      if (!g.excedente_vira_pago && g.maximo != null && qtdSelecionadas(g.id) >= g.maximo) {
        toast(`Máximo de ${g.maximo} neste grupo.`);
        return;
      }
      sel.add(o.id);
    }
  }
  const divG = $('#grupo-' + g.id);
  if (divG) divG.classList.remove('invalido');
  renderGruposMontador();
  atualizarRodapeMontador();
}
function atualizarRodapeMontador() {
  if (!mont) return;
  $('#montador-qtd').textContent = mont.qtd;
  const unit = calcularUnitario(mont.produto, mont.selecionadas);
  $('#montador-adicionar').textContent =
    `${mont.editandoIdx >= 0 ? 'Atualizar' : 'Adicionar'} • ${R$(unit * mont.qtd)}`;
}
$('#montador-menos').addEventListener('click', () => { if (mont && mont.qtd > 1) { mont.qtd--; atualizarRodapeMontador(); } });
$('#montador-mais').addEventListener('click', () => { if (mont && mont.qtd < 30) { mont.qtd++; atualizarRodapeMontador(); } });
$('#montador-adicionar').addEventListener('click', () => {
  if (!mont) return;
  const { produto, selecionadas } = mont;
  let primeiroInvalido = null;
  for (const g of produto.grupos || []) {
    const erro = validarGrupo(g, qtdSelecionadas(g.id));
    const divG = $('#grupo-' + g.id);
    if (divG) {
      divG.classList.toggle('invalido', !!erro);
      const elErro = $('.grupo-erro', divG);
      if (elErro) { elErro.textContent = erro || ''; elErro.hidden = !erro; }
    }
    if (erro && !primeiroInvalido) primeiroInvalido = divG;
  }
  if (primeiroInvalido) {
    primeiroInvalido.scrollIntoView({ behavior: reduzMotion ? 'auto' : 'smooth', block: 'center' });
    toast('Falta escolher uma opção obrigatória. 👀');
    return;
  }
  const opcoesIds = (produto.grupos || [])
    .flatMap((g) => (g.opcoes || []).filter((o) => selecionadas.has(o.id)).map((o) => o.id));
  const item = {
    produto_id: produto.id,
    nome: produto.nome,
    foto_url: produto.foto_url || '',
    tipo: produto.tipo,
    quantidade: mont.qtd,
    observacao: $('#montador-obs').value.trim(),
    opcoes: opcoesIds,
    resumoLinhas: resumoDoItem(produto, selecionadas),
    preco_unitario_centavos: calcularUnitario(produto, selecionadas),
  };
  if (mont.editandoIdx >= 0) carrinho[mont.editandoIdx] = item;
  else {
    const igual = carrinho.findIndex((i) =>
      i.produto_id === item.produto_id && i.observacao === item.observacao &&
      JSON.stringify(i.opcoes.slice().sort()) === JSON.stringify(item.opcoes.slice().sort()));
    if (igual >= 0) carrinho[igual].quantidade += item.quantidade;
    else carrinho.push(item);
  }
  mont = null;
  salvarCarrinho();
  fecharOverlay('montador');
  renderCarrinho();
  toast('Adicionado ao pedido 🛒');
});

/* ============================================================
   CARRINHO
   ============================================================ */
function renderBarraCarrinho() {
  const barra = $('#barra-carrinho');
  const q = qtdCarrinho();
  barra.hidden = q === 0 || !$('#view-pedido').hidden;
  $('#barra-info').textContent = q > 0 ? `${q} ${q === 1 ? 'item' : 'itens'} • ${R$(subtotalCarrinho())}` : '';
  const badge = $('#hdr-badge');
  badge.hidden = q === 0;
  badge.textContent = q;
}
function abrirCarrinho() { renderCarrinho(); abrirOverlay('carrinho'); }
function renderCarrinho() {
  const cont = $('#carrinho-itens');
  cont.innerHTML = '';
  if (!carrinho.length) {
    cont.innerHTML = '<p class="carrinho-vazio">Seu pedido está vazio.<br>Escolha algo gostoso no cardápio! 🫐</p>';
  }
  carrinho.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'item-carrinho';
    const linhas = (item.resumoLinhas || []).map(esc).join('\n');
    div.innerHTML = `
      <div class="ic-topo">
        <span class="ic-nome">${item.quantidade}× ${esc(item.nome)}</span>
        <span class="ic-preco">${R$(item.preco_unitario_centavos * item.quantidade)}</span>
      </div>
      ${linhas ? `<p class="ic-opcoes">${linhas}</p>` : ''}
      ${item.observacao ? `<p class="ic-obs">“${esc(item.observacao)}”</p>` : ''}
      <div class="ic-acoes">
        <div class="qtd-controle">
          <button type="button" data-acao="menos" aria-label="Diminuir">−</button>
          <span>${item.quantidade}</span>
          <button type="button" data-acao="mais" aria-label="Aumentar">+</button>
        </div>
        <button type="button" class="btn-texto" data-acao="editar">Editar</button>
        <button type="button" class="btn-texto perigo" data-acao="remover">Remover</button>
      </div>`;
    div.addEventListener('click', (e) => {
      const acao = e.target.closest('[data-acao]')?.dataset.acao;
      if (!acao) return;
      if (acao === 'menos') { item.quantidade--; if (item.quantidade <= 0) carrinho.splice(idx, 1); }
      if (acao === 'mais') item.quantidade = Math.min(30, item.quantidade + 1);
      if (acao === 'remover') carrinho.splice(idx, 1);
      if (acao === 'editar') {
        const p = produtosPorId.get(item.produto_id);
        if (p) { fecharOverlay('carrinho'); abrirMontador(p, item); return; }
        toast('Este item não está mais no cardápio.');
        return;
      }
      salvarCarrinho();
      renderCarrinho();
    });
    cont.appendChild(div);
  });
  $('#carrinho-subtotal').textContent = R$(subtotalCarrinho());
  $('#btn-ir-checkout').disabled = !carrinho.length;
}
$('#barra-carrinho').addEventListener('click', abrirCarrinho);
$('#hdr-carrinho').addEventListener('click', abrirCarrinho);
$('#btn-ir-checkout').addEventListener('click', () => { fecharOverlay('carrinho'); abrirCheckout(); });

/* ============================================================
   CHECKOUT
   ============================================================ */
const METODOS_PADRAO = [
  { codigo: 'pix', rotulo: 'Pix (na entrega/retirada)', online: false },
  { codigo: 'cartao', rotulo: 'Cartão (na entrega/retirada)', online: false },
  { codigo: 'dinheiro', rotulo: 'Dinheiro', online: false },
];
const ROTULOS_PAG = {
  pix: 'Pix (na entrega/retirada)', cartao: 'Cartão (na entrega/retirada)', dinheiro: 'Dinheiro',
  pix_mp: 'Pix online — Mercado Pago', cartao_mp: 'Cartão online — Mercado Pago',
  pix_asaas: 'Pix online — Asaas', cartao_asaas: 'Cartão online — Asaas',
};
const ONLINE_SET = new Set(['pix_mp', 'cartao_mp', 'pix_asaas', 'cartao_asaas']);
let tipoRecebimento = 'entrega';
let pagamentoSel = null;
let ultimoPagamento = null; // pagamento devolvido pelo POST (online)

function mascararFone(v) {
  const d = soDigitos(v).slice(0, 11);
  if (d.length > 6) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length > 2) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length > 0) return `(${d}`;
  return '';
}
$('#ck-whats').addEventListener('input', (e) => { e.target.value = mascararFone(e.target.value); });
function parseReais(txt) {
  const s = String(txt || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n * 100);
}
function taxaAtual() {
  if (tipoRecebimento === 'retirada') return 0;
  const sel = $('#ck-bairro').value;
  const b = bairros.find((x) => String(x.id) === String(sel));
  if (b) return b.taxa_centavos || 0;
  if (!bairros.length && loja && loja.taxa_unica_centavos != null) return loja.taxa_unica_centavos;
  return null; // ainda não dá para calcular
}
function atualizarResumoCheckout() {
  const sub = subtotalCarrinho();
  const taxa = taxaAtual();
  $('#rs-subtotal').textContent = R$(sub);
  $('#rs-taxa').textContent = taxa === null ? 'a calcular' : (taxa === 0 ? 'Grátis 🎉' : R$(taxa));
  $('#rs-total').textContent = R$(sub + (taxa || 0));
  const btn = $('#btn-confirmar');
  btn.textContent = `Confirmar pedido • ${R$(sub + (taxa || 0))}`;
  const avisoMin = $('#rs-minimo');
  let bloqueia = false;
  if (loja && loja.pedido_minimo_centavos > 0 && sub < loja.pedido_minimo_centavos) {
    avisoMin.textContent = `Pedido mínimo de ${R$(loja.pedido_minimo_centavos)} — falta ${R$(loja.pedido_minimo_centavos - sub)}.`;
    avisoMin.hidden = false; bloqueia = true;
  } else avisoMin.hidden = true;
  if (loja && !loja.aberta) bloqueia = true;
  btn.disabled = bloqueia;
}
function renderBairrosCheckout() {
  const sel = $('#ck-bairro');
  sel.innerHTML = '';
  if (!bairros.length) {
    const op = document.createElement('option');
    op.value = ''; op.textContent = 'Entrega (taxa única da loja)';
    sel.appendChild(op);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const op0 = document.createElement('option');
  op0.value = ''; op0.textContent = 'Selecione seu bairro…';
  sel.appendChild(op0);
  for (const b of bairros) {
    const op = document.createElement('option');
    op.value = b.id;
    op.textContent = `${b.bairro} — ${b.taxa_centavos === 0 ? 'grátis' : R$(b.taxa_centavos)}`;
    sel.appendChild(op);
  }
}
function renderPagamentosCheckout() {
  const lista = (loja && Array.isArray(loja.metodos_pagamento) && loja.metodos_pagamento.length)
    ? loja.metodos_pagamento : METODOS_PADRAO;
  const cont = $('#ck-pagamentos');
  cont.innerHTML = '';
  for (const m of lista) {
    const online = m.online != null ? !!m.online : ONLINE_SET.has(m.codigo);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pag-opcao' + (pagamentoSel === m.codigo ? ' selecionada' : '');
    b.innerHTML = `<span class="pag-rotulo">${esc(m.rotulo || ROTULOS_PAG[m.codigo] || m.codigo)}</span>
      ${online ? '<span class="pag-online">ONLINE</span>' : ''}`;
    b.addEventListener('click', () => {
      pagamentoSel = m.codigo;
      renderPagamentosCheckout();
      $('#ck-troco-wrap').hidden = pagamentoSel !== 'dinheiro';
      $('#ck-pag-online-aviso').hidden = !online;
    });
    cont.appendChild(b);
  }
  if (!pagamentoSel && lista.length) {
    pagamentoSel = lista[0].codigo;
    renderPagamentosCheckout();
    const primeiroOnline = (lista[0].online != null ? !!lista[0].online : ONLINE_SET.has(lista[0].codigo));
    $('#ck-troco-wrap').hidden = pagamentoSel !== 'dinheiro';
    $('#ck-pag-online-aviso').hidden = !primeiroOnline;
  }
}
function definirTipo(tipo) {
  tipoRecebimento = tipo;
  $$('#ck-tipo button').forEach((b) => b.classList.toggle('seg-ativo', b.dataset.tipo === tipo));
  $('#ck-endereco').hidden = tipo === 'retirada';
  atualizarResumoCheckout();
}
$$('#ck-tipo button').forEach((b) => b.addEventListener('click', () => definirTipo(b.dataset.tipo)));
$('#ck-bairro').addEventListener('change', atualizarResumoCheckout);

function abrirCheckout() {
  let salvo = {};
  try { salvo = JSON.parse(localStorage.getItem('guri_cliente') || '{}'); } catch {}
  if (salvo.nome) $('#ck-nome').value = salvo.nome;
  if (salvo.whatsapp) $('#ck-whats').value = mascararFone(salvo.whatsapp);
  if (salvo.rua) $('#ck-rua').value = salvo.rua;
  if (salvo.numero) $('#ck-numero').value = salvo.numero;
  if (salvo.complemento) $('#ck-complemento').value = salvo.complemento;
  if (salvo.referencia) $('#ck-referencia').value = salvo.referencia;
  renderBairrosCheckout();
  if (salvo.bairro_id) $('#ck-bairro').value = salvo.bairro_id;
  renderPagamentosCheckout();
  definirTipo('entrega');
  const erro = $('#ck-erro');
  if (loja && !loja.aberta) {
    erro.textContent = loja.pausada
      ? 'A loja está pausada e não está recebendo pedidos no momento.'
      : 'A loja está fechada e não está recebendo pedidos no momento.';
    erro.hidden = false;
  } else erro.hidden = true;
  atualizarResumoCheckout();
  abrirOverlay('checkout');
}
function erroCheckout(msg) {
  const e = $('#ck-erro');
  e.textContent = msg;
  e.hidden = false;
  e.scrollIntoView({ behavior: reduzMotion ? 'auto' : 'smooth', block: 'center' });
}
$('#form-checkout').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!carrinho.length) return erroCheckout('Seu pedido está vazio.');
  const nome = $('#ck-nome').value.trim();
  const whats = soDigitos($('#ck-whats').value);
  if (nome.length < 2) return erroCheckout('Conte pra gente seu nome 🙂');
  if (whats.length < 10 || whats.length > 13) return erroCheckout('Confira seu WhatsApp (DDD + número).');
  if (!pagamentoSel) return erroCheckout('Escolha a forma de pagamento.');
  let bairro_id = null, endereco = null;
  if (tipoRecebimento === 'entrega') {
    const rua = $('#ck-rua').value.trim();
    const numero = $('#ck-numero').value.trim();
    if (bairros.length) {
      bairro_id = $('#ck-bairro').value || null;
      if (!bairro_id) return erroCheckout('Selecione seu bairro para calcularmos a entrega.');
    }
    if (!rua) return erroCheckout('Informe a rua da entrega.');
    if (!numero) return erroCheckout('Informe o número da casa/prédio.');
    endereco = {
      rua, numero,
      complemento: $('#ck-complemento').value.trim(),
      referencia: $('#ck-referencia').value.trim(),
    };
  }
  let troco = null;
  if (pagamentoSel === 'dinheiro') {
    const t = parseReais($('#ck-troco').value);
    if (t != null) {
      const taxa = taxaAtual() || 0;
      if (t < subtotalCarrinho() + taxa) return erroCheckout('O valor do troco é menor que o total do pedido.');
      troco = t;
    }
  }
  const payload = {
    cliente_nome: nome,
    cliente_whatsapp: whats,
    tipo: tipoRecebimento,
    bairro_id,
    endereco,
    forma_pagamento: pagamentoSel,
    troco_para_centavos: troco,
    observacao: $('#ck-obs').value.trim(),
    itens: carrinho.map((i) => ({
      produto_id: i.produto_id, quantidade: i.quantidade,
      observacao: i.observacao || '', opcoes: i.opcoes,
    })),
  };
  const btn = $('#btn-confirmar');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const r = await fetch('/api/public/pedidos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dados.erro || 'Não foi possível enviar o pedido. Tente de novo.');
    ultimoPagamento = dados.pagamento || null;
    try {
      localStorage.setItem('guri_cliente', JSON.stringify({
        nome, whatsapp: whats, bairro_id,
        rua: endereco?.rua || '', numero: endereco?.numero || '',
        complemento: endereco?.complemento || '', referencia: endereco?.referencia || '',
      }));
    } catch {}
    carrinho = [];
    salvarCarrinho();
    fecharOverlay('checkout');
    toast(`Pedido #${dados.numero} enviado! 🎉`);
    location.hash = '#/pedido/' + dados.token;
  } catch (e) {
    erroCheckout(e.message || 'Algo deu errado. Seu pedido continua no carrinho — tente de novo.');
  } finally {
    btn.disabled = false;
    atualizarResumoCheckout();
  }
});

/* ============================================================
   ACOMPANHAMENTO DO PEDIDO
   ============================================================ */
const STATUS_TXT = {
  NOVO: 'Recebemos seu pedido! Aguardando a confirmação da loja.',
  EM_PREPARO: 'Pedido confirmado! Já estamos preparando seu açaí. 💜',
  PRONTO: 'Seu pedido está pronto!',
  SAIU_ENTREGA: 'Seu açaí saiu para entrega! 🛵',
  ENTREGUE: 'Pedido entregue. Bom açaí! 😋',
  CANCELADO: 'Este pedido foi cancelado.',
};
let tokenAcomp = null;
let timerAcomp = null;

function linhasOpcoesPedido(item) {
  const ops = item.opcoes || [];
  if (!ops.length) return '';
  const grupos = new Map();
  for (const o of ops) {
    if (typeof o === 'string') {
      if (!grupos.has('')) grupos.set('', []);
      grupos.get('').push(o);
    } else {
      const g = o.grupo_nome_snapshot || o.grupo_nome || '';
      if (!grupos.has(g)) grupos.set(g, []);
      grupos.get(g).push(o.opcao_nome_snapshot || o.nome || '');
    }
  }
  return Array.from(grupos.entries())
    .map(([g, ns]) => (g ? `${g}: ${ns.join(', ')}` : ns.join(', '))).join('\n');
}
function enderecoTextoPedido(d) {
  const e = d.endereco;
  if (!e) return d.endereco_texto || '';
  if (typeof e === 'string') return e;
  const partes = [e.rua && `${e.rua}, ${e.numero || 's/n'}`, e.complemento, d.bairro_nome || d.bairro, e.referencia && `Ref.: ${e.referencia}`];
  return partes.filter(Boolean).join(' • ');
}
function renderAcompanhamento(d) {
  const cont = $('#acompanhamento');
  const etapasBase = d.tipo === 'retirada'
    ? ['NOVO', 'EM_PREPARO', 'PRONTO', 'ENTREGUE']
    : ['NOVO', 'EM_PREPARO', 'PRONTO', 'SAIU_ENTREGA', 'ENTREGUE'];
  const NOMES_ETAPA = {
    NOVO: 'Pedido recebido', EM_PREPARO: 'Em preparo', PRONTO: d.tipo === 'retirada' ? 'Pronto para retirada' : 'Pronto',
    SAIU_ENTREGA: 'Saiu para entrega', ENTREGUE: 'Entregue',
  };
  const idxAtual = etapasBase.indexOf(d.status);
  const horas = {};
  let motivoCancel = '';
  for (const h of d.historico || []) {
    const st = h.para_status || h.status;
    if (st && !horas[st]) horas[st] = formatarHora(h.criado_em || h.created_at);
    if (st === 'CANCELADO' && h.motivo) motivoCancel = h.motivo;
  }
  const cancelado = d.status === 'CANCELADO';
  const timeline = cancelado ? '' : `<div class="timeline">${etapasBase.map((st, i) => `
    <div class="tl-etapa ${i < idxAtual ? 'feita' : ''} ${i === idxAtual ? 'atual feita' : ''}">
      <span class="tl-bola">${i < idxAtual || i === idxAtual ? '✓' : ''}</span>
      <div class="tl-textos">
        <div class="tl-nome">${NOMES_ETAPA[st]}</div>
        ${horas[st] ? `<div class="tl-hora">às ${horas[st]}</div>` : ''}
      </div>
    </div>`).join('')}</div>`;

  /* pagamento online */
  const pag = d.pagamento || ultimoPagamento;
  const pagStatus = d.pagamento_status || (pag && pag.status);
  const online = ONLINE_SET.has(d.forma_pagamento) || !!pag;
  let pagHTML = '';
  if (online && pagStatus === 'pago') {
    pagHTML = '<div class="pago-box">💰 Pagamento online confirmado ✅</div>';
  } else if (online && pagStatus === 'pendente') {
    pagHTML = `<div class="pagamento-box">
      <h3>⏳ Aguardando pagamento</h3>
      <p>Seu pedido já está reservado. Pague para confirmarmos tudo por aqui:</p>
      ${pag && pag.qr_texto ? `<div class="qr-texto" id="qr-texto">${esc(pag.qr_texto)}</div>
        <button type="button" class="btn-secundario" id="btn-copiar-qr">📋 Copiar código Pix</button>` : ''}
      ${pag && pag.link_pagamento ? `<br><a class="btn-primario" style="display:inline-flex;align-items:center;text-decoration:none;margin-top:12px" href="${esc(pag.link_pagamento)}" target="_blank" rel="noopener">💳 Pagar agora</a>` : ''}
      ${!pag || (!pag.qr_texto && !pag.link_pagamento) ? '<p>Gerando os dados de pagamento… atualizando automaticamente.</p>' : ''}
    </div>`;
  } else if (online && (pagStatus === 'falhou' || pagStatus === 'erro_config')) {
    pagHTML = `<div class="cancelado-box">❌ Houve um problema com o pagamento online. Não se preocupe: a loja vai te chamar no WhatsApp para combinar outra forma. 💜</div>`;
  }

  const itensHTML = (d.itens || []).map((it) => {
    const nome = it.nome_snapshot || it.nome || 'Item';
    const unit = it.preco_unitario_centavos != null ? it.preco_unitario_centavos : (it.preco_centavos || 0);
    const sub = it.subtotal_centavos != null ? it.subtotal_centavos : unit * (it.quantidade || 1);
    const ops = linhasOpcoesPedido(it);
    return `<div class="acomp-item">
      <div class="acomp-item-nome"><span>${it.quantidade || 1}× ${esc(nome)}</span><span>${R$(sub)}</span></div>
      ${ops ? `<p class="acomp-item-ops">${esc(ops)}</p>` : ''}
      ${it.observacao ? `<p class="acomp-item-ops">“${esc(it.observacao)}”</p>` : ''}
    </div>`;
  }).join('');

  const rotuloPag = ROTULOS_PAG[d.forma_pagamento] || d.forma_pagamento || '';
  const zapLoja = loja && loja.whatsapp ? soDigitos(loja.whatsapp) : '';
  cont.innerHTML = `
  <div class="acomp-card">
    <div class="acomp-numero">Pedido #${d.numero}</div>
    <p class="acomp-status-txt">${esc(STATUS_TXT[d.status] || d.status)}</p>
    ${cancelado ? `<div class="cancelado-box">Pedido cancelado${motivoCancel ? ` — ${esc(motivoCancel)}` : ''}.</div>` : timeline}
    ${pagHTML}
    <h3 class="detalhes-titulo" style="margin-top:20px">Detalhes</h3>
    ${itensHTML}
    <div style="margin-top:10px">
      <div class="detalhe-linha"><span>Subtotal</span><span>${R$(d.subtotal_centavos || 0)}</span></div>
      <div class="detalhe-linha"><span>Taxa de entrega</span><span>${d.tipo === 'retirada' ? 'Retirada' : R$(d.taxa_entrega_centavos || 0)}</span></div>
      <div class="detalhe-linha"><span><strong>Total</strong></span><span><strong>${R$(d.total_centavos || 0)}</strong></span></div>
      ${rotuloPag ? `<div class="detalhe-linha"><span>Pagamento</span><span>${esc(rotuloPag)}${d.troco_para_centavos ? ` • troco para ${R$(d.troco_para_centavos)}` : ''}</span></div>` : ''}
      ${d.tipo === 'entrega' && enderecoTextoPedido(d) ? `<div class="detalhe-linha"><span>Entrega em</span><span style="text-align:right">${esc(enderecoTextoPedido(d))}</span></div>` : ''}
    </div>
    ${zapLoja ? `<a class="btn-zap" href="https://wa.me/${zapLoja}?text=${encodeURIComponent(`Oi! É sobre meu pedido #${d.numero} 🙂`)}" target="_blank" rel="noopener">💬 Chamar a loja no WhatsApp</a>` : ''}
    <button type="button" class="btn-secundario" id="btn-novo-pedido" style="width:100%">🫐 Fazer um novo pedido</button>
  </div>`;
  const btnCopiar = $('#btn-copiar-qr');
  if (btnCopiar) btnCopiar.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#qr-texto').textContent.trim()); toast('Código Pix copiado! 📋'); }
    catch { toast('Selecione o código e copie manualmente.'); }
  });
  const btnNovo = $('#btn-novo-pedido');
  if (btnNovo) btnNovo.addEventListener('click', () => { location.hash = '#/'; });
}
async function carregarAcompanhamento() {
  if (!tokenAcomp) return;
  try {
    const d = await getJSON('/api/public/pedidos/' + encodeURIComponent(tokenAcomp));
    renderAcompanhamento(d);
    if (d.status === 'ENTREGUE' || d.status === 'CANCELADO') pararPolling();
  } catch {
    $('#acompanhamento').innerHTML = '<div class="acomp-card"><p class="acomp-status-txt">Não encontramos este pedido. Confira o link ou chame a loja no WhatsApp. 💜</p></div>';
    pararPolling();
  }
}
function pararPolling() { if (timerAcomp) { clearInterval(timerAcomp); timerAcomp = null; } }
function iniciarAcompanhamento(token) {
  tokenAcomp = token;
  pararPolling();
  carregarAcompanhamento();
  timerAcomp = setInterval(carregarAcompanhamento, 5000);
}

/* ============================================================
   ROTEADOR (hash)
   ============================================================ */
function roteador() {
  const m = location.hash.match(/^#\/pedido\/(.+)$/);
  if (m) {
    $('#view-loja').hidden = true;
    $('#view-pedido').hidden = false;
    renderBarraCarrinho();
    window.scrollTo(0, 0);
    iniciarAcompanhamento(decodeURIComponent(m[1]));
  } else {
    pararPolling();
    tokenAcomp = null;
    $('#view-pedido').hidden = true;
    $('#view-loja').hidden = false;
    renderBarraCarrinho();
  }
}
window.addEventListener('hashchange', roteador);
$('#btn-voltar-loja').addEventListener('click', () => { location.hash = '#/'; });

document.addEventListener('DOMContentLoaded', iniciar);

'use strict';
// Módulo Financeiro (v1.1) — controle interno da loja + calculadora de lucro real.
// TODAS as agregações do dia vivem aqui: GET /financeiro/calculo e o PDF do
// relatório consomem ESTAS funções (uma fonte só de cálculo).
// Dinheiro sempre em centavos (inteiro). Lançamentos usam data TEXTO YYYY-MM-DD
// escolhida pelo usuário; pedidos são filtrados pelo dia LOCAL:
// date(created_at,'localtime')=?  (nunca date(created_at) puro — bug do fuso).
const { get, all, run, execSql, modoBanco } = require('./db');

if (modoBanco() === 'sqlite') execSql(`
CREATE TABLE IF NOT EXISTS fin_lancamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  tipo TEXT NOT NULL, -- investimento | receita_manual | despesa
  categoria TEXT, descricao TEXT,
  valor_centavos INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL, -- YYYY-MM-DD
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fin_insumos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  nome TEXT NOT NULL, quantidade REAL NOT NULL DEFAULT 0, unidade TEXT,
  custo_total_centavos INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL, -- YYYY-MM-DD
  created_at TEXT DEFAULT (datetime('now'))
);
`);

const TIPOS_LANCAMENTO = ['investimento', 'receita_manual', 'despesa'];
const DIA_PEDIDOS = "date(p.created_at,'localtime')=?";

// ---------- datas ----------
function dataHoje() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dataValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(a, m - 1, d);
  return dt.getFullYear() === a && dt.getMonth() === m - 1 && dt.getDate() === d;
}
function dataBR(s) { // YYYY-MM-DD -> DD/MM/YYYY
  const [a, m, d] = String(s || '').split('-');
  return a && m && d ? `${d}/${m}/${a}` : String(s || '');
}
// round half up (valores aqui são >= 0)
const roundHU = (x) => Math.floor(Number(x) + 0.5);

// ---------- validação ----------
function erro422(msg) { const e = new Error(msg); e.status = 422; return e; }
function validarLancamento(c) {
  if (!TIPOS_LANCAMENTO.includes(c.tipo)) throw erro422('Tipo de lançamento inválido. Use investimento, receita_manual ou despesa.');
  if (!Number.isInteger(c.valor_centavos) || c.valor_centavos <= 0) throw erro422('Informe um valor maior que zero.');
  if (!dataValida(c.data)) throw erro422('Data inválida. Use o formato AAAA-MM-DD.');
}
function validarInsumo(c) {
  if (!c.nome || !String(c.nome).trim()) throw erro422('Informe o nome do insumo.');
  if (!(Number(c.quantidade) > 0)) throw erro422('Informe uma quantidade maior que zero.');
  if (!Number.isInteger(c.custo_total_centavos) || c.custo_total_centavos <= 0) throw erro422('Informe um custo total maior que zero.');
  if (!dataValida(c.data)) throw erro422('Data inválida. Use o formato AAAA-MM-DD.');
}

// ---------- lançamentos ----------
async function listarLancamentos({ data, tipo } = {}) {
  const cond = ['loja_id=1'];
  const params = [];
  if (data) { cond.push('data=?'); params.push(data); }
  if (tipo) { cond.push('tipo=?'); params.push(tipo); }
  return await all(`SELECT * FROM fin_lancamentos WHERE ${cond.join(' AND ')} ORDER BY data DESC, id DESC LIMIT 200`, ...params);
}
async function criarLancamento(corpo) {
  const c = {
    tipo: String(corpo.tipo || ''),
    categoria: corpo.categoria != null ? String(corpo.categoria) : '',
    descricao: corpo.descricao != null ? String(corpo.descricao) : '',
    valor_centavos: Number(corpo.valor_centavos),
    data: corpo.data ? String(corpo.data) : dataHoje(),
  };
  validarLancamento(c);
  const info = await run('INSERT INTO fin_lancamentos (loja_id, tipo, categoria, descricao, valor_centavos, data) VALUES (1, ?, ?, ?, ?, ?)',
    c.tipo, c.categoria, c.descricao, c.valor_centavos, c.data);
  return get('SELECT * FROM fin_lancamentos WHERE id=?', Number(info.lastInsertRowid));
}
async function atualizarLancamento(id, corpo) {
  const atual = await get('SELECT * FROM fin_lancamentos WHERE id=?', id);
  if (!atual) return null;
  const c = {
    tipo: corpo.tipo !== undefined ? String(corpo.tipo) : atual.tipo,
    categoria: corpo.categoria !== undefined ? String(corpo.categoria) : atual.categoria,
    descricao: corpo.descricao !== undefined ? String(corpo.descricao) : atual.descricao,
    valor_centavos: corpo.valor_centavos !== undefined ? Number(corpo.valor_centavos) : atual.valor_centavos,
    data: corpo.data !== undefined ? String(corpo.data) : atual.data,
  };
  validarLancamento(c);
  await run('UPDATE fin_lancamentos SET tipo=?, categoria=?, descricao=?, valor_centavos=?, data=? WHERE id=?',
    c.tipo, c.categoria, c.descricao, c.valor_centavos, c.data, id);
  return get('SELECT * FROM fin_lancamentos WHERE id=?', id);
}
async function excluirLancamento(id) {
  return Number((await run('DELETE FROM fin_lancamentos WHERE id=?', id)).changes) > 0;
}

// ---------- insumos ----------
async function listarInsumos({ data } = {}) {
  if (data) return await all('SELECT * FROM fin_insumos WHERE loja_id=1 AND data=? ORDER BY id DESC LIMIT 200', data);
  return await all('SELECT * FROM fin_insumos WHERE loja_id=1 ORDER BY data DESC, id DESC LIMIT 200');
}
async function criarInsumo(corpo) {
  const c = {
    nome: corpo.nome != null ? String(corpo.nome).trim() : '',
    quantidade: Number(corpo.quantidade),
    unidade: corpo.unidade != null ? String(corpo.unidade) : '',
    custo_total_centavos: Number(corpo.custo_total_centavos),
    data: corpo.data ? String(corpo.data) : dataHoje(),
  };
  validarInsumo(c);
  const info = await run('INSERT INTO fin_insumos (loja_id, nome, quantidade, unidade, custo_total_centavos, data) VALUES (1, ?, ?, ?, ?, ?)',
    c.nome, c.quantidade, c.unidade, c.custo_total_centavos, c.data);
  return get('SELECT * FROM fin_insumos WHERE id=?', Number(info.lastInsertRowid));
}
async function atualizarInsumo(id, corpo) {
  const atual = await get('SELECT * FROM fin_insumos WHERE id=?', id);
  if (!atual) return null;
  const c = {
    nome: corpo.nome !== undefined ? String(corpo.nome).trim() : atual.nome,
    quantidade: corpo.quantidade !== undefined ? Number(corpo.quantidade) : atual.quantidade,
    unidade: corpo.unidade !== undefined ? String(corpo.unidade) : atual.unidade,
    custo_total_centavos: corpo.custo_total_centavos !== undefined ? Number(corpo.custo_total_centavos) : atual.custo_total_centavos,
    data: corpo.data !== undefined ? String(corpo.data) : atual.data,
  };
  validarInsumo(c);
  await run('UPDATE fin_insumos SET nome=?, quantidade=?, unidade=?, custo_total_centavos=?, data=? WHERE id=?',
    c.nome, c.quantidade, c.unidade, c.custo_total_centavos, c.data, id);
  return get('SELECT * FROM fin_insumos WHERE id=?', id);
}
async function excluirInsumo(id) {
  return Number((await run('DELETE FROM fin_insumos WHERE id=?', id)).changes) > 0;
}

// ---------- cálculo do dia (FONTE ÚNICA — /calculo e PDF) ----------
async function calcular(data) {
  const vendas = await get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(p.total_centavos),0) AS s,
            COALESCE(SUM(p.taxa_entrega_centavos),0) AS taxas,
            COALESCE(SUM(CASE WHEN p.tipo='entrega' THEN 1 ELSE 0 END),0) AS entregas
       FROM pedidos p
      WHERE p.loja_id=1 AND ${DIA_PEDIDOS} AND p.status='ENTREGUE'`, data);
  const cancelados = (await get(
    `SELECT COUNT(*) AS c FROM pedidos p WHERE p.loja_id=1 AND ${DIA_PEDIDOS} AND p.status='CANCELADO'`, data)).c;
  const copos = (await get(
    `SELECT COALESCE(SUM(pi.quantidade),0) AS q
       FROM pedido_itens pi JOIN pedidos p ON p.id=pi.pedido_id
      WHERE p.loja_id=1 AND ${DIA_PEDIDOS} AND p.status='ENTREGUE'`, data)).q;
  const somaTipo = async (tipo) => (await get('SELECT COALESCE(SUM(valor_centavos),0) AS s FROM fin_lancamentos WHERE loja_id=1 AND tipo=? AND data=?', tipo, data)).s;
  const receita_manual = await somaTipo('receita_manual');
  const investimento_manual = await somaTipo('investimento');
  const despesas = await somaTipo('despesa');
  const insumos_total = (await get('SELECT COALESCE(SUM(custo_total_centavos),0) AS s FROM fin_insumos WHERE loja_id=1 AND data=?', data)).s;

  const vendas_sistema = vendas.s;
  const pedidos_concluidos = vendas.c;
  const receita_total = vendas_sistema + receita_manual;
  const custo_total = insumos_total + despesas + investimento_manual;
  const lucro_real = receita_total - custo_total;
  const preco_medio_copo = copos > 0 ? roundHU(vendas_sistema / copos) : 0;
  const custo_por_copo = copos > 0 ? roundHU(custo_total / copos) : 0;

  return {
    data,
    vendas_sistema,
    pedidos_concluidos,
    cancelados,
    copos,
    taxas_entrega: vendas.taxas,
    entregas: vendas.entregas,
    receita_manual,
    receita_total,
    investimento_manual,
    insumos_total,
    despesas,
    custo_total,
    lucro_real,
    preco_medio_copo,
    custo_por_copo,
    lucro_por_copo: preco_medio_copo - custo_por_copo,
    custo_medio_entrega: vendas.entregas > 0 ? roundHU(despesas / vendas.entregas) : 0,
  };
}

// ---------- resumo do relatório (tela + PDF, mesmo dia) ----------
const FAMILIA_PAGAMENTO = `COALESCE(NULLIF(p.forma_pagamento,''),
  CASE WHEN p.metodo_pagamento LIKE 'pix%' THEN 'pix'
       WHEN p.metodo_pagamento LIKE 'cartao%' THEN 'cartao'
       ELSE 'dinheiro' END)`;
async function resumoRelatorio(data) {
  const calc = await calcular(data);
  const top_produtos = await all(
    `SELECT pi.nome_snapshot AS nome, SUM(pi.quantidade) AS qtd, SUM(pi.subtotal_centavos) AS valor_centavos
       FROM pedido_itens pi JOIN pedidos p ON p.id=pi.pedido_id
      WHERE p.loja_id=1 AND ${DIA_PEDIDOS} AND p.status='ENTREGUE'
      GROUP BY pi.nome_snapshot ORDER BY qtd DESC LIMIT 10`, data);
  const top_opcoes = await all(
    `SELECT po.opcao_nome AS nome, COUNT(*) AS qtd
       FROM pedido_item_opcoes po
       JOIN pedido_itens pi ON pi.id=po.pedido_item_id
       JOIN pedidos p ON p.id=pi.pedido_id
      WHERE p.loja_id=1 AND ${DIA_PEDIDOS} AND p.status='ENTREGUE'
      GROUP BY po.opcao_nome ORDER BY qtd DESC LIMIT 10`, data);
  const familias = { pix: { pedidos: 0, valor_centavos: 0 }, dinheiro: { pedidos: 0, valor_centavos: 0 }, cartao: { pedidos: 0, valor_centavos: 0 } };
  for (const r of await all(
    `SELECT ${FAMILIA_PAGAMENTO} AS familia, COUNT(*) AS c, COALESCE(SUM(p.total_centavos),0) AS s
       FROM pedidos p WHERE p.loja_id=1 AND ${DIA_PEDIDOS} AND p.status='ENTREGUE'
      GROUP BY familia`, data)) {
    if (familias[r.familia]) familias[r.familia] = { pedidos: r.c, valor_centavos: r.s };
  }
  return {
    data,
    pedidos_concluidos: calc.pedidos_concluidos,
    cancelados: calc.cancelados,
    faturamento_centavos: calc.vendas_sistema,
    ticket_medio_centavos: calc.pedidos_concluidos ? roundHU(calc.vendas_sistema / calc.pedidos_concluidos) : 0,
    top_produtos,
    top_opcoes,
    por_pagamento: familias,
    financeiro: calc,
  };
}

// ---------- PDF do relatório ----------
const fmtMoeda = (cent) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(cent || 0) / 100);
function gerarPdfRelatorio(resumo, nomeLoja, res) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="relatorio-${resumo.data}.pdf"`);
  doc.pipe(res);

  const ROXO = '#7E047D', ESCURO = '#2A0530', CINZA = '#666666';
  const fin = resumo.financeiro;
  const linha = (rotulo, valor, opts = {}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 11)
      .fillColor(opts.color || ESCURO)
      .text(rotulo, 48, doc.y, { continued: true })
      .text(valor, { align: 'right' });
    doc.moveDown(opts.gap != null ? opts.gap : 0.25);
  };
  const titulo = (t) => {
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(13).fillColor(ROXO).text(t);
    doc.moveTo(48, doc.y + 2).lineTo(547, doc.y + 2).strokeColor(ROXO).lineWidth(1).stroke();
    doc.moveDown(0.5).fillColor(ESCURO);
  };

  // Cabeçalho
  doc.font('Helvetica-Bold').fontSize(20).fillColor(ROXO).text(nomeLoja || 'Loja');
  doc.font('Helvetica').fontSize(13).fillColor(ESCURO).text(`Relatório do dia — ${dataBR(resumo.data)}`);
  doc.moveDown(0.4);

  titulo('VENDAS');
  linha('Pedidos concluídos', String(resumo.pedidos_concluidos));
  linha('Pedidos cancelados', String(resumo.cancelados));
  linha('Faturamento', fmtMoeda(resumo.faturamento_centavos), { bold: true });
  linha('Ticket médio', fmtMoeda(resumo.ticket_medio_centavos));

  titulo('POR FORMA DE PAGAMENTO');
  linha('Pix', `${resumo.por_pagamento.pix.pedidos} pedido(s) — ${fmtMoeda(resumo.por_pagamento.pix.valor_centavos)}`);
  linha('Dinheiro', `${resumo.por_pagamento.dinheiro.pedidos} pedido(s) — ${fmtMoeda(resumo.por_pagamento.dinheiro.valor_centavos)}`);
  linha('Cartão', `${resumo.por_pagamento.cartao.pedidos} pedido(s) — ${fmtMoeda(resumo.por_pagamento.cartao.valor_centavos)}`);

  titulo('TOP PRODUTOS');
  if (!resumo.top_produtos.length) doc.font('Helvetica').fontSize(11).text('Nenhuma venda concluída neste dia.');
  for (const p of resumo.top_produtos) linha(`${p.nome} × ${p.qtd}`, fmtMoeda(p.valor_centavos));

  titulo('TOP OPÇÕES');
  if (!resumo.top_opcoes.length) doc.font('Helvetica').fontSize(11).text('Nenhuma opção registrada neste dia.');
  for (const o of resumo.top_opcoes) linha(`${o.nome}`, `× ${o.qtd}`);

  titulo('FINANCEIRO DO DIA');
  linha('Vendas do sistema', fmtMoeda(fin.vendas_sistema));
  linha('Receitas manuais', fmtMoeda(fin.receita_manual));
  linha('Receita acumulada', fmtMoeda(fin.receita_total), { bold: true });
  linha('Investimento', fmtMoeda(fin.investimento_manual));
  linha('Insumos', fmtMoeda(fin.insumos_total));
  linha('Despesas', fmtMoeda(fin.despesas));
  linha('Custo total', fmtMoeda(fin.custo_total));
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(fin.lucro_real >= 0 ? '#1A7F37' : '#C0392B')
    .text(`LUCRO REAL: ${fmtMoeda(fin.lucro_real)}`);
  doc.font('Helvetica').fontSize(11).fillColor(ESCURO)
    .text(`Custo por copo: ${fmtMoeda(fin.custo_por_copo)} · Preço médio por copo: ${fmtMoeda(fin.preco_medio_copo)} · Lucro por copo: ${fmtMoeda(fin.lucro_por_copo)}`);

  // Rodapé
  const agoraLocal = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  doc.font('Helvetica').fontSize(9).fillColor(CINZA)
    .text(`Gerado em ${agoraLocal} — Sistema de Pedidos`, 48, 780, { align: 'center' });
  doc.end();
}

module.exports = {
  TIPOS_LANCAMENTO, dataHoje, dataValida, dataBR, roundHU,
  listarLancamentos, criarLancamento, atualizarLancamento, excluirLancamento,
  listarInsumos, criarInsumo, atualizarInsumo, excluirInsumo,
  calcular, resumoRelatorio, gerarPdfRelatorio,
};

'use strict';
// Comanda térmica 80mm (48 colunas) — texto puro; envio ESC/POS bruto via TCP 9100 se configurado.
const net = require('net');
const { fmtBRL } = require('./util');

const L = 48;
const linha = (ch = '-') => ch.repeat(L);
const centro = (t) => { t = String(t); const p = Math.max(0, Math.floor((L - t.length) / 2)); return ' '.repeat(p) + t; };
const dois = (a, b) => { a = String(a); b = String(b); return a + ' '.repeat(Math.max(1, L - a.length - b.length)) + b; };

function montarComanda(pedido) {
  const out = [];
  out.push(linha('='));
  out.push(centro('ACAI DO GURI'));
  out.push(centro(`PEDIDO #${pedido.numero}`));
  // created_at é guardado em UTC — a comanda imprime no horário de Brasília.
  let data = String(pedido.created_at || '').slice(0, 16).replace('T', ' ');
  try {
    let s = String(pedido.created_at || '');
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    const d = new Date(s);
    if (!isNaN(d)) {
      const p = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
      data = p.replace(',', '');
    }
  } catch { /* mantém o texto original */ }
  out.push(centro(`${data}   ${pedido.tipo === 'entrega' ? 'ENTREGA' : 'RETIRADA'}`));
  out.push(linha('='));
  out.push(`Cliente: ${pedido.cliente_nome}`);
  out.push(`Tel: ${pedido.cliente_whatsapp}`);
  out.push(linha());
  for (const it of pedido.itens || []) {
    out.push(`${it.quantidade}x ${String(it.nome_snapshot).toUpperCase()}`);
    for (const o of it.opcoes || []) {
      out.push(`   + ${o.opcao_nome} ${o.preco_adicional_centavos > 0 ? `(+${fmtBRL(o.preco_adicional_centavos)})` : '(incluso)'}`);
    }
    if (it.observacao) out.push(`   *** OBS: ${String(it.observacao).toUpperCase()}`);
  }
  if (pedido.tipo === 'entrega') {
    out.push(linha());
    const e = pedido.endereco || {};
    out.push('Endereco: ' + [e.rua, e.numero].filter(Boolean).join(', '));
    if (e.complemento) out.push('Compl.: ' + e.complemento);
    out.push(`Bairro: ${pedido.bairro_nome || ''}${e.referencia ? '  Ref: ' + e.referencia : ''}`);
  }
  if (pedido.observacao) { out.push(linha()); out.push(`*** OBS GERAL: ${String(pedido.observacao).toUpperCase()}`); }
  out.push(linha());
  out.push(dois('Subtotal:', fmtBRL(pedido.subtotal_centavos)));
  if (pedido.taxa_entrega_centavos) out.push(dois('Entrega:', fmtBRL(pedido.taxa_entrega_centavos)));
  out.push(dois('TOTAL:', fmtBRL(pedido.total_centavos)));
  out.push(`Pagamento: ${String(pedido.forma_pagamento || '').toUpperCase()}`);
  if (pedido.forma_pagamento === 'dinheiro' && pedido.troco_para_centavos) {
    out.push(`*** TROCO PARA ${fmtBRL(pedido.troco_para_centavos)}`);
    out.push(`*** TROCO: ${fmtBRL(pedido.troco_para_centavos - pedido.total_centavos)}`);
  }
  out.push(linha('='));
  out.push('');
  return out.join('\n');
}

function enviarParaImpressora(texto) {
  return new Promise((resolve) => {
    const ip = process.env.IMPRESSORA_IP;
    if (!ip) return resolve({ enviado: false, motivo: 'IMPRESSORA_IP não configurado' });
    const sock = net.connect(9100, ip);
    const fim = (r) => { try { sock.destroy(); } catch {} resolve(r); };
    sock.setTimeout(3000);
    sock.on('connect', () => {
      const escpos = Buffer.concat([
        Buffer.from([0x1b, 0x40]), // ESC @ init
        Buffer.from(texto.normalize('NFD').replace(/[̀-ͯ]/g, ''), 'latin1'),
        Buffer.from([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00]), // feed + corte
      ]);
      sock.end(escpos, () => fim({ enviado: true }));
    });
    sock.on('timeout', () => fim({ enviado: false, motivo: 'timeout na impressora' }));
    sock.on('error', (e) => fim({ enviado: false, motivo: String(e.message || e) }));
  });
}

module.exports = { montarComanda, enviarParaImpressora };

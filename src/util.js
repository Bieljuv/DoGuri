'use strict';
const crypto = require('crypto');

const fmtBRL = (cent) => 'R$ ' + (Number(cent || 0) / 100).toFixed(2).replace('.', ',');
const agora = () => new Date().toISOString();
const tokenAleatorio = (bytes = 18) => crypto.randomBytes(bytes).toString('hex');

function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(senha), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verificaSenha(senha, guardado) {
  try {
    const [saltHex, hashHex] = String(guardado).split(':');
    const esperado = Buffer.from(hashHex, 'hex');
    const calc = crypto.scryptSync(String(senha), Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(esperado, calc);
  } catch { return false; }
}

// Carrega .env simples (sem dependência) — só define o que ainda não existe no ambiente.
function carregarEnv(arquivo) {
  const fs = require('fs');
  try {
    for (const linha of fs.readFileSync(arquivo, 'utf8').split('\n')) {
      const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sem .env, tudo bem */ }
}

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
function normalizaFone(s) {
  let d = soDigitos(s);
  if (d && !d.startsWith('55')) d = '55' + d;
  return d;
}

// Mascara credencial para exibição: "••••••••a1b2"
function mascarar(valor) {
  if (!valor) return '';
  const v = String(valor);
  return '••••••••' + v.slice(-4);
}
const ehMascarado = (v) => typeof v === 'string' && v.includes('•');

function lojaEstaAberta(loja) {
  if (!loja) return { aberta: false, pausada: false, mensagem: 'Loja não encontrada.' };
  const agoraDate = new Date();
  if (loja.pausada_ate && new Date(loja.pausada_ate) > agoraDate) {
    return { aberta: false, pausada: true, mensagem: 'Loja pausada no momento. Voltamos já!' };
  }
  if (!loja.aberta_manual) return { aberta: false, pausada: false, mensagem: 'Loja fechada no momento.' };
  // horário simples no fuso local do servidor (America/Sao_Paulo na implantação)
  const hhmm = agoraDate.toTimeString().slice(0, 5);
  const abre = loja.horario_abre || '00:00', fecha = loja.horario_fecha || '23:59';
  const dentro = abre <= fecha ? (hhmm >= abre && hhmm <= fecha) : (hhmm >= abre || hhmm <= fecha);
  if (!dentro) return { aberta: false, pausada: false, mensagem: `Fechado agora — abrimos às ${abre}.` };
  return { aberta: true, pausada: false, mensagem: 'Aberto agora' };
}

module.exports = { fmtBRL, agora, tokenAleatorio, hashSenha, verificaSenha, carregarEnv, soDigitos, normalizaFone, mascarar, ehMascarado, lojaEstaAberta };

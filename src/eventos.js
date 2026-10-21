'use strict';
// Barramento simples de eventos para o SSE do painel.
const clientes = new Set();
function registrarCliente(res) { clientes.add(res); res.on('close', () => clientes.delete(res)); }
function emitir(tipo, dados) {
  const payload = `event: ${tipo}\ndata: ${JSON.stringify(dados || {})}\n\n`;
  for (const res of clientes) { try { res.write(payload); } catch { clientes.delete(res); } }
}
module.exports = { registrarCliente, emitir };

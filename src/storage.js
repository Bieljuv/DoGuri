'use strict';
// Uploads com driver trocável (STORAGE_DRIVER=local|supabase).
// A rota POST /api/painel/upload mantém sempre o mesmo contrato de resposta: { url }.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const driver = () => (process.env.STORAGE_DRIVER || 'local').toLowerCase();
const supabaseConfigurado = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY && process.env.SUPABASE_BUCKET);

function nomeArquivo(original) {
  const ext = (path.extname(original || '') || '.bin').toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

async function salvarArquivo(buffer, originalName, mimetype) {
  const nome = nomeArquivo(originalName);
  if (driver() === 'supabase') {
    if (!supabaseConfigurado()) throw new Error('STORAGE_DRIVER=supabase mas SUPABASE_URL/SUPABASE_SERVICE_KEY/SUPABASE_BUCKET não estão configurados.');
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const bucket = process.env.SUPABASE_BUCKET;
    const resp = await fetch(`${base}/storage/v1/object/${bucket}/${nome}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        apikey: process.env.SUPABASE_SERVICE_KEY,
        'Content-Type': mimetype || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: buffer,
    });
    if (!resp.ok) throw new Error('Supabase Storage HTTP ' + resp.status + ': ' + (await resp.text().catch(() => '')).slice(0, 200));
    return { url: `${base}/storage/v1/object/public/${bucket}/${nome}` };
  }
  // local (padrão)
  fs.writeFileSync(path.join(UPLOAD_DIR, nome), buffer);
  return { url: '/uploads/' + nome };
}

module.exports = { salvarArquivo, driver, supabaseConfigurado, UPLOAD_DIR };

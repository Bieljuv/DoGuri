'use strict';
// ============================================================================
// DAL — ÚNICO ponto de acesso ao banco do projeto (nenhum outro módulo abre
// conexão nem monta driver).
//
// Dois modos, MESMA interface async (get/all/run/execSql/init/tx/fechar):
//   • SQLite   — SEM DATABASE_URL: node:sqlite em data/pedidos.db.
//                DDL + seed rodam no require, como sempre foi.
//   • Postgres — COM DATABASE_URL: driver `pg` (pensado pro Supabase).
//                O schema vem de supabase/schema.sql (colar no SQL Editor);
//                o init() só confere as tabelas e semeia se estiver vazio.
//
// O SQL das rotas/serviços é escrito num subconjunto portátil (placeholders
// "?"); no modo Postgres a tradução de dialeto acontece aqui dentro:
//   ?                    -> $1..$n
//   datetime('now')      -> now()
//   date(x,'localtime')  -> (x AT TIME ZONE 'America/Sao_Paulo')::date
//   INSERT OR IGNORE     -> INSERT ... ON CONFLICT DO NOTHING
// ============================================================================
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');

// O server.js carrega o .env DEPOIS de importar este módulo; aqui carregamos
// antes de decidir o modo, pra DATABASE_URL do .env valer também.
try { require('./util').carregarEnv(path.join(__dirname, '..', '.env')); } catch { /* sem .env, ok */ }

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const MODO = DATABASE_URL ? 'postgres' : 'sqlite';
function modoBanco() { return MODO; }

// Hash scrypt de 'admin123' — FIXO de propósito: o mesmo valor semeia os dois
// bancos, para o login inicial ser idêntico em qualquer modo.
const ADMIN_HASH = '8e1a98a161dbddc9bc5fb5de2b595183:54a534beeaa72ce721f888c19abd4d66cbd38f1a355f6e5102d1f936292f7d363fb1631fdc22ca7bed2d9972151dabae79cd3bdec42c4e92fc77161083bf87cd';

const DDL_SQLITE = `
CREATE TABLE IF NOT EXISTS lojas (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  slug TEXT UNIQUE,
  logo_url TEXT, capa_url TEXT,
  whatsapp TEXT, instagram TEXT, endereco_texto TEXT,
  tempo_preparo_min INTEGER DEFAULT 20,
  tempo_entrega_min INTEGER DEFAULT 40,
  pedido_minimo_centavos INTEGER DEFAULT 0,
  taxa_unica_centavos INTEGER,
  chave_pix TEXT,
  email_pedidos TEXT,
  aberta_manual INTEGER DEFAULT 1,
  horario_abre TEXT DEFAULT '13:00',
  horario_fecha TEXT DEFAULT '23:00',
  som_pedido TEXT DEFAULT 'padrao',
  pausada_ate TEXT,
  proximo_numero INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id INTEGER NOT NULL DEFAULT 1,
  nome TEXT NOT NULL, login TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL, perfil TEXT DEFAULT 'admin', ativo INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL,
  criado_em TEXT DEFAULT (datetime('now')), expira_em TEXT
);
CREATE TABLE IF NOT EXISTS categorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  nome TEXT NOT NULL, ordem INTEGER DEFAULT 0, ativa INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  categoria_id INTEGER, nome TEXT NOT NULL, descricao TEXT,
  foto_url TEXT, preco_base_centavos INTEGER NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL DEFAULT 'simples', destaque INTEGER DEFAULT 0,
  ativo INTEGER DEFAULT 1, esgotado INTEGER DEFAULT 0, ordem INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS grupos_opcoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  nome TEXT NOT NULL, tipo_escolha TEXT NOT NULL DEFAULT 'multipla',
  minimo INTEGER DEFAULT 0, maximo INTEGER,
  obrigatorio INTEGER DEFAULT 0, excedente_vira_pago INTEGER DEFAULT 0,
  preco_excedente_centavos INTEGER DEFAULT 0, ativo INTEGER DEFAULT 1, ordem INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS opcoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, grupo_id INTEGER NOT NULL,
  nome TEXT NOT NULL, preco_adicional_centavos INTEGER NOT NULL DEFAULT 0,
  ativa INTEGER DEFAULT 1, esgotada INTEGER DEFAULT 0, ordem INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS produto_grupos (
  produto_id INTEGER NOT NULL, grupo_id INTEGER NOT NULL, ordem INTEGER DEFAULT 0,
  PRIMARY KEY (produto_id, grupo_id)
);
CREATE TABLE IF NOT EXISTS bairros (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  bairro TEXT NOT NULL, taxa_centavos INTEGER NOT NULL DEFAULT 0, ativo INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  nome TEXT, whatsapp TEXT NOT NULL, bloqueado INTEGER DEFAULT 0,
  total_pedidos INTEGER DEFAULT 0, total_cancelamentos INTEGER DEFAULT 0,
  UNIQUE(loja_id, whatsapp)
);
CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  numero INTEGER NOT NULL, token TEXT UNIQUE NOT NULL,
  cliente_id INTEGER, cliente_nome TEXT, cliente_whatsapp TEXT,
  tipo TEXT NOT NULL DEFAULT 'entrega',
  bairro_id INTEGER, bairro_nome TEXT, endereco_json TEXT,
  status TEXT NOT NULL DEFAULT 'NOVO',
  subtotal_centavos INTEGER NOT NULL DEFAULT 0,
  taxa_entrega_centavos INTEGER NOT NULL DEFAULT 0,
  desconto_centavos INTEGER NOT NULL DEFAULT 0,
  total_centavos INTEGER NOT NULL DEFAULT 0,
  forma_pagamento TEXT, metodo_pagamento TEXT,
  pagamento_status TEXT DEFAULT 'nao_aplicavel',
  troco_para_centavos INTEGER, observacao TEXT,
  motivo_cancelamento TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(loja_id, numero)
);
CREATE TABLE IF NOT EXISTS pedido_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL,
  produto_id INTEGER, nome_snapshot TEXT, preco_unitario_centavos INTEGER NOT NULL DEFAULT 0,
  quantidade INTEGER NOT NULL DEFAULT 1, subtotal_centavos INTEGER NOT NULL DEFAULT 0,
  observacao TEXT
);
CREATE TABLE IF NOT EXISTS pedido_item_opcoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_item_id INTEGER NOT NULL,
  grupo_nome TEXT, opcao_nome TEXT, preco_adicional_centavos INTEGER NOT NULL DEFAULT 0,
  excedente INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pedido_status_historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL,
  de_status TEXT, para_status TEXT NOT NULL, origem TEXT DEFAULT 'painel',
  motivo TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notificacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  pedido_id INTEGER, canal TEXT NOT NULL, -- whatsapp_cliente | whatsapp_empresa | telegram_dono
  destino TEXT, corpo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente', -- pendente | enviada | falhou | simulada
  tentativas INTEGER DEFAULT 0, ultimo_erro TEXT,
  externa_ref TEXT,
  created_at TEXT DEFAULT (datetime('now')), enviada_em TEXT
);
CREATE TABLE IF NOT EXISTS impressoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL,
  tipo TEXT DEFAULT 'comanda', status TEXT DEFAULT 'registrada', erro TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS config_recebimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER NOT NULL DEFAULT 1,
  meio TEXT NOT NULL UNIQUE, -- pix_presencial | cartao_presencial | dinheiro | mercadopago | asaas
  ativo INTEGER DEFAULT 0, ambiente TEXT DEFAULT 'sandbox',
  credenciais_json TEXT DEFAULT '{}', -- TODO: criptografar em repouso numa fase futura
  extra_json TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL,
  meio TEXT, provedor TEXT DEFAULT 'interno',
  valor_centavos INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'nao_aplicavel',
  externo_id TEXT, qr_texto TEXT, link_pagamento TEXT,
  ultimo_evento TEXT,
  criado_em TEXT DEFAULT (datetime('now')), atualizado_em TEXT DEFAULT (datetime('now'))
);
`;

// ---------------------------------------------------------------------------
// Modo SQLite — conexão única, DDL no require (inalterado da v1)
// ---------------------------------------------------------------------------
let sq = null;
if (MODO === 'sqlite') {
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = path.join(__dirname, '..', 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sq = new DatabaseSync(path.join(DATA_DIR, 'pedidos.db'));
  sq.exec('PRAGMA journal_mode = WAL;');
  sq.exec('PRAGMA foreign_keys = ON;');
  sq.exec(DDL_SQLITE);
  // Bancos criados antes da v1.2: adiciona a coluna do som de pedido, se faltar.
  try { sq.exec("ALTER TABLE lojas ADD COLUMN som_pedido TEXT DEFAULT 'padrao'"); } catch { /* coluna já existe */ }
}

// ---------------------------------------------------------------------------
// Modo Postgres — pool `pg` + tradução de dialeto + tipos
// ---------------------------------------------------------------------------
let pool = null;
const als = new AsyncLocalStorage(); // contexto da transação PG (client dedicado)

function isoTimestamptz(v) {
  // pg devolve timestamptz como texto 'AAAA-MM-DD HH:MM:SS.ffffff+00' (ou -03,
  // +05:30...). O front já lê ISO com fuso: trocamos o espaço por 'T' e
  // normalizamos o offset final pra ±HH:MM. NUNCA devolver objeto Date.
  let s = String(v).replace(' ', 'T');
  if (!s.endsWith('Z')) {
    const m = s.match(/([+-]\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/);
    if (m) s = s.slice(0, s.length - m[0].length) + m[1] + ':' + (m[2] || '00');
  }
  return s;
}

if (MODO === 'postgres') {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8 (COUNT/SUM/id) -> Number
  types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric -> Number
  types.setTypeParser(1184, (v) => (v === null ? null : isoTimestamptz(v))); // timestamptz -> string ISO
  let ssl;
  try {
    const host = new URL(DATABASE_URL).hostname;
    ssl = (host === 'localhost' || host === '127.0.0.1' || host === '::1') ? undefined : { rejectUnauthorized: false };
  } catch { ssl = { rejectUnauthorized: false }; }
  pool = new Pool({ connectionString: DATABASE_URL, max: 5, ssl });
  pool.on('error', (e) => console.error('[banco] erro no pool Postgres:', e.message));
}

function traduzirPg(sqlBruto) {
  let sql = String(sqlBruto);
  let orIgnore = false;
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql)) {
    sql = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    orIgnore = true;
  }
  sql = sql.replace(/date\(\s*'now'\s*,\s*'localtime'\s*\)/gi, "(now() AT TIME ZONE 'America/Sao_Paulo')::date");
  sql = sql.replace(/date\(\s*([A-Za-z_][\w.]*)\s*,\s*'localtime'\s*\)/gi, "($1 AT TIME ZONE 'America/Sao_Paulo')::date");
  sql = sql.replace(/datetime\(\s*'now'\s*\)/gi, 'now()');
  if (orIgnore) sql += ' ON CONFLICT DO NOTHING';
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

function normParamPg(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  return v;
}

async function pgQuery(sqlTraduzido, params) {
  const norm = (params || []).map(normParamPg);
  const store = als.getStore();
  if (store && store.client) return store.client.query(sqlTraduzido, norm);
  return pool.query(sqlTraduzido, norm);
}
async function pgExec(sqlBruto, params) {
  return pgQuery(traduzirPg(sqlBruto), params);
}

// Tabelas cuja PK NÃO é uma coluna `id` (RETURNING id não se aplica a elas).
const TABELAS_SEM_ID = new Set(['produto_grupos', 'sessoes']);

// ---------------------------------------------------------------------------
// Interface async única (os dois modos)
// ---------------------------------------------------------------------------
async function get(sql, ...params) {
  if (MODO === 'sqlite') return sq.prepare(sql).get(...params);
  const r = await pgExec(sql, params);
  return r.rows[0];
}

async function all(sql, ...params) {
  if (MODO === 'sqlite') return sq.prepare(sql).all(...params);
  const r = await pgExec(sql, params);
  return r.rows;
}

async function run(sql, ...params) {
  if (MODO === 'sqlite') {
    const r = sq.prepare(sql).run(...params);
    return {
      lastInsertRowid: typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid,
      changes: Number(r.changes),
    };
  }
  // Traduz ANTES de anexar o RETURNING: o "ON CONFLICT DO NOTHING" (vindo do
  // INSERT OR IGNORE) precisa ficar antes do RETURNING na sintaxe do Postgres.
  let final = traduzirPg(sql);
  let retornoId = false;
  const m = final.match(/^\s*INSERT\s+INTO\s+["']?([A-Za-z_][\w]*)/i);
  if (m && !/RETURNING/i.test(final) && !TABELAS_SEM_ID.has(m[1].toLowerCase())) {
    final += ' RETURNING id';
    retornoId = true;
  }
  const r = await pgQuery(final, params);
  return {
    lastInsertRowid: retornoId && r.rows && r.rows[0] ? r.rows[0].id : null,
    changes: r.rowCount || 0,
  };
}

async function execSql(sql) {
  if (MODO === 'sqlite') { sq.exec(sql); return; }
  await pgExec(sql, []);
}

const api = { get, all, run };

// tx(fn): fn recebe q = {get, all, run}. Execuções são serializadas por uma
// fila simples — no SQLite a conexão é única (intercalar BEGINs quebraria) e
// no PG a serialização é inofensiva nesta escala.
let filaTx = Promise.resolve();
function tx(fn) {
  const p = filaTx.then(() => txInterno(fn), () => txInterno(fn));
  filaTx = p.then(() => undefined, () => undefined);
  return p;
}
async function txInterno(fn) {
  if (MODO === 'sqlite') {
    sq.exec('BEGIN');
    try {
      const r = await fn(api);
      sq.exec('COMMIT');
      return r;
    } catch (e) {
      try { sq.exec('ROLLBACK'); } catch { /* já revertido */ }
      throw e;
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await als.run({ client }, () => fn(api));
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* já revertido */ }
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Seed — MESMOS valores nos dois bancos (loja, admin, cardápio de exemplo)
// ---------------------------------------------------------------------------
function seedSqlite() {
  const loja = sq.prepare('SELECT id FROM lojas LIMIT 1').get();
  if (loja) return false;

  sq.exec('BEGIN');
  try {
    sq.prepare(`INSERT INTO lojas (id, nome, slug, logo_url, whatsapp, instagram, aberta_manual, horario_abre, horario_fecha)
      VALUES (1, 'Açaí do Guri', 'acai-do-guri', '/uploads/seed-logo.png', '5547999842490', '@acaidoguri.bc', 1, '13:00', '23:00')`).run();
    sq.prepare(`INSERT INTO usuarios (loja_id, nome, login, senha_hash, perfil) VALUES (1, 'Administrador', 'admin', ?, 'admin')`).run(ADMIN_HASH);

    const cat = sq.prepare('INSERT INTO categorias (loja_id, nome, ordem) VALUES (1, ?, ?)');
    const c1 = cat.run('Monte seu Açaí', 1).lastInsertRowid;
    const c2 = cat.run('Prontos e Combos', 2).lastInsertRowid;
    const c3 = cat.run('Bebidas', 3).lastInsertRowid;

    const grp = sq.prepare(`INSERT INTO grupos_opcoes (loja_id, nome, tipo_escolha, minimo, maximo, obrigatorio, excedente_vira_pago, preco_excedente_centavos, ordem)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const gTam = grp.run('Tamanho', 'unica', 1, 1, 1, 0, 0, 1).lastInsertRowid;
    const gAcomp = grp.run('Acompanhamentos inclusos (até 3)', 'multipla', 0, 3, 0, 0, 0, 2).lastInsertRowid;
    const gAdic = grp.run('Adicionais', 'multipla', 0, null, 0, 0, 0, 3).lastInsertRowid;
    const gCalda = grp.run('Calda', 'unica', 0, 1, 0, 0, 0, 4).lastInsertRowid;

    const opc = sq.prepare('INSERT INTO opcoes (grupo_id, nome, preco_adicional_centavos, ordem) VALUES (?, ?, ?, ?)');
    opc.run(gTam, '300ml', 1800, 1); opc.run(gTam, '500ml', 2500, 2); opc.run(gTam, '700ml', 3200, 3);
    ['Leite Ninho', 'Leite em Pó', 'Banana', 'Morango', 'Granola', 'Paçoca', 'Sucrilhos', 'Amendoim']
      .forEach((n, i) => opc.run(gAcomp, n, 0, i + 1));
    [['Nutella', 600], ['Creme de Ninho', 500], ['Morango Extra', 500], ['Bis', 300], ['Ovomaltine', 400], ['Leite Condensado Extra', 300]]
      .forEach(([n, p], i) => opc.run(gAdic, n, p, i + 1));
    ['Chocolate', 'Morango', 'Leite Condensado', 'Sem Calda'].forEach((n, i) => opc.run(gCalda, n, 0, i + 1));

    const prod = sq.prepare(`INSERT INTO produtos (loja_id, categoria_id, nome, descricao, preco_base_centavos, tipo, destaque, ordem)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)`);
    const p1 = prod.run(c1, 'Monte seu Açaí', 'Escolha o tamanho, os acompanhamentos e os adicionais do seu jeito.', 0, 'montavel', 1, 1).lastInsertRowid;
    const p2 = prod.run(c2, 'Açaí Trufado (exemplo)', 'Açaí com creme trufado da casa.', 2800, 'montavel', 0, 1).lastInsertRowid;
    prod.run(c3, 'Água de Coco 500ml (exemplo)', 'Garrafa 500ml gelada.', 800, 'simples', 0, 1);
    prod.run(c3, 'Refrigerante Lata (exemplo)', 'Lata 350ml.', 600, 'simples', 0, 2);

    const pg = sq.prepare('INSERT INTO produto_grupos (produto_id, grupo_id, ordem) VALUES (?, ?, ?)');
    pg.run(p1, gTam, 1); pg.run(p1, gAcomp, 2); pg.run(p1, gAdic, 3); pg.run(p1, gCalda, 4);
    pg.run(p2, gTam, 1); pg.run(p2, gAdic, 2);

    const bai = sq.prepare('INSERT INTO bairros (loja_id, bairro, taxa_centavos) VALUES (1, ?, ?)');
    bai.run('Centro', 500); bai.run('Barra Sul', 700); bai.run('Municípios', 800);

    // Meios de recebimento (contrato § Meios de Recebimento)
    const rec = sq.prepare('INSERT INTO config_recebimentos (loja_id, meio, ativo, ambiente, extra_json) VALUES (1, ?, ?, ?, ?)');
    rec.run('pix_presencial', 1, 'producao', JSON.stringify({ chave_pix: '' }));
    rec.run('cartao_presencial', 1, 'producao', '{}');
    rec.run('dinheiro', 1, 'producao', JSON.stringify({ aceita_troco: true }));
    rec.run('mercadopago', 0, 'sandbox', '{}');
    rec.run('asaas', 0, 'sandbox', '{}');

    sq.exec('COMMIT');
    return true;
  } catch (e) {
    sq.exec('ROLLBACK');
    throw e;
  }
}

async function seedPg() {
  await tx(async (q) => {
    await q.run(`INSERT INTO lojas (id, nome, slug, logo_url, whatsapp, instagram, aberta_manual, horario_abre, horario_fecha)
      VALUES (1, 'Açaí do Guri', 'acai-do-guri', '/uploads/seed-logo.png', '5547999842490', '@acaidoguri.bc', 1, '13:00', '23:00')`);
    // id explícito na loja: realinha a sequence pra não colidir no futuro.
    await q.run("SELECT setval(pg_get_serial_sequence('lojas','id'), (SELECT COALESCE(MAX(id), 1) FROM lojas))");
    await q.run(`INSERT INTO usuarios (loja_id, nome, login, senha_hash, perfil) VALUES (1, 'Administrador', 'admin', ?, 'admin')`, ADMIN_HASH);

    const cat = 'INSERT INTO categorias (loja_id, nome, ordem) VALUES (1, ?, ?)';
    const c1 = Number((await q.run(cat, 'Monte seu Açaí', 1)).lastInsertRowid);
    const c2 = Number((await q.run(cat, 'Prontos e Combos', 2)).lastInsertRowid);
    const c3 = Number((await q.run(cat, 'Bebidas', 3)).lastInsertRowid);

    const grp = `INSERT INTO grupos_opcoes (loja_id, nome, tipo_escolha, minimo, maximo, obrigatorio, excedente_vira_pago, preco_excedente_centavos, ordem)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const gTam = Number((await q.run(grp, 'Tamanho', 'unica', 1, 1, 1, 0, 0, 1)).lastInsertRowid);
    const gAcomp = Number((await q.run(grp, 'Acompanhamentos inclusos (até 3)', 'multipla', 0, 3, 0, 0, 0, 2)).lastInsertRowid);
    const gAdic = Number((await q.run(grp, 'Adicionais', 'multipla', 0, null, 0, 0, 0, 3)).lastInsertRowid);
    const gCalda = Number((await q.run(grp, 'Calda', 'unica', 0, 1, 0, 0, 0, 4)).lastInsertRowid);

    const opc = 'INSERT INTO opcoes (grupo_id, nome, preco_adicional_centavos, ordem) VALUES (?, ?, ?, ?)';
    await q.run(opc, gTam, '300ml', 1800, 1); await q.run(opc, gTam, '500ml', 2500, 2); await q.run(opc, gTam, '700ml', 3200, 3);
    const acomp = ['Leite Ninho', 'Leite em Pó', 'Banana', 'Morango', 'Granola', 'Paçoca', 'Sucrilhos', 'Amendoim'];
    for (let i = 0; i < acomp.length; i++) await q.run(opc, gAcomp, acomp[i], 0, i + 1);
    const adic = [['Nutella', 600], ['Creme de Ninho', 500], ['Morango Extra', 500], ['Bis', 300], ['Ovomaltine', 400], ['Leite Condensado Extra', 300]];
    for (let i = 0; i < adic.length; i++) await q.run(opc, gAdic, adic[i][0], adic[i][1], i + 1);
    const caldas = ['Chocolate', 'Morango', 'Leite Condensado', 'Sem Calda'];
    for (let i = 0; i < caldas.length; i++) await q.run(opc, gCalda, caldas[i], 0, i + 1);

    const prod = `INSERT INTO produtos (loja_id, categoria_id, nome, descricao, preco_base_centavos, tipo, destaque, ordem)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)`;
    const p1 = Number((await q.run(prod, c1, 'Monte seu Açaí', 'Escolha o tamanho, os acompanhamentos e os adicionais do seu jeito.', 0, 'montavel', 1, 1)).lastInsertRowid);
    const p2 = Number((await q.run(prod, c2, 'Açaí Trufado (exemplo)', 'Açaí com creme trufado da casa.', 2800, 'montavel', 0, 1)).lastInsertRowid);
    await q.run(prod, c3, 'Água de Coco 500ml (exemplo)', 'Garrafa 500ml gelada.', 800, 'simples', 0, 1);
    await q.run(prod, c3, 'Refrigerante Lata (exemplo)', 'Lata 350ml.', 600, 'simples', 0, 2);

    const pg = 'INSERT INTO produto_grupos (produto_id, grupo_id, ordem) VALUES (?, ?, ?)';
    await q.run(pg, p1, gTam, 1); await q.run(pg, p1, gAcomp, 2); await q.run(pg, p1, gAdic, 3); await q.run(pg, p1, gCalda, 4);
    await q.run(pg, p2, gTam, 1); await q.run(pg, p2, gAdic, 2);

    const bai = 'INSERT INTO bairros (loja_id, bairro, taxa_centavos) VALUES (1, ?, ?)';
    await q.run(bai, 'Centro', 500); await q.run(bai, 'Barra Sul', 700); await q.run(bai, 'Municípios', 800);

    // Meios de recebimento (contrato § Meios de Recebimento)
    const rec = 'INSERT INTO config_recebimentos (loja_id, meio, ativo, ambiente, extra_json) VALUES (1, ?, ?, ?, ?)';
    await q.run(rec, 'pix_presencial', 1, 'producao', JSON.stringify({ chave_pix: '' }));
    await q.run(rec, 'cartao_presencial', 1, 'producao', '{}');
    await q.run(rec, 'dinheiro', 1, 'producao', JSON.stringify({ aceita_troco: true }));
    await q.run(rec, 'mercadopago', 0, 'sandbox', '{}');
    await q.run(rec, 'asaas', 0, 'sandbox', '{}');
  });
}

async function seed() {
  if (MODO === 'sqlite') return seedSqlite();
  const tem = await get('SELECT id FROM lojas LIMIT 1');
  if (tem) return false;
  await seedPg();
  return true;
}

// ---------------------------------------------------------------------------
// init() / fechar()
// ---------------------------------------------------------------------------
async function init() {
  if (MODO === 'sqlite') { seedSqlite(); return; }
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    throw new Error('Não consegui conectar no Postgres da DATABASE_URL: ' + e.message);
  }
  const reg = await pool.query("SELECT to_regclass('public.lojas') AS t");
  if (!reg.rows[0] || !reg.rows[0].t) {
    throw new Error('O Postgres está sem as tabelas do sistema. Rode o arquivo supabase/schema.sql no SQL Editor do Supabase (ou no seu Postgres) e suba o app de novo.');
  }
  if (await seed()) console.log('[banco] Postgres vazio — seed inicial aplicado (loja de exemplo + admin/admin123).');
}

async function fechar() {
  if (MODO === 'postgres') { if (pool) await pool.end(); return; }
  if (sq) { try { sq.close(); } catch { /* já fechado */ } }
}

module.exports = {
  db: MODO === 'sqlite' ? sq : pool, // compat: instância SQLite ou pool PG
  seed, ADMIN_HASH, get, all, run, execSql, init, tx, modoBanco, fechar,
};

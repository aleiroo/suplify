const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const Database = require('better-sqlite3');
const { CATALOG, FALLBACK } = require('./data');

const PORT = process.env.PORT || 3000;
const KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const DB_FILE = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','kitchen','supplier')), name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ingredients(id TEXT PRIMARY KEY, name TEXT NOT NULL, alias TEXT DEFAULT '', yield REAL DEFAULT 1, kkal REAL DEFAULT 0, protein REAL DEFAULT 0, fat REAL DEFAULT 0, carbs REAL DEFAULT 0, ref_price REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE REFERENCES users(id), name TEXT NOT NULL, address TEXT DEFAULT '', lat REAL, lng REAL, phone TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS stocks(id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE, ingredient_id TEXT NOT NULL REFERENCES ingredients(id), quantity_kg REAL NOT NULL DEFAULT 0, price_per_kg REAL NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(supplier_id,ingredient_id));
CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_portions REAL NOT NULL DEFAULT 1,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id TEXT REFERENCES ingredients(id),
  ingredient_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL
);
`);

const bcrypt = require('bcryptjs');

const insertIngredient = db.prepare(`
  INSERT OR IGNORE INTO ingredients
  (id,name,alias,yield,kkal,protein,fat,carbs,ref_price)
  VALUES(@id,@name,@alias,@yield,@kkal,@protein,@fat,@carbs,@ref_price)
`);

const countUsers = db.prepare('SELECT COUNT(*) n FROM users').get().n;

if (!countUsers) {
  const addUser = db.prepare(
    'INSERT INTO users(username,password_hash,role,name) VALUES(?,?,?,?)'
  );

  addUser.run('admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin12345', 10), 'admin', 'Administrator');
  addUser.run('dapur', bcrypt.hashSync(process.env.KITCHEN_PASSWORD || 'dapur12345', 10), 'kitchen', 'Dapur Demo');
  addUser.run('supplier', bcrypt.hashSync(process.env.SUPPLIER_PASSWORD || 'supplier12345', 10), 'supplier', 'Supplier Demo');
}

const seed = db.transaction(() => {
  for (const c of CATALOG) {
    insertIngredient.run({
      id: c.id,
      name: c.name,
      alias: c.alias,
      yield: c.yield,
      kkal: c.n[0],
      protein: c.n[1],
      fat: c.n[2],
      carbs: c.n[3],
      ref_price: c.ref
    });
  }

  const user = db.prepare(
    "SELECT id FROM users WHERE username='supplier'"
  ).get();

  let supplier = db.prepare(
    'SELECT id FROM suppliers WHERE user_id=?'
  ).get(user.id);

  if (!supplier) {
    const r = db.prepare(
      'INSERT INTO suppliers(user_id,name,address,lat,lng,phone) VALUES(?,?,?,?,?,?)'
    ).run(user.id, 'Supplier Demo', 'Tangerang, Banten', -6.1783, 106.6319, '');

    supplier = { id: r.lastInsertRowid };

    const add = db.prepare(
      'INSERT OR IGNORE INTO stocks(supplier_id,ingredient_id,quantity_kg,price_per_kg) VALUES(?,?,?,?)'
    );

    for (const c of CATALOG) {
      add.run(supplier.id, c.id, 100, c.ref);
    }
  }
});

seed();

const json = (res, status, obj) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
};

const readBody = req => new Promise((resolve, reject) => {
  let raw = '';

  req.on('data', c => {
    raw += c;
    if (raw.length > 1e6) reject(new Error('Payload terlalu besar'));
  });

  req.on('end', () => {
    try {
      resolve(JSON.parse(raw || '{}'));
    } catch {
      reject(new Error('JSON tidak valid'));
    }
  });
});

const authUser = req => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!token) return null;

  const row = db.prepare(`
    SELECT users.*, sessions.token
    FROM sessions
    JOIN users ON users.id=sessions.user_id
    WHERE sessions.token=? AND sessions.expires_at>?
  `).get(token, Date.now());

  return row || null;
};

const requireRole = (u, roles) => !!u && roles.includes(u.role);

const norm = s => String(s || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const lex = name => {
  const q = norm(name);
  let best = null;
  let score = 0;

  for (const c of db.prepare('SELECT * FROM ingredients').all()) {
    const words = new Set(norm(c.name + ' ' + c.alias).split(' '));
    const qwords = q.split(' ');

    let s = q === norm(c.name)
      ? 1
      : qwords.filter(w => words.has(w)).length / Math.max(1, qwords.length);

    if (norm(c.name).includes(q) || q.includes(norm(c.name))) {
      s = Math.max(s, .9);
    }

    if (s > score) {
      score = s;
      best = c;
    }
  }

  return score >= 0.45 ? best : null;
};

async function groqRecipe(menuNames) {
  const prompt = `Anda adalah chef profesional katering Indonesia dan ahli gizi.

TUGAS:
Buat resep yang BENAR-BENAR sesuai dengan nama menu yang diminta.

MENU:
${menuNames.join('; ')}

ATURAN WAJIB:
1. Setiap menu harus memiliki resep sendiri dan tidak boleh tercampur dengan menu lain.
2. Jangan memasukkan bahan dari menu lain.
3. Gunakan bahan yang secara kuliner memang diperlukan untuk menu tersebut.
4. Jangan menambahkan lauk, daging, ikan, udang, tahu, atau tempe pada minuman kecuali memang bagian dari nama menu.
5. Untuk minuman, gunakan bahan minuman yang sesuai. Contoh Es Jeruk: jeruk, air, gula, dan es batu.
6. Jangan membuat variasi menu sendiri.
7. Takaran adalah gram bahan mentah untuk satu porsi dewasa.
8. Maksimal 12 bahan per menu.
9. Jika tidak yakin dengan resep suatu menu, jangan mengarang. Kembalikan ingredients sebagai array kosong.
10. Nama menu pada hasil harus sama dengan nama menu yang diminta.

FORMAT JAWABAN:
Balas hanya JSON valid seperti ini:
{"menus":[{"menu":"nama menu persis","ingredients":[{"name":"nama bahan","net_g":angka}]}]}`;

  let response;

  try {
    response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${KEY}`
        },
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' }
        })
      }
    );
  } catch (e) {
    console.error('Detail koneksi Groq:', e);
    throw new Error(
      `Koneksi Groq gagal: ${e.cause?.code || e.code || e.message}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Groq API ${response.status}: ${await response.text()}`
    );
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '{}';

  return JSON.parse(content).menus || [];
}

function fallbackRecipe(name) {
  const n = norm(name);
  const key = Object.keys(FALLBACK).find(k => norm(k) === n);

  if (key) {
    return FALLBACK[key].map(([id, net_g]) => ({
      name: db.prepare('SELECT name FROM ingredients WHERE id=?').get(id)?.name || id,
      net_g
    }));
  }

  return [];
}

async function createPlan(menus, userId) {
  let generated = null;
  let aiError = null;

  if (KEY) {
    try {
      generated = await groqRecipe(menus.map(m => m.name));
    } catch (e) {
      aiError = e.message;
      console.error('Groq:', e.message);
    }
  }

  const resultMenus = [];
  const need = new Map();
  const warnings = [];

  for (let ix = 0; ix < menus.length; ix++) {
    const m = menus[ix];
    let ingredients = generated?.[ix]?.ingredients;
    let source = 'groq';

    if (!Array.isArray(ingredients) || !ingredients.length) {
      ingredients = fallbackRecipe(m.name);
      source = ingredients.length ? 'fallback-demo' : 'unavailable';
    }

    if (source === 'unavailable') {
      warnings.push(
        `Resep "${m.name}" tidak berhasil dibuat. Periksa koneksi/API Groq atau masukkan menu yang lebih spesifik.`
      );
    }

    const total = [0, 0, 0, 0];
    const used = [];

    for (const item of (ingredients || []).slice(0, 18)) {
      const grams = Math.max(1, Math.min(500, Number(item.net_g) || 0));
      const c = lex(item.name);
      const gross = c ? grams / c.yield : grams;

      const key = c
        ? `catalog:${c.id}`
        : `custom:${norm(item.name)}`;

      const entry = need.get(key) || {
        id: c?.id || null,
        name: c?.name || String(item.name).trim(),
        kg: 0,
        ref: c ? c.ref_price : null,
        unit: 'kg',
        catalog: !!c
      };

      entry.kg += gross * m.portions / 1000;
      need.set(key, entry);

      if (c) {
        total[0] += c.kkal * grams / 100;
        total[1] += c.protein * grams / 100;
        total[2] += c.fat * grams / 100;
        total[3] += c.carbs * grams / 100;
      }

      used.push({
        id: c?.id || null,
        name: c?.name || String(item.name).trim(),
        net_g: Math.round(grams),
        gross_g: Math.round(gross),
        yield: c?.yield ?? null,
        catalog: !!c
      });
    }

    resultMenus.push({
      name: m.name,
      portions: m.portions,
      source,
      nutrition: {
        kkal: Math.round(total[0]),
        protein: +total[1].toFixed(1),
        lemak: +total[2].toFixed(1),
        karbo: +total[3].toFixed(1)
      },
      ingredients: used
    });
  }

  const items = [...need.values()].map(it => ({
    ...it,
    kg: Math.ceil(it.kg * 100) / 100
  }));

  if (aiError) {
    warnings.unshift(
      `Groq gagal dihubungi (${aiError}). Sistem hanya memakai resep demo yang tersedia; menu lain tidak ditebak.`
    );
  }

  if (!KEY) {
    warnings.unshift(
      'GROQ_API_KEY belum diisi. Hanya resep demo yang tersedia; aktifkan API untuk menu bebas.'
    );
  }

  const payload = {
    menus: resultMenus,
    items,
    warnings,
    aiStatus: generated ? 'groq' : (KEY ? 'fallback' : 'offline')
  };

  db.prepare(
    'INSERT INTO plans(user_id,payload) VALUES(?,?)'
  ).run(userId, JSON.stringify(payload));

  return payload;
}

// Menghitung ranking supplier.
// Bahan nonkatalog tidak masuk perbandingan stok supplier,
// tetapi tetap dikirim sebagai peringatan terpisah.
function supplierRanking(items, unmatched = []) {
  const suppliers = db.prepare(`
    SELECT s.*,u.name AS account_name
    FROM suppliers s
    LEFT JOIN users u ON u.id=s.user_id
  `).all();

  const rows = suppliers.map(s => {
    let requested = 0;
    let filled = 0;
    let total = 0;
    let ref = 0;

    const missing = [];
    const available = [];

    for (const it of items) {
      requested++;

      const st = db.prepare(`
        SELECT quantity_kg,price_per_kg
        FROM stocks
        WHERE supplier_id=? AND ingredient_id=?
      `).get(s.id, it.id);

      const stockQty = st ? Math.max(0, Number(st.quantity_kg)) : 0;
      const requiredQty = Number(it.kg);
      const got = Math.min(stockQty, requiredQty);

      if (got > 0) {
        filled += got / requiredQty;
        total += got * Number(st.price_per_kg || 0);
        ref += got * Number(it.ref || 0);

        available.push({
          id: it.id,
          name: it.name,
          required: requiredQty,
          available: got,
          shortage: Math.max(0, requiredQty - got),
          price_per_kg: Number(st.price_per_kg || 0)
        });
      } else {
        missing.push({
          id: it.id,
          name: it.name,
          required: requiredQty,
          available: 0,
          shortage: requiredQty,
          reason: 'Tidak tersedia'
        });
      }

      if (got > 0 && got < requiredQty) {
        missing.push({
          id: it.id,
          name: it.name,
          required: requiredQty,
          available: got,
          shortage: requiredQty - got,
          reason: 'Stok tidak mencukupi'
        });
      }
    }

    const km = (s.lat == null || s.lng == null)
      ? null
      : Math.round(
          Math.hypot(
            (s.lat + 6.1783) * 111,
            (s.lng - 106.6319) * 111
          ) * 10
        ) / 10;

    const fill = requested ? filled / requested : 0;

    return {
      id: s.id,
      name: s.name,
      address: s.address,
      phone: s.phone,
      fill,
      matchedCount: requested,
      availableCount: available.length,
      missingCount: missing.length,
      km,
      total: Math.round(total),
      pidx: ref ? total / ref : 1,
      available,
      missing,
      unmatched
    };
  });

  const maxKm = Math.max(1, ...rows.map(r => r.km ?? 10000));
  const maxPrice = Math.max(1, ...rows.map(r => r.pidx));

  rows.forEach(r => {
    r.score = +(
      100 * (
        .5 * r.fill +
        .2 * (1 - (r.km ?? maxKm) / maxKm) +
        .3 * (1 - r.pidx / maxPrice)
      )
    ).toFixed(1);
  });

  return rows.sort((a, b) => b.score - a.score);
}

const staticDir = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const b = await readBody(req);
      const u = db.prepare(
        'SELECT * FROM users WHERE username=?'
      ).get(String(b.username || ''));

      if (!u || !bcrypt.compareSync(String(b.password || ''), u.password_hash)) {
        return json(res, 401, { error: 'Username atau password salah' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expires = Date.now() + 12 * 60 * 60 * 1000;

      db.prepare(
        'INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)'
      ).run(token, u.id, expires);

      return json(res, 200, {
        token,
        user: {
          id: u.id,
          username: u.username,
          name: u.name,
          role: u.role
        },
        ai: KEY ? 'groq' : 'offline',
        model: KEY ? MODEL : null
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/register') {
      const b = await readBody(req);
      const username = String(b.username || '').trim();
      const password = String(b.password || '');

      if (username.length < 3 || password.length < 8) {
        return json(res, 400, {
          error: 'Username minimal 3 karakter dan password minimal 8 karakter'
        });
      }

      try {
        const info = db.prepare(
          'INSERT INTO users(username,password_hash,role,name) VALUES(?,?,?,?)'
        ).run(
          username,
          bcrypt.hashSync(password, 10),
          'supplier',
          String(b.name || username).slice(0, 100)
        );

        const sup = db.prepare(
          'INSERT INTO suppliers(user_id,name,address,lat,lng,phone) VALUES(?,?,?,?,?,?)'
        ).run(
          info.lastInsertRowid,
          String(b.name || username).slice(0, 100),
          String(b.address || ''),
          Number.isFinite(+b.lat) ? +b.lat : null,
          Number.isFinite(+b.lng) ? +b.lng : null,
          String(b.phone || '')
        );

        const token = crypto.randomBytes(32).toString('hex');

        db.prepare(
          'INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)'
        ).run(token, info.lastInsertRowid, Date.now() + 43200000);

        return json(res, 201, {
          token,
          user: {
            id: info.lastInsertRowid,
            username,
            name: b.name || username,
            role: 'supplier'
          }
        });
      } catch (e) {
        return json(res, 409, {
          error: 'Username sudah digunakan atau data tidak valid'
        });
      }
    }

    const user = authUser(req);

    if (!user) {
      return json(res, 401, {
        error: 'Sesi tidak valid. Silakan masuk kembali.'
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      db.prepare('DELETE FROM sessions WHERE token=?').run(
        (req.headers.authorization || '').replace(/^Bearer\s+/, '')
      );
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/catalog') {
      return json(res, 200, {
        items: db.prepare(
          'SELECT id,name,ref_price AS ref FROM ingredients ORDER BY name'
        ).all()
      });
    }

  // Daftar resep milik pengguna dapur
  if (req.method === 'GET' && url.pathname === '/api/recipes') {
    if (!requireRole(user, ['kitchen', 'admin'])) {
      return json(res, 403, { error: 'Akses khusus dapur/admin' });
    }

    const recipes = db.prepare(`
      SELECT r.id,r.name,r.base_portions,r.notes,r.created_at,
      COUNT(ri.id) AS ingredient_count
      FROM recipes r
      LEFT JOIN recipe_ingredients ri ON ri.recipe_id=r.id
      WHERE r.user_id=?
      GROUP BY r.id
      ORDER BY r.updated_at DESC
    `).all(user.id);

    return json(res, 200, { recipes });
  }

  // Detail satu resep
  if (req.method === 'GET' && /^\/api\/recipes\/\d+$/.test(url.pathname)) {
    if (!requireRole(user, ['kitchen', 'admin'])) {
      return json(res, 403, { error: 'Akses khusus dapur/admin' });
    }

    const id = Number(url.pathname.split('/').pop());
    const recipe = db.prepare(
      'SELECT * FROM recipes WHERE id=? AND user_id=?'
    ).get(id, user.id);

    if (!recipe) {
      return json(res, 404, { error: 'Resep tidak ditemukan' });
    }

    const ingredients = db.prepare(`
      SELECT id,ingredient_id,ingredient_name,quantity,unit
      FROM recipe_ingredients
      WHERE recipe_id=?
      ORDER BY id
    `).all(id);

    return json(res, 200, { recipe, ingredients });
  }

  // Simpan resep baru
  if (req.method === 'POST' && url.pathname === '/api/recipes') {
    if (!requireRole(user, ['kitchen', 'admin'])) {
      return json(res, 403, { error: 'Akses khusus dapur/admin' });
    }

    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 100);
    const basePortions = Number(b.base_portions);
    const notes = String(b.notes || '').slice(0, 500);
    const ingredients = Array.isArray(b.ingredients) ? b.ingredients : [];

    if (!name) return json(res, 400, { error: 'Nama resep wajib diisi' });
    if (!Number.isFinite(basePortions) || basePortions <= 0) {
      return json(res, 400, { error: 'Jumlah porsi dasar tidak valid' });
    }
    if (!ingredients.length) {
      return json(res, 400, { error: 'Isi minimal satu bahan' });
    }

    const prepared = [];

    for (const item of ingredients) {
      const ingredientName = String(
        item.ingredient_name || item.name || ''
      ).trim().slice(0, 100);

      const quantity = Number(item.quantity);
      const unit = String(item.unit || '').trim().slice(0, 20);

      if (!ingredientName || !Number.isFinite(quantity) || quantity <= 0 || !unit) {
        return json(res, 400, {
          error: 'Data bahan, jumlah, atau satuan tidak valid'
        });
      }

      let ingredientId = item.ingredient_id
        ? String(item.ingredient_id)
        : null;

      if (ingredientId && !db.prepare(
        'SELECT id FROM ingredients WHERE id=?'
      ).get(ingredientId)) {
        return json(res, 400, { error: 'ID bahan tidak ditemukan di katalog' });
      }

      if (!ingredientId) {
        const match = db.prepare(
          'SELECT id FROM ingredients WHERE LOWER(name)=LOWER(?)'
        ).get(ingredientName);

        if (match) ingredientId = match.id;
      }

      prepared.push({ ingredientId, ingredientName, quantity, unit });
    }

    const saveRecipe = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO recipes(user_id,name,base_portions,notes)
        VALUES(?,?,?,?)
      `).run(user.id, name, basePortions, notes);

      const recipeId = result.lastInsertRowid;

      const insertIngredient = db.prepare(`
        INSERT INTO recipe_ingredients
        (recipe_id,ingredient_id,ingredient_name,quantity,unit)
        VALUES(?,?,?,?,?)
      `);

      for (const item of prepared) {
        insertIngredient.run(
          recipeId,
          item.ingredientId,
          item.ingredientName,
          item.quantity,
          item.unit
        );
      }

      return recipeId;
    });

    const id = saveRecipe();

    return json(res, 201, {
      ok: true,
      id,
      message: 'Resep berhasil disimpan'
    });
  }

  // Edit resep yang sudah tersimpan
  if (req.method === 'PUT' && /^\/api\/recipes\/\d+$/.test(url.pathname)) {
    if (!requireRole(user, ['kitchen', 'admin'])) {
      return json(res, 403, { error: 'Akses khusus dapur/admin' });
    }

    const id = Number(url.pathname.split('/').pop());
    const recipe = db.prepare(
      'SELECT id FROM recipes WHERE id=? AND user_id=?'
    ).get(id, user.id);

    if (!recipe) {
      return json(res, 404, { error: 'Resep tidak ditemukan' });
    }

    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 100);
    const basePortions = Number(b.base_portions);
    const notes = String(b.notes || '').slice(0, 500);
    const ingredients = Array.isArray(b.ingredients) ? b.ingredients : [];

    if (!name) return json(res, 400, { error: 'Nama resep wajib diisi' });
    if (!Number.isFinite(basePortions) || basePortions <= 0) {
      return json(res, 400, { error: 'Jumlah porsi dasar tidak valid' });
    }
    if (!ingredients.length) {
      return json(res, 400, { error: 'Isi minimal satu bahan' });
    }

    const prepared = [];

    for (const item of ingredients) {
      const ingredientName = String(
        item.ingredient_name || item.name || ''
      ).trim().slice(0, 100);

      const quantity = Number(item.quantity);
      const unit = String(item.unit || '').trim().slice(0, 20);

      if (!ingredientName || !Number.isFinite(quantity) || quantity <= 0 || !unit) {
        return json(res, 400, {
          error: 'Data bahan, jumlah, atau satuan tidak valid'
        });
      }

      let ingredientId = item.ingredient_id
        ? String(item.ingredient_id)
        : null;

      if (ingredientId && !db.prepare(
        'SELECT id FROM ingredients WHERE id=?'
      ).get(ingredientId)) {
        return json(res, 400, { error: 'ID bahan tidak ditemukan di katalog' });
      }

      if (!ingredientId) {
        const match = db.prepare(
          'SELECT id FROM ingredients WHERE LOWER(name)=LOWER(?)'
        ).get(ingredientName);

        if (match) ingredientId = match.id;
      }

      prepared.push({ ingredientId, ingredientName, quantity, unit });
    }

    const updateRecipe = db.transaction(() => {
      db.prepare(`
        UPDATE recipes
        SET name=?,base_portions=?,notes=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND user_id=?
      `).run(name, basePortions, notes, id, user.id);

      db.prepare(
        'DELETE FROM recipe_ingredients WHERE recipe_id=?'
      ).run(id);

      const insert = db.prepare(`
        INSERT INTO recipe_ingredients
        (recipe_id,ingredient_id,ingredient_name,quantity,unit)
        VALUES(?,?,?,?,?)
      `);

      for (const item of prepared) {
        insert.run(
          id,
          item.ingredientId,
          item.ingredientName,
          item.quantity,
          item.unit
        );
      }
    });

    updateRecipe();

    return json(res, 200, {
      ok: true,
      message: 'Resep berhasil diperbarui'
    });
  }

  // Hapus resep
  if (req.method === 'DELETE' && /^\/api\/recipes\/\d+$/.test(url.pathname)) {
    if (!requireRole(user, ['kitchen', 'admin'])) {
      return json(res, 403, { error: 'Akses khusus dapur/admin' });
    }

    const id = Number(url.pathname.split('/').pop());
    const result = db.prepare(
      'DELETE FROM recipes WHERE id=? AND user_id=?'
    ).run(id, user.id);

    if (!result.changes) {
      return json(res, 404, { error: 'Resep tidak ditemukan' });
    }

    return json(res, 200, {
      ok: true,
      message: 'Resep berhasil dihapus'
    });
  }

  // Estimasi menu dengan AI
  if (req.method === 'POST' && url.pathname === '/api/plan') {
    if (!requireRole(user, ['kitchen', 'admin'])) {
      return json(res, 403, { error: 'Akses khusus dapur/admin' });
    }

    const b = await readBody(req);

    const menus = (b.menus || [])
      .slice(0, 10)
      .map(m => ({
        name: String(m.name || '').trim().slice(0, 80),
        portions: Math.max(1, Math.min(5000, parseInt(m.portions) || 1))
      }))
      .filter(m => m.name);

    if (!menus.length) {
      return json(res, 400, { error: 'Isi minimal satu menu' });
    }

    return json(res, 200, await createPlan(menus, user.id));
  }

  // Ranking supplier: bahan katalog diranking,
  // bahan nonkatalog tetap disertakan sebagai unmatched.
  if (req.method === 'POST' && url.pathname === '/api/suppliers/rank') {
    if (!requireRole(user, ['kitchen', 'admin'])) {
      return json(res, 403, { error: 'Akses khusus dapur/admin' });
    }

    const b = await readBody(req);

    const items = (b.items || [])
      .filter(i => Number(i.kg) > 0)
      .map(i => {
        const c = db.prepare(
          'SELECT * FROM ingredients WHERE id=?'
        ).get(i.id);

        return c
          ? {
              id: c.id,
              name: c.name,
              kg: Number(i.kg),
              ref: c.ref_price
            }
          : null;
      })
      .filter(Boolean);

    const unmatched = Array.isArray(b.unmatched)
      ? b.unmatched.map(i => ({
          name: String(i.name || '').slice(0, 100),
          quantity: Number(i.quantity) || 0,
          unit: String(i.unit || '').slice(0, 20)
        })).filter(i => i.name)
      : [];

    if (!items.length) {
      return json(res, 400, {
        error: 'Belum ada bahan kebutuhan yang cocok dengan katalog untuk dicari pada supplier.'
      });
    }

    return json(res, 200, {
      ranking: supplierRanking(items, unmatched),
      unmatched,
      matchedCount: items.length
    });
  }

  // Data supplier yang sedang login
  if (req.method === 'GET' && url.pathname === '/api/supplier/me') {
    if (!requireRole(user, ['supplier'])) {
      return json(res, 403, { error: 'Akses khusus supplier' });
    }

    const supplier = db.prepare(
      'SELECT * FROM suppliers WHERE user_id=?'
    ).get(user.id);

    const stock = db.prepare(`
      SELECT i.id,i.name,st.quantity_kg,st.price_per_kg
      FROM stocks st
      JOIN ingredients i ON i.id=st.ingredient_id
      WHERE st.supplier_id=?
      ORDER BY i.name
    `).all(supplier.id);

    return json(res, 200, {
      supplier,
      stock,
      catalog: db.prepare(
        'SELECT id,name FROM ingredients ORDER BY name'
      ).all()
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/supplier/profile') {
    if (!requireRole(user, ['supplier'])) {
      return json(res, 403, { error: 'Akses khusus supplier' });
    }

    const b = await readBody(req);

    db.prepare(`
      UPDATE suppliers
      SET name=?,address=?,lat=?,lng=?,phone=?
      WHERE user_id=?
    `).run(
      String(b.name || '').slice(0, 100),
      String(b.address || '').slice(0, 200),
      b.lat === '' || b.lat == null ? null : Number(b.lat),
      b.lng === '' || b.lng == null ? null : Number(b.lng),
      String(b.phone || '').slice(0, 30),
      user.id
    );

    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/supplier/stock') {
    if (!requireRole(user, ['supplier'])) {
      return json(res, 403, { error: 'Akses khusus supplier' });
    }

    const b = await readBody(req);
    const supplier = db.prepare(
      'SELECT id FROM suppliers WHERE user_id=?'
    ).get(user.id);

    const id = String(b.ingredient_id || '');
    const qty = Number(b.quantity_kg);
    const price = Number(b.price_per_kg);

    if (
      !db.prepare('SELECT id FROM ingredients WHERE id=?').get(id) ||
      !Number.isFinite(qty) || qty < 0 ||
      !Number.isFinite(price) || price < 0
    ) {
      return json(res, 400, {
        error: 'Bahan, stok, atau harga tidak valid'
      });
    }

    db.prepare(`
      INSERT INTO stocks(supplier_id,ingredient_id,quantity_kg,price_per_kg)
      VALUES(?,?,?,?)
      ON CONFLICT(supplier_id,ingredient_id)
      DO UPDATE SET
        quantity_kg=excluded.quantity_kg,
        price_per_kg=excluded.price_per_kg,
        updated_at=CURRENT_TIMESTAMP
    `).run(supplier.id, id, qty, price);

    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/supplier/catalog') {
    if (!requireRole(user, ['supplier', 'admin'])) {
      return json(res, 403, { error: 'Akses ditolak' });
    }

    const b = await readBody(req);
    const id = norm(b.name).replace(/ /g, '_').slice(0, 40);
    const name = String(b.name || '').trim().slice(0, 80);

    if (!id || !name) {
      return json(res, 400, { error: 'Nama bahan wajib diisi' });
    }

    try {
      db.prepare(`
        INSERT INTO ingredients
        (id,name,alias,yield,kkal,protein,fat,carbs,ref_price)
        VALUES(?,?,?,1,0,0,0,0,?)
      `).run(
        id,
        name,
        String(b.alias || ''),
        Math.max(0, Number(b.ref_price) || 0)
      );

      return json(res, 201, { ok: true, id });
    } catch {
      return json(res, 409, { error: 'Bahan sudah ada di katalog' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
    if (!requireRole(user, ['admin'])) {
      return json(res, 403, { error: 'Akses khusus admin' });
    }

    return json(res, 200, {
      users: db.prepare(
        'SELECT id,username,name,role,created_at FROM users ORDER BY id DESC'
      ).all(),
      suppliers: db.prepare(`
        SELECT s.*,u.username
        FROM suppliers s
        LEFT JOIN users u ON u.id=s.user_id
      `).all(),
      plans: db.prepare('SELECT COUNT(*) n FROM plans').get().n
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/users') {
    if (!requireRole(user, ['admin'])) {
      return json(res, 403, { error: 'Akses khusus admin' });
    }

    const b = await readBody(req);

    if (!['admin', 'kitchen', 'supplier'].includes(b.role)) {
      return json(res, 400, { error: 'Role tidak valid' });
    }

    try {
      const r = db.prepare(
        'INSERT INTO users(username,password_hash,role,name) VALUES(?,?,?,?)'
      ).run(
        String(b.username),
        bcrypt.hashSync(String(b.password), 10),
        b.role,
        String(b.name || b.username)
      );

      if (b.role === 'supplier') {
        db.prepare(
          'INSERT INTO suppliers(user_id,name,address) VALUES(?,?,?)'
        ).run(
          r.lastInsertRowid,
          String(b.name || b.username),
          String(b.address || '')
        );
      }

      return json(res, 201, { ok: true });
    } catch {
      return json(res, 409, { error: 'Username sudah ada' });
    }
  }

  return json(res, 404, { error: 'Endpoint tidak ditemukan' });

  } catch (e) {
    console.error(e);
    return json(res, 500, { error: 'Kesalahan server: ' + e.message });
  }
});

server.on('request', (req, res) => {});
http.createServer; // static handler is attached below through the same server request listener wrapper

const original = server.listeners('request')[0];
server.removeAllListeners('request');

server.on('request', (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const requested = url.pathname === '/'
      ? '/index.html'
      : decodeURIComponent(url.pathname);

    const file = path.resolve(staticDir, '.' + requested);

    if (!file.startsWith(path.resolve(staticDir) + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }

      const ext = path.extname(file);

      res.writeHead(200, {
        'Content-Type': ({
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript',
          '.css': 'text/css'
        }[ext] || 'application/octet-stream')
      });

      res.end(buf);
    });

    return;
  }

  original(req, res);
});

server.listen(PORT, () => {
  console.log(
    `BahanTepat berjalan di http://localhost:${PORT} | DB: ${DB_FILE} | Groq: ${KEY ? MODEL : 'OFF'}`
  );
});


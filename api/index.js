const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { CATALOG, FALLBACK } = require('../data');

const KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

// Reuse the pool between warm Vercel invocations.
let pool = global.__bahantepatPool;
if (!pool) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 10000
  });
  global.__bahantepatPool = pool;
}

const json = (res, status, body) => res.status(status).json(body);
const norm = s => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const requireRole = (u, roles) => !!u && roles.includes(u.role);
const getBody = req => req.body && typeof req.body === 'object' ? req.body : {};
const tokenFrom = req => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

async function authUser(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const { rows } = await pool.query(`
    SELECT u.*, s.token FROM sessions s
    JOIN users u ON u.id=s.user_id
    WHERE s.token=$1 AND s.expires_at>$2
  `, [token, Date.now()]);
  return rows[0] || null;
}

async function lex(name) {
  const q = norm(name);
  const { rows } = await pool.query('SELECT * FROM ingredients');
  let best = null;
  let score = 0;
  for (const c of rows) {
    const words = new Set(norm(c.name + ' ' + c.alias).split(' '));
    const qwords = q.split(' ');
    let s = q === norm(c.name) ? 1 : qwords.filter(w => words.has(w)).length / Math.max(1, qwords.length);
    if (norm(c.name).includes(q) || q.includes(norm(c.name))) s = Math.max(s, .9);
    if (s > score) { score = s; best = c; }
  }
  return score >= .45 ? best : null;
}

async function groqRecipe(menuNames) {
  if (!KEY) throw new Error('GROQ_API_KEY belum diatur');
  const prompt = `Anda adalah chef profesional katering Indonesia dan ahli gizi.\n\nTUGAS:\nBuat resep yang BENAR-BENAR sesuai dengan nama menu yang diminta.\n\nMENU:\n${menuNames.join('; ')}\n\nATURAN WAJIB:\n1. Setiap menu harus memiliki resep sendiri dan tidak boleh tercampur dengan menu lain.\n2. Jangan memasukkan bahan dari menu lain.\n3. Gunakan bahan yang secara kuliner memang diperlukan untuk menu tersebut.\n4. Jangan menambahkan lauk, daging, ikan, udang, tahu, atau tempe pada minuman kecuali memang bagian dari nama menu.\n5. Untuk minuman, gunakan bahan minuman yang sesuai. Contoh Es Jeruk: jeruk, air, gula, dan es batu.\n6. Jangan membuat variasi menu sendiri.\n7. Takaran adalah gram bahan mentah untuk satu porsi dewasa.\n8. Maksimal 12 bahan per menu.\n9. Jika tidak yakin dengan resep suatu menu, jangan mengarang. Kembalikan ingredients sebagai array kosong.\n10. Nama menu pada hasil harus sama dengan nama menu yang diminta.\n\nFORMAT JAWABAN:\nBalas hanya JSON valid seperti ini:\n{"menus":[{"menu":"nama menu persis","ingredients":[{"name":"nama bahan","net_g":angka}]}]}`;
  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } })
    });
  } catch (e) {
    throw new Error(`Koneksi Groq gagal: ${e.cause?.code || e.code || e.message}`);
  }
  if (!response.ok) throw new Error(`Groq API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return JSON.parse(data.choices?.[0]?.message?.content || '{}').menus || [];
}

async function fallbackRecipe(name) {
  const key = Object.keys(FALLBACK).find(k => norm(k) === norm(name));
  if (!key) return [];
  const out = [];
  for (const [id, net_g] of FALLBACK[key]) {
    const { rows } = await pool.query('SELECT name FROM ingredients WHERE id=$1', [id]);
    out.push({ name: rows[0]?.name || id, net_g });
  }
  return out;
}

async function createPlan(menus, userId) {
  let generated = null;
  let aiError = null;
  if (KEY) {
    try { generated = await groqRecipe(menus.map(m => m.name)); }
    catch (e) { aiError = e.message; console.error('Groq:', e.message); }
  }
  const resultMenus = [];
  const need = new Map();
  const warnings = [];
  for (let ix = 0; ix < menus.length; ix++) {
    const m = menus[ix];
    let ingredients = generated?.[ix]?.ingredients;
    let source = 'groq';
    if (!Array.isArray(ingredients) || !ingredients.length) {
      ingredients = await fallbackRecipe(m.name);
      source = ingredients.length ? 'fallback-demo' : 'unavailable';
    }
    if (source === 'unavailable') warnings.push(`Resep "${m.name}" tidak berhasil dibuat. Periksa koneksi/API Groq atau masukkan menu yang lebih spesifik.`);
    const total = [0, 0, 0, 0];
    const used = [];
    for (const item of (ingredients || []).slice(0, 18)) {
      const grams = Math.max(1, Math.min(500, Number(item.net_g) || 0));
      const c = await lex(item.name);
      const y = c ? Number(c.yield) : 1;
      const gross = c ? grams / (y || 1) : grams;
      const key = c ? `catalog:${c.id}` : `custom:${norm(item.name)}`;
      const entry = need.get(key) || { id: c?.id || null, name: c?.name || String(item.name).trim(), kg: 0, ref: c ? Number(c.ref_price) : null, unit: 'kg', catalog: !!c };
      entry.kg += gross * m.portions / 1000;
      need.set(key, entry);
      if (c) {
        total[0] += Number(c.kkal) * grams / 100;
        total[1] += Number(c.protein) * grams / 100;
        total[2] += Number(c.fat) * grams / 100;
        total[3] += Number(c.carbs) * grams / 100;
      }
      used.push({ id: c?.id || null, name: c?.name || String(item.name).trim(), net_g: Math.round(grams), gross_g: Math.round(gross), yield: c ? Number(c.yield) : null, catalog: !!c });
    }
    resultMenus.push({ name: m.name, portions: m.portions, source, nutrition: { kkal: Math.round(total[0]), protein: +total[1].toFixed(1), lemak: +total[2].toFixed(1), karbo: +total[3].toFixed(1) }, ingredients: used });
  }
  const items = [...need.values()].map(it => ({ ...it, kg: Math.ceil(it.kg * 100) / 100 }));
  if (aiError) warnings.unshift(`Groq gagal dihubungi (${aiError}). Sistem hanya memakai resep demo yang tersedia; menu lain tidak ditebak.`);
  if (!KEY) warnings.unshift('GROQ_API_KEY belum diisi. Hanya resep demo yang tersedia; aktifkan API untuk menu bebas.');
  const payload = { menus: resultMenus, items, warnings, aiStatus: generated ? 'groq' : (KEY ? 'fallback' : 'offline') };
  await pool.query('INSERT INTO plans(user_id,payload) VALUES($1,$2)', [userId, JSON.stringify(payload)]);
  return payload;
}

async function supplierRanking(items, unmatched = []) {
  const { rows: suppliers } = await pool.query(`SELECT s.*,u.name AS account_name FROM suppliers s LEFT JOIN users u ON u.id=s.user_id`);
  const rows = [];
  for (const s of suppliers) {
    let requested = 0, filled = 0, total = 0, ref = 0;
    const missing = [], available = [];
    for (const it of items) {
      requested++;
      const { rows: stockRows } = await pool.query('SELECT quantity_kg,price_per_kg FROM stocks WHERE supplier_id=$1 AND ingredient_id=$2', [s.id, it.id]);
      const st = stockRows[0];
      const stockQty = st ? Math.max(0, Number(st.quantity_kg)) : 0;
      const requiredQty = Number(it.kg);
      const got = Math.min(stockQty, requiredQty);
      if (got > 0) {
        filled += got / requiredQty;
        total += got * Number(st.price_per_kg || 0);
        ref += got * Number(it.ref || 0);
        available.push({ id: it.id, name: it.name, required: requiredQty, available: got, shortage: Math.max(0, requiredQty - got), price_per_kg: Number(st.price_per_kg || 0) });
      } else missing.push({ id: it.id, name: it.name, required: requiredQty, available: 0, shortage: requiredQty, reason: 'Tidak tersedia' });
      if (got > 0 && got < requiredQty) missing.push({ id: it.id, name: it.name, required: requiredQty, available: got, shortage: requiredQty - got, reason: 'Stok tidak mencukupi' });
    }
    const km = (s.lat == null || s.lng == null) ? null : Math.round(Math.hypot((Number(s.lat) + 6.1783) * 111, (Number(s.lng) - 106.6319) * 111) * 10) / 10;
    const fill = requested ? filled / requested : 0;
    rows.push({ id: s.id, name: s.name, address: s.address, phone: s.phone, fill, matchedCount: requested, availableCount: available.length, missingCount: missing.length, km, total: Math.round(total), pidx: ref ? total / ref : 1, available, missing, unmatched });
  }
  const maxKm = Math.max(1, ...rows.map(r => r.km ?? 10000));
  const maxPrice = Math.max(1, ...rows.map(r => r.pidx));
  rows.forEach(r => { r.score = +(100 * (.5 * r.fill + .2 * (1 - (r.km ?? maxKm) / maxKm) + .3 * (1 - r.pidx / maxPrice))).toFixed(1); });
  return rows.sort((a, b) => b.score - a.score);
}

async function prepareRecipeIngredients(ingredients) {
  const prepared = [];
  for (const item of ingredients) {
    const ingredientName = String(item.ingredient_name || item.name || '').trim().slice(0, 100);
    const quantity = Number(item.quantity);
    const unit = String(item.unit || '').trim().slice(0, 20);
    if (!ingredientName || !Number.isFinite(quantity) || quantity <= 0 || !unit) return { error: 'Data bahan, jumlah, atau satuan tidak valid' };
    let ingredientId = item.ingredient_id ? String(item.ingredient_id) : null;
    if (ingredientId) {
      const found = await pool.query('SELECT id FROM ingredients WHERE id=$1', [ingredientId]);
      if (!found.rows[0]) return { error: 'ID bahan tidak ditemukan di katalog' };
    } else {
      const found = await pool.query('SELECT id FROM ingredients WHERE LOWER(name)=LOWER($1)', [ingredientName]);
      if (found.rows[0]) ingredientId = found.rows[0].id;
    }
    prepared.push({ ingredientId, ingredientName, quantity, unit });
  }
  return { prepared };
}

module.exports = async function handler(req, res) {
  try {
    if (!process.env.DATABASE_URL) return json(res, 500, { error: 'DATABASE_URL belum diatur di Vercel.' });
    const method = req.method;
    const pathname = new URL(req.url, 'https://bahantepat.vercel.app').pathname;
    const b = getBody(req);

    if (method === 'POST' && pathname === '/api/login') {
      const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [String(b.username || '')]);
      const u = rows[0];
      if (!u || !(await bcrypt.compare(String(b.password || ''), u.password_hash))) return json(res, 401, { error: 'Username atau password salah' });
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query('INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,$3)', [token, u.id, Date.now() + 12 * 60 * 60 * 1000]);
      return json(res, 200, { token, user: { id: u.id, username: u.username, name: u.name, role: u.role }, ai: KEY ? 'groq' : 'offline', model: KEY ? MODEL : null });
    }

    if (method === 'POST' && pathname === '/api/register') {
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      if (username.length < 3 || password.length < 8) return json(res, 400, { error: 'Username minimal 3 karakter dan password minimal 8 karakter' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const u = await client.query('INSERT INTO users(username,password_hash,role,name) VALUES($1,$2,$3,$4) RETURNING id', [username, await bcrypt.hash(password, 10), 'supplier', String(b.name || username).slice(0, 100)]);
        const userId = u.rows[0].id;
        await client.query('INSERT INTO suppliers(user_id,name,address,lat,lng,phone) VALUES($1,$2,$3,$4,$5,$6)', [userId, String(b.name || username).slice(0, 100), String(b.address || ''), Number.isFinite(+b.lat) ? +b.lat : null, Number.isFinite(+b.lng) ? +b.lng : null, String(b.phone || '')]);
        const token = crypto.randomBytes(32).toString('hex');
        await client.query('INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,$3)', [token, userId, Date.now() + 43200000]);
        await client.query('COMMIT');
        return json(res, 201, { token, user: { id: userId, username, name: b.name || username, role: 'supplier' } });
      } catch (e) {
        await client.query('ROLLBACK');
        return json(res, 409, { error: 'Username sudah digunakan atau data tidak valid' });
      } finally { client.release(); }
    }

    const user = await authUser(req);
    if (!user) return json(res, 401, { error: 'Sesi tidak valid. Silakan masuk kembali.' });

    if (method === 'POST' && pathname === '/api/logout') {
      await pool.query('DELETE FROM sessions WHERE token=$1', [tokenFrom(req)]);
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && pathname === '/api/catalog') {
      const { rows } = await pool.query('SELECT id,name,ref_price AS ref FROM ingredients ORDER BY name');
      return json(res, 200, { items: rows });
    }

    if (method === 'GET' && pathname === '/api/recipes') {
      if (!requireRole(user, ['kitchen', 'admin'])) return json(res, 403, { error: 'Akses khusus dapur/admin' });
      const { rows } = await pool.query(`SELECT r.id,r.name,r.base_portions,r.notes,r.created_at,COUNT(ri.id)::int AS ingredient_count FROM recipes r LEFT JOIN recipe_ingredients ri ON ri.recipe_id=r.id WHERE r.user_id=$1 GROUP BY r.id ORDER BY r.updated_at DESC`, [user.id]);
      return json(res, 200, { recipes: rows });
    }
    const recipeMatch = pathname.match(/^\/api\/recipes\/(\d+)$/);
    if (recipeMatch && method === 'GET') {
      if (!requireRole(user, ['kitchen', 'admin'])) return json(res, 403, { error: 'Akses khusus dapur/admin' });
      const id = Number(recipeMatch[1]);
      const recipe = await pool.query('SELECT * FROM recipes WHERE id=$1 AND user_id=$2', [id, user.id]);
      if (!recipe.rows[0]) return json(res, 404, { error: 'Resep tidak ditemukan' });
      const ingredients = await pool.query('SELECT id,ingredient_id,ingredient_name,quantity,unit FROM recipe_ingredients WHERE recipe_id=$1 ORDER BY id', [id]);
      return json(res, 200, { recipe: recipe.rows[0], ingredients: ingredients.rows });
    }
    if (recipeMatch && (method === 'PUT' || method === 'DELETE')) {
      if (!requireRole(user, ['kitchen', 'admin'])) return json(res, 403, { error: 'Akses khusus dapur/admin' });
      const id = Number(recipeMatch[1]);
      if (method === 'DELETE') {
        const del = await pool.query('DELETE FROM recipes WHERE id=$1 AND user_id=$2', [id, user.id]);
        if (!del.rowCount) return json(res, 404, { error: 'Resep tidak ditemukan' });
        return json(res, 200, { ok: true, message: 'Resep berhasil dihapus' });
      }
      const name = String(b.name || '').trim().slice(0, 100);
      const basePortions = Number(b.base_portions);
      const notes = String(b.notes || '').slice(0, 500);
      const ingredients = Array.isArray(b.ingredients) ? b.ingredients : [];
      if (!name) return json(res, 400, { error: 'Nama resep wajib diisi' });
      if (!Number.isFinite(basePortions) || basePortions <= 0) return json(res, 400, { error: 'Jumlah porsi dasar tidak valid' });
      if (!ingredients.length) return json(res, 400, { error: 'Isi minimal satu bahan' });
      const prep = await prepareRecipeIngredients(ingredients);
      if (prep.error) return json(res, 400, { error: prep.error });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const exists = await client.query('SELECT id FROM recipes WHERE id=$1 AND user_id=$2', [id, user.id]);
        if (!exists.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'Resep tidak ditemukan' }); }
        await client.query('UPDATE recipes SET name=$1,base_portions=$2,notes=$3,updated_at=CURRENT_TIMESTAMP WHERE id=$4 AND user_id=$5', [name, basePortions, notes, id, user.id]);
        await client.query('DELETE FROM recipe_ingredients WHERE recipe_id=$1', [id]);
        for (const item of prep.prepared) await client.query('INSERT INTO recipe_ingredients(recipe_id,ingredient_id,ingredient_name,quantity,unit) VALUES($1,$2,$3,$4,$5)', [id, item.ingredientId, item.ingredientName, item.quantity, item.unit]);
        await client.query('COMMIT');
        return json(res, 200, { ok: true, message: 'Resep berhasil diperbarui' });
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }
    if (method === 'POST' && pathname === '/api/recipes') {
      if (!requireRole(user, ['kitchen', 'admin'])) return json(res, 403, { error: 'Akses khusus dapur/admin' });
      const name = String(b.name || '').trim().slice(0, 100);
      const basePortions = Number(b.base_portions);
      const notes = String(b.notes || '').slice(0, 500);
      const ingredients = Array.isArray(b.ingredients) ? b.ingredients : [];
      if (!name) return json(res, 400, { error: 'Nama resep wajib diisi' });
      if (!Number.isFinite(basePortions) || basePortions <= 0) return json(res, 400, { error: 'Jumlah porsi dasar tidak valid' });
      if (!ingredients.length) return json(res, 400, { error: 'Isi minimal satu bahan' });
      const prep = await prepareRecipeIngredients(ingredients);
      if (prep.error) return json(res, 400, { error: prep.error });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query('INSERT INTO recipes(user_id,name,base_portions,notes) VALUES($1,$2,$3,$4) RETURNING id', [user.id, name, basePortions, notes]);
        const id = r.rows[0].id;
        for (const item of prep.prepared) await client.query('INSERT INTO recipe_ingredients(recipe_id,ingredient_id,ingredient_name,quantity,unit) VALUES($1,$2,$3,$4,$5)', [id, item.ingredientId, item.ingredientName, item.quantity, item.unit]);
        await client.query('COMMIT');
        return json(res, 201, { ok: true, id, message: 'Resep berhasil disimpan' });
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }

    if (method === 'POST' && pathname === '/api/plan') {
      if (!requireRole(user, ['kitchen', 'admin'])) return json(res, 403, { error: 'Akses khusus dapur/admin' });
      const menus = (Array.isArray(b.menus) ? b.menus : []).slice(0, 10).map(m => ({ name: String(m.name || '').trim().slice(0, 80), portions: Math.max(1, Math.min(5000, parseInt(m.portions) || 1)) })).filter(m => m.name);
      if (!menus.length) return json(res, 400, { error: 'Isi minimal satu menu' });
      return json(res, 200, await createPlan(menus, user.id));
    }
    if (method === 'POST' && pathname === '/api/suppliers/rank') {
      if (!requireRole(user, ['kitchen', 'admin'])) return json(res, 403, { error: 'Akses khusus dapur/admin' });
      const inputItems = Array.isArray(b.items) ? b.items : [];
      const items = [];
      for (const i of inputItems.filter(i => Number(i.kg) > 0)) {
        const q = await pool.query('SELECT * FROM ingredients WHERE id=$1', [i.id]);
        const c = q.rows[0];
        if (c) items.push({ id: c.id, name: c.name, kg: Number(i.kg), ref: Number(c.ref_price) });
      }
      const unmatched = Array.isArray(b.unmatched) ? b.unmatched.map(i => ({ name: String(i.name || '').slice(0, 100), quantity: Number(i.quantity) || 0, unit: String(i.unit || '').slice(0, 20) })).filter(i => i.name) : [];
      if (!items.length) return json(res, 200, { ranking: [], unmatched, matchedCount: 0, message: 'Belum ada bahan kebutuhan yang cocok dengan katalog supplier. Bahan nonkatalog tetap tercatat, tetapi belum dapat dibandingkan stok dan harganya.' });
      return json(res, 200, { ranking: await supplierRanking(items, unmatched), unmatched, matchedCount: items.length });
    }

    if (method === 'GET' && pathname === '/api/supplier/me') {
      if (!requireRole(user, ['supplier'])) return json(res, 403, { error: 'Akses khusus supplier' });
      const s = await pool.query('SELECT * FROM suppliers WHERE user_id=$1', [user.id]);
      const supplier = s.rows[0];
      if (!supplier) return json(res, 404, { error: 'Profil supplier tidak ditemukan' });
      const stock = await pool.query('SELECT i.id,i.name,st.quantity_kg,st.price_per_kg FROM stocks st JOIN ingredients i ON i.id=st.ingredient_id WHERE st.supplier_id=$1 ORDER BY i.name', [supplier.id]);
      const catalog = await pool.query('SELECT id,name FROM ingredients ORDER BY name');
      return json(res, 200, { supplier, stock: stock.rows, catalog: catalog.rows });
    }
    if (method === 'POST' && pathname === '/api/supplier/profile') {
      if (!requireRole(user, ['supplier'])) return json(res, 403, { error: 'Akses khusus supplier' });
      await pool.query('UPDATE suppliers SET name=$1,address=$2,lat=$3,lng=$4,phone=$5 WHERE user_id=$6', [String(b.name || '').slice(0, 100), String(b.address || '').slice(0, 200), b.lat === '' || b.lat == null ? null : Number(b.lat), b.lng === '' || b.lng == null ? null : Number(b.lng), String(b.phone || '').slice(0, 30), user.id]);
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && pathname === '/api/supplier/stock') {
      if (!requireRole(user, ['supplier'])) return json(res, 403, { error: 'Akses khusus supplier' });
      const supplier = await pool.query('SELECT id FROM suppliers WHERE user_id=$1', [user.id]);
      if (!supplier.rows[0]) return json(res, 404, { error: 'Profil supplier tidak ditemukan' });
      const id = String(b.ingredient_id || '');
      const qty = Number(b.quantity_kg), price = Number(b.price_per_kg);
      const exists = await pool.query('SELECT id FROM ingredients WHERE id=$1', [id]);
      if (!exists.rows[0] || !Number.isFinite(qty) || qty < 0 || !Number.isFinite(price) || price < 0) return json(res, 400, { error: 'Bahan, stok, atau harga tidak valid' });
      await pool.query(`INSERT INTO stocks(supplier_id,ingredient_id,quantity_kg,price_per_kg) VALUES($1,$2,$3,$4) ON CONFLICT(supplier_id,ingredient_id) DO UPDATE SET quantity_kg=EXCLUDED.quantity_kg,price_per_kg=EXCLUDED.price_per_kg,updated_at=CURRENT_TIMESTAMP`, [supplier.rows[0].id, id, qty, price]);
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && pathname === '/api/supplier/catalog') {
      if (!requireRole(user, ['supplier', 'admin'])) return json(res, 403, { error: 'Akses ditolak' });
      const id = norm(b.name).replace(/ /g, '_').slice(0, 40);
      const name = String(b.name || '').trim().slice(0, 80);
      if (!id || !name) return json(res, 400, { error: 'Nama bahan wajib diisi' });
      try {
        await pool.query('INSERT INTO ingredients(id,name,alias,"yield",kkal,protein,fat,carbs,ref_price) VALUES($1,$2,$3,1,0,0,0,0,$4)', [id, name, String(b.alias || ''), Math.max(0, Number(b.ref_price) || 0)]);
        return json(res, 201, { ok: true, id });
      } catch { return json(res, 409, { error: 'Bahan sudah ada di katalog' }); }
    }
    if (method === 'GET' && pathname === '/api/admin/summary') {
      if (!requireRole(user, ['admin'])) return json(res, 403, { error: 'Akses khusus admin' });
      const users = await pool.query('SELECT id,username,name,role,created_at FROM users ORDER BY id DESC');
      const suppliers = await pool.query('SELECT s.*,u.username FROM suppliers s LEFT JOIN users u ON u.id=s.user_id');
      const plans = await pool.query('SELECT COUNT(*)::int AS n FROM plans');
      return json(res, 200, { users: users.rows, suppliers: suppliers.rows, plans: plans.rows[0].n });
    }
    if (method === 'POST' && pathname === '/api/admin/users') {
      if (!requireRole(user, ['admin'])) return json(res, 403, { error: 'Akses khusus admin' });
      if (!['admin', 'kitchen', 'supplier'].includes(b.role)) return json(res, 400, { error: 'Role tidak valid' });
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      if (username.length < 3 || password.length < 8) return json(res, 400, { error: 'Username minimal 3 karakter dan password minimal 8 karakter' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query('INSERT INTO users(username,password_hash,role,name) VALUES($1,$2,$3,$4) RETURNING id', [username, await bcrypt.hash(password, 10), b.role, String(b.name || username)]);
        if (b.role === 'supplier') await client.query('INSERT INTO suppliers(user_id,name,address) VALUES($1,$2,$3)', [r.rows[0].id, String(b.name || username), String(b.address || '')]);
        await client.query('COMMIT');
        return json(res, 201, { ok: true });
      } catch (e) { await client.query('ROLLBACK'); return json(res, 409, { error: 'Username sudah ada' }); }
      finally { client.release(); }
    }

    return json(res, 404, { error: 'Endpoint tidak ditemukan' });
  } catch (e) {
    console.error('BahanTepat API error:', e);
    return json(res, 500, { error: 'Kesalahan server: ' + (e.message || 'Unknown error') });
  }
};

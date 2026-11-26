require('dotenv').config();

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { CATALOG } = require('../data');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL belum diatur.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2
});

async function migrate() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (
          role IN ('admin', 'kitchen', 'supplier')
        ),
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ingredients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        alias TEXT DEFAULT '',
        "yield" DOUBLE PRECISION DEFAULT 1,
        kkal DOUBLE PRECISION DEFAULT 0,
        protein DOUBLE PRECISION DEFAULT 0,
        fat DOUBLE PRECISION DEFAULT 0,
        carbs DOUBLE PRECISION DEFAULT 0,
        ref_price DOUBLE PRECISION DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS suppliers (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT UNIQUE REFERENCES users(id),
        name TEXT NOT NULL,
        address TEXT DEFAULT '',
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        phone TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS stocks (
        id BIGSERIAL PRIMARY KEY,
        supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
        quantity_kg DOUBLE PRECISION NOT NULL DEFAULT 0,
        price_per_kg DOUBLE PRECISION NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(supplier_id, ingredient_id)
      );

      CREATE TABLE IF NOT EXISTS plans (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id),
        payload TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS recipes (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        base_portions DOUBLE PRECISION NOT NULL DEFAULT 1,
        notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS recipe_ingredients (
        id BIGSERIAL PRIMARY KEY,
        recipe_id BIGINT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        ingredient_id TEXT REFERENCES ingredients(id),
        ingredient_name TEXT NOT NULL,
        quantity DOUBLE PRECISION NOT NULL,
        unit TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(user_id);

      CREATE INDEX IF NOT EXISTS idx_recipes_user
        ON recipes(user_id);

      CREATE INDEX IF NOT EXISTS idx_stocks_supplier
        ON stocks(supplier_id);
    `);

    console.log('1/4: Struktur tabel berhasil dibuat.');

    // Masukkan seluruh katalog bahan dari data.js
    for (const c of CATALOG) {
      await client.query(`
        INSERT INTO ingredients
          (id, name, alias, "yield", kkal, protein, fat, carbs, ref_price)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id) DO NOTHING
      `, [
        c.id,
        c.name,
        c.alias || '',
        Number(c.yield) || 1,
        Number(c.n?.[0]) || 0,
        Number(c.n?.[1]) || 0,
        Number(c.n?.[2]) || 0,
        Number(c.n?.[3]) || 0,
        Number(c.ref) || 0
      ]);
    }

    console.log(`2/4: ${CATALOG.length} bahan katalog diproses.`);

    // Akun demo dibuat jika belum ada.
    const demoUsers = [
      {
        username: 'admin',
        password: process.env.ADMIN_PASSWORD || 'admin12345',
        role: 'admin',
        name: 'Administrator'
      },
      {
        username: 'dapur',
        password: process.env.KITCHEN_PASSWORD || 'dapur12345',
        role: 'kitchen',
        name: 'Dapur Demo'
      },
      {
        username: 'supplier',
        password: process.env.SUPPLIER_PASSWORD || 'supplier12345',
        role: 'supplier',
        name: 'Supplier Demo'
      }
    ];

    for (const u of demoUsers) {
      const hash = await bcrypt.hash(u.password, 10);

      await client.query(`
        INSERT INTO users (username, password_hash, role, name)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (username) DO NOTHING
      `, [u.username, hash, u.role, u.name]);
    }

    console.log('3/4: Akun demo dipastikan tersedia.');

    const supplierUser = await client.query(
      `SELECT id FROM users WHERE username = 'supplier'`
    );

    const supplierResult = await client.query(`
      INSERT INTO suppliers (user_id, name, address, lat, lng, phone)
      VALUES ($1, 'Supplier Demo', 'Tangerang, Banten', -6.1783, 106.6319, '')
      ON CONFLICT (user_id)
      DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING id
    `, [supplierUser.rows[0].id]);

    const supplierId = supplierResult.rows[0].id;

    // Stok demo hanya dimasukkan jika belum tersedia.
    for (const c of CATALOG) {
      await client.query(`
        INSERT INTO stocks
          (supplier_id, ingredient_id, quantity_kg, price_per_kg)
        VALUES ($1,$2,100,$3)
        ON CONFLICT (supplier_id, ingredient_id) DO NOTHING
      `, [supplierId, c.id, Number(c.ref) || 0]);
    }

    console.log('4/4: Supplier demo dan stok awal diproses.');

    await client.query('COMMIT');

    console.log('');
    console.log('MIGRASI NEON BERHASIL.');
    console.log('Tabel: users, sessions, ingredients, suppliers, stocks, plans, recipes, recipe_ingredients.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migrasi gagal:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
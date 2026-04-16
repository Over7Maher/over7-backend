require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log('Connecting to Railway PostgreSQL…');
    await client.connect();
    console.log('Connected.\n');

    const sql = fs.readFileSync(
      path.join(__dirname, '../src/db/schema.sql'),
      'utf8'
    );

    console.log('Running schema.sql…');
    await client.query(sql);
    console.log('Schema applied.\n');

    // Verify tables
    const { rows } = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);

    console.log('Tables in database:');
    rows.forEach(r => console.log('  ✓', r.table_name));

    const expected = ['arena_votes', 'likes', 'matches', 'messages', 'users'];
    const found = rows.map(r => r.table_name);
    const missing = expected.filter(t => !found.includes(t));

    if (missing.length === 0) {
      console.log('\nAll required tables present.');
    } else {
      console.error('\nMissing tables:', missing.join(', '));
      process.exit(1);
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();

import fs from 'node:fs/promises'
import pg from 'pg'
import { config } from './config.js'

const connectionString = process.env.DATABASE_URL_UNPOOLED || config.DATABASE_URL
if (!connectionString) throw new Error('Set DATABASE_URL before running migrations')

const databaseUrl = new URL(connectionString)
if (databaseUrl.hostname.includes('-pooler')) {
  throw new Error('Migrations require a direct connection. Set DATABASE_URL_UNPOOLED.')
}

const pool = new pg.Pool({ connectionString })
const client = await pool.connect()
try {
  await client.query('BEGIN')
  await client.query(await fs.readFile(new URL('../schema.sql', import.meta.url), 'utf8'))
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  )
  const migrationDirectory = new URL('../migrations/', import.meta.url)
  const migrationFiles = (await fs.readdir(migrationDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort()
  for (const name of migrationFiles) {
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name])
    if (applied.rows[0]) continue
    await client.query(await fs.readFile(new URL(name, migrationDirectory), 'utf8'))
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
    console.log(`Applied migration ${name}`)
  }
  await client.query('COMMIT')
  console.log('Database schema and migrations applied')
} catch (error) {
  try {
    await client.query('ROLLBACK')
  } catch (rollbackError) {
    console.error('Unable to roll back the migration transaction:', rollbackError.message)
  }
  throw error
} finally {
  client.release()
  await pool.end()
}

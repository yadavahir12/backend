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
  await client.query('COMMIT')
  console.log('Database schema applied')
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

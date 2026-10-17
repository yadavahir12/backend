import bcrypt from 'bcryptjs'
import { pool } from './db.js'

if (!pool) throw new Error('Set DATABASE_URL before seeding')
const client = await pool.connect()
try {
  await client.query('BEGIN')
  const user = await client.query(`INSERT INTO users (id, username, email, password_hash) VALUES (gen_random_uuid(), $1, $2, $3) ON CONFLICT (username) DO UPDATE SET email = EXCLUDED.email RETURNING id`, ['demo-user', 'demo@example.com', await bcrypt.hash('demo-password', 12)])
  await client.query('INSERT INTO profiles (user_id, display_name) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [user.rows[0].id, 'Demo User'])
  await client.query('INSERT INTO coin_wallets (user_id, balance) VALUES ($1, 1250) ON CONFLICT (user_id) DO NOTHING', [user.rows[0].id])
  await client.query('COMMIT')
  console.log('Development seed applied')
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally { client.release(); await pool.end() }

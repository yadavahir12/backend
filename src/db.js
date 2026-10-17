import pg from 'pg'
import { config, demoMode } from './config.js'

const { Pool } = pg
export const pool = config.DATABASE_URL ? new Pool({ connectionString: config.DATABASE_URL }) : null

const state = {
  users: [], profiles: [], wallets: [], transactions: [], packages: [20, 50, 200, 499, 999].map((price, index) => ({ id: `package-${price}`, amountInr: price, coinAmount: [15, 45, 220, 720, 1820][index], displayOrder: index + 1, isActive: true })),
  groups: [], messages: [], follows: [], rounds: [], predictions: [], notifications: [],
}

export async function query(text, values = []) {
  if (!pool) throw new Error('DATABASE_URL is required outside demo mode')
  return pool.query(text, values)
}

export async function withTransaction(callback, database = pool) {
  if (!database) throw new Error('DATABASE_URL is required outside demo mode')
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      console.error('Unable to roll back database transaction:', rollbackError.message)
    }
    throw error
  } finally {
    client.release()
  }
}

export { config, demoMode, state }

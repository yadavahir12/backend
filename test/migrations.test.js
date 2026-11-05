import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8')
const replyMigration = await readFile(new URL('../migrations/20261101_add_message_reply_reference.sql', import.meta.url), 'utf8')
const adminRoundMigration = await readFile(new URL('../migrations/20261105_add_admin_round_management.sql', import.meta.url), 'utf8')

test('message reply migration matches UUID message IDs and preserves existing messages', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS messages\s*\(\s*id UUID PRIMARY KEY/)
  assert.match(replyMigration, /ADD COLUMN IF NOT EXISTS reply_to_message_id UUID/)
  assert.match(replyMigration, /FOREIGN KEY \(reply_to_message_id\)\s+REFERENCES messages\(id\)\s+ON DELETE SET NULL/)
  assert.match(replyMigration, /FOREIGN KEY \(reply_to_message_id, group_id\)\s+REFERENCES messages\(id, group_id\)/)
  assert.match(replyMigration, /ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/)
  assert.doesNotMatch(replyMigration, /\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i)
})

test('admin round migration adds result timestamps and pause state without deleting history', () => {
  assert.match(schema, /result_generated_at TIMESTAMPTZ/)
  assert.match(schema, /paused_at TIMESTAMPTZ/)
  assert.match(adminRoundMigration, /ADD COLUMN IF NOT EXISTS result_generated_at TIMESTAMPTZ/)
  assert.match(adminRoundMigration, /ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ/)
  assert.match(adminRoundMigration, /prevent_finalized_game_result_update/)
  assert.match(adminRoundMigration, /NEW\.result IS DISTINCT FROM OLD\.result/)
  assert.doesNotMatch(adminRoundMigration, /\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i)
})

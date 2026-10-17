import test from 'node:test'
import assert from 'node:assert/strict'
import { GAME_COLORS, LEADERBOARD_METRIC, compareCoinBalances, compareTotalWins, isValidColor, rankCoinBalances } from '../src/gameRules.js'

test('uses the confirmed virtual game colors', () => {
  assert.deepEqual(GAME_COLORS, ['Red', 'Green', 'Violet'])
  assert.equal(isValidColor('Red'), true)
  assert.equal(isValidColor('Mint'), false)
})

test('ranks users by total wins descending', () => {
  assert.equal(LEADERBOARD_METRIC, 'total_wins')
  assert.ok(compareTotalWins({ wins: 12 }, { wins: 4 }) < 0)
  assert.ok(compareTotalWins({ wins: 4 }, { wins: 12 }) > 0)
})

test('ranks users by coin balance descending', () => {
  assert.ok(compareCoinBalances({ coins: 839 }, { coins: 762 }) < 0)
  assert.ok(compareCoinBalances({ coins: 762 }, { coins: 839 }) > 0)
  assert.equal(compareCoinBalances({ coins: 839 }, { coins: 839 }), 0)
})

test('recalculates coin ranks from the highest balance', () => {
  const rows = rankCoinBalances([{ user: { id: 'lower' }, coins: 762 }, { user: { id: 'leader' }, coins: 839 }])
  assert.deepEqual(rows.map(({ user, coins, rank, metric }) => ({ id: user.id, coins, rank, metric })), [
    { id: 'leader', coins: 839, rank: 1, metric: 'coin_balance' },
    { id: 'lower', coins: 762, rank: 2, metric: 'coin_balance' },
  ])
})

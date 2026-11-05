import { randomInt } from 'node:crypto'

export const GAME_COLORS = ['Red', 'Green', 'Violet']
export const LEADERBOARD_METRIC = 'total_wins'

export function generateFairGameResult(colors = GAME_COLORS) {
  if (!Array.isArray(colors) || colors.length === 0) throw new Error('At least one game result must be configured')
  return colors[randomInt(colors.length)]
}

export function isValidColor(color) {
  return GAME_COLORS.includes(color)
}

export function compareTotalWins(left, right) {
  return (right.wins || 0) - (left.wins || 0)
}

export function compareCoinBalances(left, right) {
  return (right.coins || 0) - (left.coins || 0)
}

export function rankCoinBalances(rows) {
  return rows
    .slice()
    .sort(compareCoinBalances)
    .map((row, index) => ({ ...row, rank: index + 1, metric: 'coin_balance' }))
}

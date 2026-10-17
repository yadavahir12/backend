export const GAME_COLORS = ['Red', 'Green', 'Violet']
export const LEADERBOARD_METRIC = 'total_wins'

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

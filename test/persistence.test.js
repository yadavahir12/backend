import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adjustWallet,
  createGroup,
  createMessage,
  createPrediction,
  createUser,
  followUser,
  getAdminStats,
  getCurrentGameRound,
  getFollowStatus,
  getGameHistory,
  getGroup,
  getGroupMessages,
  getGroups,
  getNotifications,
  getPersistentLeaderboard,
  getUserById,
  getUserByLogin,
  getWallet,
  getWalletTransactions,
  joinGroup,
  markNotificationsRead,
  updateProfile,
  unfollowUser,
} from '../src/persistence.js'

function createFakePool(results, failAt) {
  const calls = []
  let queryIndex = 0
  let released = false
  const client = {
    async query(text, values = []) {
      calls.push({ text, values })
      if (text === 'ROLLBACK' || text === 'BEGIN' || text === 'COMMIT') return { rows: [] }
      const resultIndex = queryIndex++
      if (resultIndex === failAt) throw new Error('database failure')
      const result = results[resultIndex]
      return { rows: Array.isArray(result) ? result : result ? [result] : [] }
    },
    release() { released = true },
  }
  return {
    calls,
    get released() { return released },
    async connect() { return client },
    async query(text, values = []) {
      calls.push({ text, values })
      const resultIndex = queryIndex++
      const result = results[resultIndex]
      return { rows: Array.isArray(result) ? result : result ? [result] : [] }
    },
  }
}

test('creates a user, profile, and wallet atomically with a password hash', async () => {
  const database = createFakePool([
    { id: 'user-id', username: 'player', email: 'player@example.com', role: 'user', status: 'active' },
    { user_id: 'user-id', display_name: 'Player', bio: '', level: 1, experience: 0, privacy: {} },
    { user_id: 'user-id', balance: 0 },
  ])
  const result = await createUser({
    id: 'user-id',
    username: 'player',
    email: 'player@example.com',
    passwordHash: '$2b$12$hashed',
    displayName: 'Player',
  }, database)

  assert.equal(result.user.id, 'user-id')
  assert.equal(result.profile.userId, 'user-id')
  assert.equal(result.wallet.balance, 0)
  assert.deepEqual(database.calls.map(({ text }) => text), [
    'BEGIN',
    'INSERT INTO users (id, username, email, password_hash)\n       VALUES ($1, $2, $3, $4)\n       RETURNING id, username, email, role, status',
    'INSERT INTO profiles (user_id, display_name)\n       VALUES ($1, $2)\n       RETURNING user_id, display_name, bio, avatar_url, level, experience, privacy, created_at, updated_at',
    'INSERT INTO coin_wallets (user_id, balance)\n       VALUES ($1, 0)\n       RETURNING user_id, balance, created_at, updated_at',
    'COMMIT',
  ])
  assert.deepEqual(database.calls[1].values, ['user-id', 'player', 'player@example.com', '$2b$12$hashed'])
  assert.equal(database.released, true)
})

test('rolls back all related account inserts when profile creation fails', async () => {
  const database = createFakePool([
    { id: 'user-id', username: 'player', email: 'player@example.com', role: 'user', status: 'active' },
  ], 1)

  await assert.rejects(() => createUser({
    id: 'user-id',
    username: 'player',
    email: 'player@example.com',
    passwordHash: '$2b$12$hashed',
    displayName: 'Player',
  }, database), /database failure/)
  assert.equal(database.calls.at(-1).text, 'ROLLBACK')
  assert.equal(database.released, true)
})

test('looks up login names and authenticated users with parameterized SQL', async () => {
  const user = { id: 'user-id', username: 'player', email: 'player@example.com', role: 'user', status: 'active', display_name: 'Player', password_hash: '$2b$12$hashed' }
  const database = createFakePool([user, user])

  assert.equal((await getUserByLogin('PLAYER@EXAMPLE.COM', database)).id, 'user-id')
  assert.deepEqual(database.calls[0].values, ['PLAYER@EXAMPLE.COM'])
  assert.match(database.calls[0].text, /WHERE lower\(u\.username\) = lower\(\$1\) OR lower\(u\.email\) = lower\(\$1\)/)

  const mapped = await getUserById('user-id', database)
  assert.deepEqual(mapped, {
    id: 'user-id',
    username: 'player',
    email: 'player@example.com',
    role: 'user',
    status: 'active',
    displayName: 'Player',
  })
  assert.deepEqual(database.calls[1].values, ['user-id'])
})

test('updates username and profile fields in one parameterized transaction', async () => {
  const database = createFakePool([
    { id: 'user-id', username: 'player', email: 'player@example.com', role: 'user', status: 'active', display_name: 'Player' },
    { id: 'user-id', username: 'new-player', email: 'player@example.com', role: 'user', status: 'active' },
    { user_id: 'user-id', display_name: 'New Name', bio: 'Updated bio', level: 1, experience: 0, privacy: {} },
  ])

  const result = await updateProfile('user-id', { username: 'new-player', displayName: 'New Name', bio: 'Updated bio' }, database)

  assert.equal(result.user.username, 'new-player')
  assert.equal(result.profile.displayName, 'New Name')
  assert.equal(result.profile.bio, 'Updated bio')
  assert.match(database.calls[2].text, /username = COALESCE\(\$2, username\)/)
  assert.deepEqual(database.calls[2].values, ['user-id', 'new-player'])
  assert.deepEqual(database.calls[3].values, ['user-id', 'New Name', 'Updated bio'])
  assert.equal(database.calls.at(-1).text, 'COMMIT')
})

test('reads wallet balance and mapped transaction history from Postgres', async () => {
  const database = createFakePool([
    { user_id: 'user-id', balance: 420, created_at: 'created', updated_at: 'updated' },
    { id: 'tx-id', user_id: 'user-id', type: 'GAME_ENTRY', amount: -10, balance_before: 430, balance_after: 420, reference_type: 'round', reference_id: 'round-id', description: 'Round entry', created_at: 'created' },
  ])

  assert.deepEqual(await getWallet('user-id', database), {
    userId: 'user-id',
    balance: 420,
    createdAt: 'created',
    updatedAt: 'updated',
  })
  assert.deepEqual(await getWalletTransactions('user-id', database), [{
    id: 'tx-id',
    userId: 'user-id',
    type: 'GAME_ENTRY',
    amount: -10,
    balanceBefore: 430,
    balanceAfter: 420,
    referenceType: 'round',
    referenceId: 'round-id',
    description: 'Round entry',
    idempotencyKey: null,
    createdAt: 'created',
  }])
  assert.deepEqual(database.calls.map(({ values }) => values), [['user-id'], ['user-id']])
})

test('updates wallet and records its transaction atomically', async () => {
  const database = createFakePool([
    { user_id: 'user-id', balance: 100 },
    { user_id: 'user-id', balance: 75, created_at: 'created', updated_at: 'updated' },
    { id: 'tx-id', user_id: 'user-id', type: 'ADMIN_ADJUSTMENT', amount: -25, balance_before: 100, balance_after: 75, description: 'Adjustment', created_at: 'created' },
  ])

  const result = await adjustWallet('user-id', { amount: -25, type: 'ADMIN_ADJUSTMENT', description: 'Adjustment' }, database)
  assert.equal(result.wallet.balance, 75)
  assert.equal(result.transaction.balanceBefore, 100)
  assert.equal(result.transaction.balanceAfter, 75)
  assert.equal(database.calls[0].text, 'BEGIN')
  assert.match(database.calls[1].text, /FOR UPDATE/)
  assert.deepEqual(database.calls[2].values, ['user-id', -25])
  assert.deepEqual(database.calls[3].values.slice(1, 6), ['user-id', 'ADMIN_ADJUSTMENT', -25, 100, 75])
  assert.equal(database.calls.at(-1).text, 'COMMIT')
})

test('rejects a wallet debit that would make the balance negative', async () => {
  const database = createFakePool([{ user_id: 'user-id', balance: 3 }])

  await assert.rejects(() => adjustWallet('user-id', { amount: -5, type: 'GAME_ENTRY' }, database), /INSUFFICIENT_COINS/)
  assert.equal(database.calls.at(-1).text, 'ROLLBACK')
  assert.equal(database.calls.some(({ text }) => text.startsWith('UPDATE coin_wallets')), false)
})

test('replays an existing wallet idempotency key without applying the adjustment twice', async () => {
  const database = createFakePool([
    { id: 'tx-id', user_id: 'user-id', type: 'GAME_ENTRY', amount: -25, balance_before: 100, balance_after: 75, idempotency_key: 'entry-key' },
    { user_id: 'user-id', balance: 75, created_at: 'created', updated_at: 'updated' },
  ])

  const result = await adjustWallet('user-id', {
    amount: -25,
    type: 'GAME_ENTRY',
    idempotencyKey: 'entry-key',
  }, database)
  assert.equal(result.duplicate, true)
  assert.equal(result.wallet.balance, 75)
  assert.equal(result.transaction.id, 'tx-id')
  assert.equal(database.calls.some(({ text }) => text.startsWith('UPDATE coin_wallets')), false)
})

test('lists groups with member counts and gets a group using parameterized SQL', async () => {
  const group = { id: 'group-id', name: 'Players', icon_url: null, owner_id: 'owner-id', visibility: 'public', member_count: 2, created_at: 'created' }
  const database = createFakePool([[group], group])

  assert.deepEqual(await getGroups(database), [{
    id: 'group-id',
    name: 'Players',
    icon: null,
    ownerId: 'owner-id',
    visibility: 'public',
    memberCount: 2,
    createdAt: 'created',
  }])
  assert.match(database.calls[0].text, /FROM groups g/)
  assert.deepEqual(await getGroup('group-id', database), {
    id: 'group-id',
    name: 'Players',
    icon: null,
    ownerId: 'owner-id',
    visibility: 'public',
    memberCount: 2,
    createdAt: 'created',
  })
  assert.deepEqual(database.calls[1].values, ['group-id'])
})

test('creates a group and its owner membership in one transaction', async () => {
  const database = createFakePool([
    { id: 'group-id', name: 'Players', icon_url: 'icon', owner_id: 'owner-id', visibility: 'public', created_at: 'created' },
    undefined,
  ])

  const group = await createGroup({ id: 'group-id', name: 'Players', icon: 'icon', ownerId: 'owner-id' }, database)
  assert.equal(group.memberCount, 1)
  assert.equal(database.calls[0].text, 'BEGIN')
  assert.deepEqual(database.calls[1].values, ['group-id', 'Players', 'icon', 'owner-id', 'public'])
  assert.deepEqual(database.calls[2].values, ['group-id', 'owner-id'])
  assert.equal(database.calls.at(-1).text, 'COMMIT')
})

test('rolls back group creation if owner membership cannot be created', async () => {
  const database = createFakePool([
    { id: 'group-id', name: 'Players', icon_url: null, owner_id: 'owner-id', visibility: 'public', created_at: 'created' },
  ], 1)

  await assert.rejects(() => createGroup({ id: 'group-id', name: 'Players', ownerId: 'owner-id' }, database), /database failure/)
  assert.equal(database.calls.at(-1).text, 'ROLLBACK')
  assert.equal(database.released, true)
})

test('reads and creates messages with sender names and parameterized values', async () => {
  const row = { id: 'message-id', group_id: 'group-id', sender_id: 'user-id', sender_name: 'Player', text: 'Hello', emoji: null, created_at: 'created' }
  const database = createFakePool([[row], row])

  assert.deepEqual(await getGroupMessages('group-id', database), [{
    id: 'message-id',
    groupId: 'group-id',
    senderId: 'user-id',
    senderName: 'Player',
    text: 'Hello',
    emoji: null,
    createdAt: 'created',
  }])
  assert.deepEqual(database.calls[0].values, ['group-id'])
  assert.deepEqual(await createMessage({ id: 'message-id', groupId: 'group-id', senderId: 'user-id', text: 'Hello' }, database), {
    id: 'message-id',
    groupId: 'group-id',
    senderId: 'user-id',
    senderName: 'Player',
    text: 'Hello',
    emoji: null,
    createdAt: 'created',
  })
  assert.deepEqual(database.calls[1].values, ['message-id', 'group-id', 'user-id', 'Hello', null])
})

test('returns the active persisted round or creates the next round safely', async () => {
  const activeDatabase = createFakePool([
    undefined,
    { id: 'round-id', round_number: '2049', status: 'active', start_time: 'start', end_time: 'end', result: null },
  ])
  assert.deepEqual(await getCurrentGameRound(['Red', 'Green'], activeDatabase), {
    id: 'round-id',
    roundNumber: 2049,
    status: 'active',
    startTime: 'start',
    endTime: 'end',
    colors: ['Red', 'Green'],
    result: null,
  })
  assert.match(activeDatabase.calls[1].text, /pg_advisory_xact_lock/)
  assert.match(activeDatabase.calls[2].text, /FOR UPDATE/)

  const newDatabase = createFakePool([
    undefined,
    undefined,
    undefined,
    { round_number: '2049' },
    { id: 'next-round', round_number: '2050', status: 'active', start_time: 'start', end_time: 'end', result: null },
  ])
  const nextRound = await getCurrentGameRound(['Red', 'Green', 'Violet'], newDatabase)
  assert.equal(nextRound.roundNumber, 2050)
  assert.match(newDatabase.calls[3].text, /UPDATE game_rounds/)
  assert.equal(newDatabase.calls[5].values[1], 2050)
  assert.equal(newDatabase.calls.at(-1).text, 'COMMIT')
})

test('atomically debits coins and saves a game prediction', async () => {
  const database = createFakePool([
    { id: 'round-id', status: 'active', end_time: new Date(Date.now() + 60000).toISOString() },
    undefined,
    { user_id: 'user-id', balance: 80 },
    { balance: 55 },
    undefined,
    { id: 'prediction-id', user_id: 'user-id', round_id: 'round-id', selected_color: 'Violet', virtual_coin_amount: 25, status: 'pending', reward: 0, created_at: 'created' },
  ])

  const prediction = await createPrediction({ id: 'prediction-id', userId: 'user-id', roundId: 'round-id', color: 'Violet', amount: 25 }, database)
  assert.deepEqual(prediction, {
    id: 'prediction-id',
    userId: 'user-id',
    roundId: 'round-id',
    selectedColor: 'Violet',
    virtualCoinAmount: 25,
    status: 'pending',
    reward: 0,
    createdAt: 'created',
  })
  assert.deepEqual(database.calls[1].values, ['round-id'])
  assert.deepEqual(database.calls[2].values, ['user-id', 'round-id'])
  assert.match(database.calls[4].text, /UPDATE coin_wallets/)
  assert.deepEqual(database.calls[5].values.slice(1), ['user-id', -25, 80, 55, 'round-id', 'Round round-id', 'game-prediction:round-id:user-id'])
  assert.deepEqual(database.calls[6].values, ['prediction-id', 'user-id', 'round-id', 'Violet', 25])
  assert.equal(database.calls.at(-1).text, 'COMMIT')
})

test('rejects duplicate or underfunded predictions without a partial coin debit', async () => {
  const duplicateDatabase = createFakePool([
    { id: 'round-id', status: 'active', end_time: new Date(Date.now() + 60000).toISOString() },
    { id: 'existing-prediction' },
  ])
  await assert.rejects(
    () => createPrediction({ userId: 'user-id', roundId: 'round-id', color: 'Red', amount: 10 }, duplicateDatabase),
    /DUPLICATE_PREDICTION/,
  )
  assert.equal(duplicateDatabase.calls.at(-1).text, 'ROLLBACK')
  assert.equal(duplicateDatabase.calls.some(({ text }) => text.startsWith('UPDATE coin_wallets')), false)

  const insufficientDatabase = createFakePool([
    { id: 'round-id', status: 'active', end_time: new Date(Date.now() + 60000).toISOString() },
    undefined,
    { user_id: 'user-id', balance: 5 },
  ])
  await assert.rejects(
    () => createPrediction({ userId: 'user-id', roundId: 'round-id', color: 'Red', amount: 10 }, insufficientDatabase),
    /INSUFFICIENT_COINS/,
  )
  assert.equal(insufficientDatabase.calls.at(-1).text, 'ROLLBACK')
  assert.equal(insufficientDatabase.calls.some(({ text }) => text.startsWith('UPDATE coin_wallets')), false)
  assert.equal(insufficientDatabase.calls.some(({ text }) => text.startsWith('INSERT INTO game_predictions')), false)
})

test('rolls back the coin debit if saving the prediction fails', async () => {
  const database = createFakePool([
    { id: 'round-id', status: 'active', end_time: new Date(Date.now() + 60000).toISOString() },
    undefined,
    { user_id: 'user-id', balance: 50 },
    { balance: 40 },
    undefined,
  ], 5)
  await assert.rejects(
    () => createPrediction({ userId: 'user-id', roundId: 'round-id', color: 'Red', amount: 10 }, database),
    /database failure/,
  )
  assert.equal(database.calls.some(({ text }) => text.startsWith('UPDATE coin_wallets')), true)
  assert.equal(database.calls.some(({ text }) => text.startsWith('INSERT INTO coin_transactions')), true)
  assert.equal(database.calls.at(-1).text, 'ROLLBACK')
  assert.equal(database.released, true)
})

test('reads game history and persistent leaderboard statistics', async () => {
  const prediction = { id: 'prediction-id', user_id: 'user-id', round_id: 'round-id', selected_color: 'Green', virtual_coin_amount: 12, status: 'pending', reward: 0, created_at: 'created' }
  const historyDatabase = createFakePool([[prediction]])
  assert.deepEqual(await getGameHistory('user-id', historyDatabase), [{
    id: 'prediction-id',
    userId: 'user-id',
    roundId: 'round-id',
    selectedColor: 'Green',
    virtualCoinAmount: 12,
    status: 'pending',
    reward: 0,
    createdAt: 'created',
  }])
  assert.deepEqual(historyDatabase.calls[0].values, ['user-id'])

  const statsDatabase = createFakePool([{ id: 'user-id', username: 'player', wins: 2, games: 5 }])
  assert.deepEqual(await getPersistentLeaderboard('total_wins', statsDatabase), [{ id: 'user-id', username: 'player', wins: 2, games: 5 }])
  assert.match(statsDatabase.calls[0].text, /FILTER \(WHERE gp\.status = 'won'\)/)
})

test('persists idempotent follows and scopes status and removal to the authenticated follower', async () => {
  const followDatabase = createFakePool([ { id: 'followed-id' }, undefined ])
  assert.equal(await followUser('follower-id', 'followed-id', followDatabase), true)
  assert.deepEqual(followDatabase.calls[1].values, ['followed-id'])
  assert.deepEqual(followDatabase.calls[2].values, ['follower-id', 'followed-id'])
  assert.match(followDatabase.calls[2].text, /ON CONFLICT \(follower_id, following_id\) DO NOTHING/)
  assert.equal(followDatabase.calls.at(-1).text, 'COMMIT')

  const missingUserDatabase = createFakePool([undefined])
  assert.equal(await followUser('follower-id', 'missing-id', missingUserDatabase), false)
  assert.equal(missingUserDatabase.calls.some(({ text }) => text.startsWith('INSERT INTO follows')), false)

  const statusDatabase = createFakePool([{ following: true }])
  assert.equal(await getFollowStatus('follower-id', 'followed-id', statusDatabase), true)
  assert.deepEqual(statusDatabase.calls[0].values, ['follower-id', 'followed-id'])

  const unfollowDatabase = createFakePool([])
  await unfollowUser('follower-id', 'followed-id', unfollowDatabase)
  assert.match(unfollowDatabase.calls[0].text, /DELETE FROM follows WHERE follower_id = \$1 AND following_id = \$2/)
  assert.deepEqual(unfollowDatabase.calls[0].values, ['follower-id', 'followed-id'])

  await assert.rejects(() => followUser('SAME-ID', 'same-id', createFakePool([])), /INVALID_FOLLOW/)
})

test('reads only the current user notifications and marks only their unread notifications', async () => {
  const notification = { id: 'notification-id', user_id: 'user-id', type: 'game', title: 'Round complete', body: 'Your result is ready', read_at: null, created_at: 'created' }
  const database = createFakePool([[notification], undefined])
  assert.deepEqual(await getNotifications('user-id', database), [{
    id: 'notification-id',
    userId: 'user-id',
    type: 'game',
    title: 'Round complete',
    body: 'Your result is ready',
    readAt: null,
    createdAt: 'created',
  }])
  await markNotificationsRead('user-id', database)
  assert.deepEqual(database.calls[0].values, ['user-id'])
  assert.deepEqual(database.calls[1].values, ['user-id'])
  assert.match(database.calls[1].text, /read_at IS NULL/)
})

test('joins active public groups once and rejects private group joins', async () => {
  const database = createFakePool([
    { id: 'group-id', visibility: 'public' },
    undefined,
    undefined,
    { member_count: 3 },
  ])
  assert.deepEqual(await joinGroup('group-id', 'user-id', database), { groupId: 'group-id', joined: true, memberCount: 3 })
  assert.deepEqual(database.calls[2].values, ['group-id', 'user-id'])
  assert.deepEqual(database.calls[3].values, ['group-id', 'user-id'])
  assert.equal(database.calls.at(-1).text, 'COMMIT')

  const privateDatabase = createFakePool([{ id: 'private-group', visibility: 'private' }, undefined])
  await assert.rejects(() => joinGroup('private-group', 'user-id', privateDatabase), /GROUP_NOT_JOINABLE/)
  assert.equal(privateDatabase.calls.at(-1).text, 'ROLLBACK')
  assert.equal(privateDatabase.calls.some(({ text }) => text.startsWith('INSERT INTO group_members')), false)
})

test('reads persistent counts for the admin statistics endpoint', async () => {
  const database = createFakePool([{ users: 3, groups: 2, messages: 8, rounds: 4, transactions: 5, predictions: 6 }])
  assert.deepEqual(await getAdminStats(database), { users: 3, groups: 2, messages: 8, rounds: 4, transactions: 5, predictions: 6 })
  assert.match(database.calls[0].text, /FROM game_predictions/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adjustWallet,
  createGroup,
  createMessage,
  deleteMessage,
  createPrediction,
  createUser,
  followUser,
  getAdminCoinsDashboard,
  getAdminCoinTransactions,
  getAdminCoinUser,
  getAdminCoinUsers,
  getAdminStats,
  getCurrentGameRound,
  getFollowStatus,
  getGameResult,
  getGameHistory,
  getGameRoundHistory,
  getRoundColorStats,
  getGroup,
  getGroupMessages,
  getGroups,
  getProfileByUsername,
  isGroupMember,
  getNotifications,
  getPersistentLeaderboard,
  getUserById,
  getUserByLogin,
  getWallet,
  getWalletTransactions,
  joinGroup,
  markNotificationsRead,
  pauseGameRound,
  resumeGameRound,
  settleExpiredGameRound,
  updateProfile,
  unfollowUser,
} from '../src/persistence.js'

function createFakePool(results, failAt, failure = new Error('database failure')) {
  const calls = []
  let queryIndex = 0
  let released = false
  const client = {
    async query(text, values = []) {
      calls.push({ text, values })
      if (text === 'ROLLBACK' || text === 'BEGIN' || text === 'COMMIT') return { rows: [] }
      const resultIndex = queryIndex++
      if (resultIndex === failAt) throw failure
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

test('creates a user, profile, and 120-Coin signup bonus atomically', async () => {
  const database = createFakePool([
    { id: 'user-id', username: 'player', email: 'player@example.com', role: 'user', status: 'active' },
    { user_id: 'user-id', display_name: 'Player', bio: '', level: 1, experience: 0, privacy: {} },
    { user_id: 'user-id', balance: 120 },
  ])
  const result = await createUser({
    id: 'user-id',
    username: 'player',
    email: 'player@example.com',
    passwordHash: '$2b$12$hashed',
    displayName: 'Player',
    bonusAmount: 999,
    idempotencyKey: 'client-controlled-key',
  }, database)

  assert.deepEqual(result.user, {
    id: 'user-id',
    username: 'player',
    email: 'player@example.com',
    role: 'user',
    status: 'active',
    displayName: 'Player',
  })
  assert.equal(result.profile.userId, 'user-id')
  assert.equal(result.wallet.balance, 120)
  assert.deepEqual(database.calls.map(({ text }) => text), [
    'BEGIN',
    'INSERT INTO users (id, username, email, password_hash)\n       VALUES ($1, $2, $3, $4)\n       RETURNING id, username, email, role, status',
    'INSERT INTO profiles (user_id, display_name)\n       VALUES ($1, $2)\n       RETURNING user_id, display_name, bio, avatar_url, level, experience, privacy, created_at, updated_at',
    'INSERT INTO coin_wallets (user_id, balance)\n       VALUES ($1, 120)\n       RETURNING user_id, balance, created_at, updated_at',
    `INSERT INTO coin_transactions
         (id, user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, idempotency_key)
       VALUES ($1, $2, 'SIGNUP_BONUS', 120, 0, 120, 'signup', $3, 'Signup bonus', $4)`,
    'COMMIT',
  ])
  assert.deepEqual(database.calls[1].values, ['user-id', 'player', 'player@example.com', '$2b$12$hashed'])
  assert.deepEqual(database.calls[4].values.slice(1), ['user-id', 'user-id', 'signup-bonus:user-id'])
  assert.equal(database.calls.filter(({ text }) => text.startsWith('INSERT INTO coin_transactions')).length, 1)
  assert.equal(database.released, true)
})

test('rolls back account and wallet creation when signup bonus ledger insertion fails', async () => {
  const database = createFakePool([
    { id: 'user-id', username: 'player', email: 'player@example.com', role: 'user', status: 'active' },
    { user_id: 'user-id', display_name: 'Player', bio: '', level: 1, experience: 0, privacy: {} },
    { user_id: 'user-id', balance: 120 },
  ], 3)

  await assert.rejects(() => createUser({
    id: 'user-id',
    username: 'player',
    email: 'player@example.com',
    passwordHash: '$2b$12$hashed',
    displayName: 'Player',
  }, database), /database failure/)

  assert.equal(database.calls.some(({ text }) => text.startsWith('INSERT INTO coin_transactions')), true)
  assert.equal(database.calls.at(-1).text, 'ROLLBACK')
  assert.equal(database.released, true)
})

test('duplicate registration fails before a second signup bonus can be recorded', async () => {
  const duplicateUserError = Object.assign(new Error('duplicate user'), { code: '23505' })
  const database = createFakePool([], 0, duplicateUserError)

  await assert.rejects(() => createUser({
    id: 'user-id',
    username: 'player',
    email: 'player@example.com',
    passwordHash: '$2b$12$hashed',
    displayName: 'Player',
  }, database), { code: '23505' })

  assert.equal(database.calls.some(({ text }) => text.startsWith('INSERT INTO coin_wallets')), false)
  assert.equal(database.calls.some(({ text }) => text.startsWith('INSERT INTO coin_transactions')), false)
  assert.equal(database.calls.at(-1).text, 'ROLLBACK')
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

test('reads actual admin coin totals from wallets and adjustment transactions', async () => {
  const database = createFakePool([{
    registered_users: 3,
    total_coins_held: '1475',
    total_admin_credited: '200',
    total_admin_deducted: '35',
    admin_adjustments: 4,
  }])

  assert.deepEqual(await getAdminCoinsDashboard(database), {
    registeredUsers: 3,
    totalCoinsHeld: 1475,
    totalAdminCredited: 200,
    totalAdminDeducted: 35,
    adminAdjustments: 4,
  })
  assert.match(database.calls[0].text, /FROM coin_wallets/)
  assert.match(database.calls[0].text, /type = 'ADMIN_ADJUSTMENT'/)
})

test('searches and paginates owner coin users without exposing private fields', async () => {
  const database = createFakePool([
    { total: 1 },
    [{ id: 'user-id', username: 'player', full_name: 'Player One', balance: 245, status: 'active' }],
  ])
  const result = await getAdminCoinUsers({ search: 'player', limit: 10, offset: 20 }, database)

  assert.deepEqual(result, {
    items: [{ id: 'user-id', username: 'player', fullName: 'Player One', balance: 245, status: 'active' }],
    total: 1,
    limit: 10,
    offset: 20,
  })
  assert.deepEqual(database.calls[0].values, ['%player%'])
  assert.deepEqual(database.calls[1].values, ['%player%', 10, 20])
  assert.match(database.calls[1].text, /LEFT JOIN coin_wallets/)
  assert.doesNotMatch(database.calls[1].text, /email|password_hash|mobile/i)
})

test('looks up an owner coin user by exact ID or case-insensitive username', async () => {
  const database = createFakePool([{
    id: 'user-id',
    username: 'player',
    full_name: 'Player One',
    balance: 120,
    status: 'active',
  }])

  assert.deepEqual(await getAdminCoinUser('PLAYER', database), {
    id: 'user-id',
    username: 'player',
    fullName: 'Player One',
    balance: 120,
    status: 'active',
  })
  assert.match(database.calls[0].text, /u\.id::text = \$1 OR lower\(u\.username\) = lower\(\$1\)/)
})

test('filters and paginates coin ledger history with the admin ID and balance snapshots', async () => {
  const database = createFakePool([
    { total: 1 },
    [{
      id: 'transaction-id',
      user_id: 'user-id',
      username: 'player',
      transaction_type: 'DEBIT',
      amount: 25,
      balance_before: 100,
      balance_after: 75,
      admin_id: 'owner-id',
      description: 'Support adjustment',
      created_at: 'created',
    }],
  ])
  const result = await getAdminCoinTransactions({
    userId: 'user-id',
    type: 'debit',
    from: '2026-01-01',
    to: '2026-01-02',
    limit: 10,
    offset: 20,
  }, database)

  assert.deepEqual(result, {
    items: [{
      id: 'transaction-id',
      userId: 'user-id',
      username: 'player',
      type: 'DEBIT',
      amount: 25,
      previousBalance: 100,
      newBalance: 75,
      adminId: 'owner-id',
      reason: 'Support adjustment',
      createdAt: 'created',
    }],
    total: 1,
    limit: 10,
    offset: 20,
  })
  assert.deepEqual(database.calls[0].values, ['user-id', '2026-01-01', '2026-01-02'])
  assert.deepEqual(database.calls[1].values, ['user-id', '2026-01-01', '2026-01-02', 10, 20])
  assert.match(database.calls[1].text, /ct\.amount < 0/)
  assert.match(database.calls[1].text, /ORDER BY ct\.created_at DESC/)
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

test('records an audit event for owner wallet adjustments in the same transaction', async () => {
  const database = createFakePool([
    { user_id: 'target-id', balance: 100 },
    { user_id: 'target-id', balance: 125 },
    { id: 'transaction-id', user_id: 'target-id', type: 'ADMIN_ADJUSTMENT', amount: 25, balance_before: 100, balance_after: 125 },
    undefined,
  ])
  await adjustWallet('target-id', {
    amount: 25,
    type: 'ADMIN_ADJUSTMENT',
    description: 'Support adjustment',
    actorId: 'owner-id',
  }, database)
  assert.match(database.calls[4].text, /admin\.wallet\.adjusted/)
  assert.deepEqual(database.calls[4].values.slice(1, 3), ['owner-id', 'target-id'])
  assert.deepEqual(JSON.parse(database.calls[4].values[3]), {
    amount: 25,
    type: 'ADMIN_ADJUSTMENT',
    description: 'Support adjustment',
    transactionId: 'transaction-id',
  })
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

test('rechecks an idempotency key after locking the wallet to serialize concurrent adjustments', async () => {
  const database = createFakePool([
    undefined,
    { user_id: 'user-id', balance: 75, created_at: 'created', updated_at: 'updated' },
    {
      id: 'tx-id',
      user_id: 'user-id',
      type: 'ADMIN_ADJUSTMENT',
      amount: 25,
      balance_before: 50,
      balance_after: 75,
      reference_type: 'admin_adjustment',
      reference_id: 'owner-id',
      description: 'Manual credit',
      idempotency_key: 'same-request-key',
    },
    { user_id: 'user-id', balance: 75, created_at: 'created', updated_at: 'updated' },
  ])
  const result = await adjustWallet('user-id', {
    amount: 25,
    type: 'ADMIN_ADJUSTMENT',
    description: 'Manual credit',
    referenceType: 'admin_adjustment',
    referenceId: 'owner-id',
    idempotencyKey: 'same-request-key',
    actorId: 'owner-id',
  }, database)

  assert.equal(result.duplicate, true)
  assert.equal(result.wallet.balance, 75)
  const lockIndex = database.calls.findIndex(({ text }) => text.includes('FOR UPDATE'))
  const idempotencyIndexes = database.calls.reduce((indexes, { text }, index) => {
    if (text.includes('idempotency_key = $1')) indexes.push(index)
    return indexes
  }, [])
  assert.equal(idempotencyIndexes.length, 2)
  assert.ok(lockIndex < idempotencyIndexes[1])
  assert.equal(database.calls.some(({ text }) => text.startsWith('UPDATE coin_wallets')), false)
})

test('rejects reusing a wallet idempotency key with a different operation', async () => {
  const database = createFakePool([{
    id: 'tx-id',
    user_id: 'other-user',
    type: 'ADMIN_ADJUSTMENT',
    amount: 25,
    balance_before: 50,
    balance_after: 75,
    reference_type: 'admin_adjustment',
    reference_id: 'owner-id',
    description: 'Manual credit',
    idempotency_key: 'same-request-key',
  }])

  await assert.rejects(() => adjustWallet('user-id', {
    amount: 25,
    type: 'ADMIN_ADJUSTMENT',
    description: 'Manual credit',
    referenceType: 'admin_adjustment',
    referenceId: 'owner-id',
    idempotencyKey: 'same-request-key',
  }, database), /IDEMPOTENCY_CONFLICT/)
  assert.equal(database.calls.at(-1).text, 'ROLLBACK')
  assert.equal(database.calls.some(({ text }) => text.startsWith('UPDATE coin_wallets')), false)
})

test('lists groups with member counts and gets a group using parameterized SQL', async () => {
  const latestMessage = { text: 'Ready to play?', senderName: 'Player', createdAt: '2026-11-05T10:00:00.000Z' }
  const group = { id: 'group-id', name: 'Players', icon_url: null, owner_id: 'owner-id', visibility: 'public', member_count: 2, created_at: 'created', latest_message: latestMessage }
  const database = createFakePool([[group], { ...group, latest_message: undefined }])

  assert.deepEqual(await getGroups(database), [{
    id: 'group-id',
    name: 'Players',
    icon: null,
    ownerId: 'owner-id',
    visibility: 'public',
    memberCount: 2,
    createdAt: 'created',
    latestMessage,
  }])
  assert.match(database.calls[0].text, /FROM groups g/)
  assert.match(database.calls[0].text, /ORDER BY msg\.created_at DESC, msg\.id DESC/)
  assert.match(database.calls[0].text, /g\.visibility = 'public' OR EXISTS/)
  assert.deepEqual(database.calls[0].values, [null])
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

test('checks active group membership before authorizing a realtime room', async () => {
  const database = createFakePool([{ '?column?': 1 }, undefined])

  assert.equal(await isGroupMember('group-id', 'member-id', database), true)
  assert.equal(await isGroupMember('group-id', 'other-id', database), false)
  assert.match(database.calls[0].text, /JOIN groups g ON g\.id = gm\.group_id AND g\.status = 'active'/)
  assert.match(database.calls[0].text, /JOIN users u ON u\.id = gm\.user_id AND u\.status = 'active'/)
  assert.deepEqual(database.calls.map(({ values }) => values), [
    ['group-id', 'member-id'],
    ['group-id', 'other-id'],
  ])
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
  const row = { id: 'message-id', group_id: 'group-id', sender_id: 'user-id', sender_name: 'Player', sender_username: 'player', sender_avatar_url: null, text: 'Hello', emoji: null, created_at: 'created', deleted_at: null, reply_to_message_id: null }
  const database = createFakePool([[row], { id: 'message-id' }, row])

  assert.deepEqual(await getGroupMessages('group-id', database), [{
    id: 'message-id',
    groupId: 'group-id',
    senderId: 'user-id',
    senderName: 'Player',
    senderUsername: 'player',
    senderAvatarUrl: null,
    text: 'Hello',
    emoji: null,
    createdAt: 'created',
    deletedAt: null,
    replyTo: null,
  }])
  assert.deepEqual(database.calls[0].values, ['group-id'])
  const created = await createMessage({ id: 'message-id', groupId: 'group-id', senderId: 'user-id', text: 'Hello' }, database)
  assert.deepEqual(created, { created: true, message: {
    id: 'message-id',
    groupId: 'group-id',
    senderId: 'user-id',
    senderName: 'Player',
    senderUsername: 'player',
    senderAvatarUrl: null,
    text: 'Hello',
    emoji: null,
    createdAt: 'created',
    deletedAt: null,
    replyTo: null,
  } })
  assert.match(database.calls[2].text, /ON CONFLICT \(id\) DO NOTHING/)
  assert.deepEqual(database.calls[2].values, ['message-id', 'group-id', 'user-id', 'Hello', null, null])
  assert.deepEqual(database.calls[3].values, ['message-id'])
})

test('persists replies only to messages in the same group', async () => {
  const row = {
    id: 'reply-id', group_id: 'group-id', sender_id: 'user-id', sender_name: 'Player',
    sender_username: 'player', text: 'A reply', emoji: null, created_at: 'created',
    reply_to_message_id: 'original-id', reply_sender_name: 'Other', reply_text: 'Original',
  }
  const database = createFakePool([{ id: 'original-id' }, { id: 'reply-id' }, row])
  const result = await createMessage({
    id: 'reply-id', groupId: 'group-id', senderId: 'user-id', text: 'A reply', replyToMessageId: 'original-id',
  }, database)

  assert.equal(result.created, true)
  assert.deepEqual(result.message.replyTo, {
    id: 'original-id',
    senderName: 'Other',
    text: 'Original',
    emoji: null,
    deletedAt: null,
  })
  assert.deepEqual(database.calls[2].values, ['reply-id', 'group-id', 'user-id', 'A reply', null, 'original-id'])

  const invalidDatabase = createFakePool([])
  await assert.rejects(() => createMessage({
    groupId: 'group-id', senderId: 'user-id', text: 'A reply', replyToMessageId: 'other-group-message',
  }, invalidDatabase), /INVALID_REPLY_REFERENCE/)
  assert.equal(invalidDatabase.calls.at(-1).text, 'ROLLBACK')
})

test('retries the same client message ID without inserting a second row', async () => {
  const row = {
    id: 'message-id', group_id: 'group-id', sender_id: 'user-id', sender_name: 'Player',
    sender_username: 'player', text: 'Hello', emoji: null, created_at: 'created',
    deleted_at: null, reply_to_message_id: null,
  }
  const database = createFakePool([
    undefined,
    { group_id: 'group-id', sender_id: 'user-id' },
    row,
  ])
  const result = await createMessage({
    id: 'message-id', groupId: 'group-id', senderId: 'user-id', text: 'Hello',
  }, database)

  assert.equal(result.created, false)
  assert.equal(result.message.id, 'message-id')
  assert.match(database.calls[1].text, /ON CONFLICT \(id\) DO NOTHING/)
  assert.match(database.calls[2].text, /SELECT group_id, sender_id FROM messages WHERE id = \$1 FOR UPDATE/)
})

test('soft-deletes a message only for its original sender', async () => {
  const deletedRow = {
    id: 'message-id', group_id: 'group-id', sender_id: 'user-id', sender_name: 'Player',
    sender_username: 'player', text: 'This message was deleted', emoji: null,
    created_at: 'created', deleted_at: 'deleted',
  }
  const database = createFakePool([
    { sender_id: 'user-id', deleted_at: null },
    undefined,
    deletedRow,
  ])
  const deleted = await deleteMessage({ messageId: 'message-id', groupId: 'group-id', senderId: 'user-id' }, database)
  assert.equal(deleted.text, 'This message was deleted')
  assert.equal(deleted.deletedAt, 'deleted')
  assert.match(database.calls[2].text, /SET deleted_at = now\(\), text = '', emoji = NULL/)

  const unauthorizedDatabase = createFakePool([{ sender_id: 'another-user', deleted_at: null }])
  await assert.rejects(
    () => deleteMessage({ messageId: 'message-id', groupId: 'group-id', senderId: 'user-id' }, unauthorizedDatabase),
    /MESSAGE_FORBIDDEN/,
  )
  assert.equal(unauthorizedDatabase.calls.at(-1).text, 'ROLLBACK')
})

test('returns only public profile fields and follower counts', async () => {
  const database = createFakePool([{
    id: 'user-id',
    username: 'player',
    display_name: 'Player Name',
    bio: 'Hello',
    avatar_url: 'https://example.test/avatar.png',
    level: 4,
    experience: 230,
    followers: 12,
    following: 8,
  }])
  assert.deepEqual(await getProfileByUsername('player', database), {
    user: { id: 'user-id', username: 'player', displayName: 'Player Name' },
    profile: {
      userId: 'user-id',
      displayName: 'Player Name',
      bio: 'Hello',
      avatarUrl: 'https://example.test/avatar.png',
      level: 4,
      experience: 230,
      followers: 12,
      following: 8,
    },
  })
})

test('returns the active persisted round or creates the next round safely', async () => {
  const activeDatabase = createFakePool([
    undefined,
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
    resultGeneratedAt: null,
    pausedAt: null,
  })
  assert.match(activeDatabase.calls[1].text, /pg_advisory_xact_lock/)
  assert.match(activeDatabase.calls[3].text, /FOR UPDATE/)

  const newDatabase = createFakePool([
    undefined,
    undefined,
    undefined,
    { round_number: '2049' },
    { id: 'next-round', round_number: '2050', status: 'active', start_time: 'start', end_time: 'end', result: null },
  ])
  const nextRound = await getCurrentGameRound(['Red', 'Green', 'Violet'], newDatabase)
  assert.equal(nextRound.roundNumber, 2050)
  assert.match(newDatabase.calls[5].text, /INSERT INTO game_rounds/)
  assert.equal(newDatabase.calls[5].values[1], 2050)
  assert.equal(newDatabase.calls.at(-1).text, 'COMMIT')
})

test('settles an expired round once with a server-generated color and audits the result', async () => {
  const expiredRound = {
    id: 'round-id',
    round_number: '2050',
    status: 'active',
    start_time: 'start',
    end_time: 'end',
    result: null,
  }
  const database = createFakePool([
    undefined,
    expiredRound,
    { ...expiredRound, status: 'completed', result: 'Red', result_generated_at: 'generated' },
    undefined,
    undefined,
  ])
  const result = await settleExpiredGameRound(['Red', 'Green', 'Violet'], database)
  assert.equal(result.status, 'completed')
  assert.ok(['Red', 'Green', 'Violet'].includes(result.result))
  assert.ok(['Red', 'Green', 'Violet'].includes(database.calls[3].values[1]))
  assert.equal(JSON.parse(database.calls[5].values[2]).result, database.calls[3].values[1])
  assert.equal(result.resultGeneratedAt, 'generated')
  assert.match(database.calls[4].text, /UPDATE game_predictions/)
  assert.match(database.calls[5].text, /game\.round\.result_generated/)
  assert.equal(database.calls[5].values[2].includes('"algorithm":"node:crypto.randomInt"'), true)

  const alreadySettled = createFakePool([undefined, undefined])
  assert.equal(await settleExpiredGameRound(['Red', 'Green', 'Violet'], alreadySettled), null)
  assert.equal(alreadySettled.calls.some(({ text }) => text.includes('game.round.result_generated')), false)
})

test('calculates privacy-safe round color aggregates from prediction records', async () => {
  const database = createFakePool([{
    round_id: 'round-id',
    round_number: '2050',
    status: 'active',
    start_time: 'start',
    end_time: 'end',
    total_selections: 4,
    active_players: 3,
    red_players: 1,
    red_selections: 1,
    green_players: 1,
    green_selections: 2,
    violet_players: 1,
    violet_selections: 1,
  }])
  const result = await getRoundColorStats('round-id', database)
  assert.equal(result.activePlayers, 3)
  assert.equal(result.totalSelections, 4)
  assert.deepEqual(result.colors, {
    Red: { players: 1, selections: 1, percentage: 25 },
    Green: { players: 1, selections: 2, percentage: 50 },
    Violet: { players: 1, selections: 1, percentage: 25 },
  })
  assert.doesNotMatch(database.calls[0].text, /email|username|display_name/i)
})

test('paginates round history with status and date filters', async () => {
  const database = createFakePool([{
    id: 'round-id',
    round_number: '2050',
    status: 'completed',
    start_time: 'start',
    end_time: 'end',
    result: 'Green',
    result_generated_at: 'generated',
    total_players: 3,
    total_count: 21,
  }])
  const result = await getGameRoundHistory({
    limit: 10,
    offset: 10,
    status: 'completed',
    from: '2026-01-01T00:00:00Z',
    to: '2026-02-01T00:00:00Z',
  }, database)
  assert.deepEqual(result, {
    items: [{
      id: 'round-id',
      roundNumber: 2050,
      status: 'completed',
      startTime: 'start',
      endTime: 'end',
      result: 'Green',
      resultGeneratedAt: 'generated',
      totalPlayers: 3,
    }],
    total: 21,
  })
  assert.deepEqual(database.calls[0].values, ['completed', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 10, 10])
  assert.match(database.calls[0].text, /LEFT JOIN LATERAL/)
})

test('pauses and resumes rounds with audit records and preserves pause-adjusted time', async () => {
  const pausedDatabase = createFakePool([
    { id: 'round-id', status: 'active' },
    { id: 'round-id', round_number: 1, status: 'paused', start_time: 'start', end_time: 'end', paused_at: 'paused' },
    undefined,
  ])
  const paused = await pauseGameRound('round-id', 'owner-id', 'Technical issue', pausedDatabase)
  assert.equal(paused.status, 'paused')
  assert.match(pausedDatabase.calls[3].text, /game\.round\.paused/)
  assert.deepEqual(JSON.parse(pausedDatabase.calls[3].values[3]), { reason: 'Technical issue' })

  const resumedDatabase = createFakePool([
    { id: 'round-id', status: 'paused' },
    { id: 'round-id', round_number: 1, status: 'active', start_time: 'start', end_time: 'end' },
    undefined,
  ])
  const resumed = await resumeGameRound('round-id', 'owner-id', resumedDatabase)
  assert.equal(resumed.status, 'active')
  assert.match(resumedDatabase.calls[2].text, /end_time = end_time \+ \(now\(\) - paused_at\)/)
  assert.match(resumedDatabase.calls[3].text, /game\.round\.resumed/)
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
  assert.match(historyDatabase.calls[0].text, /JOIN game_rounds gr ON gr\.id = gp\.round_id/)

  const resultDatabase = createFakePool([{
    id: 'prediction-id',
    user_id: 'user-id',
    round_id: 'round-id',
    round_number: '2050',
    selected_color: 'Green',
    virtual_coin_amount: 12,
    status: 'won',
    reward: 24,
    created_at: 'created',
    round_result: 'Green',
    round_status: 'completed',
  }])
  assert.deepEqual(await getGameResult('prediction-id', 'user-id', resultDatabase), {
    id: 'prediction-id',
    userId: 'user-id',
    roundId: 'round-id',
    roundNumber: 2050,
    selectedColor: 'Green',
    virtualCoinAmount: 12,
    status: 'won',
    reward: 24,
    createdAt: 'created',
    result: 'Green',
    roundStatus: 'completed',
  })
  assert.deepEqual(resultDatabase.calls[0].values, ['prediction-id', 'user-id'])
  assert.match(resultDatabase.calls[0].text, /WHERE gp\.id = \$1 AND gp\.user_id = \$2/)

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

import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Server as SocketServer } from 'socket.io'
import { randomUUID } from 'node:crypto'
import { config, demoMode, pool, state } from './db.js'
import { GAME_COLORS, compareTotalWins, generateFairGameResult, rankCoinBalances } from './gameRules.js'
import { matchesOwnerEmail } from './ownerAccess.js'
import {
  createUser,
  createPrediction as createPersistentPrediction,
  createGroup as createPersistentGroup,
  createMessage as createPersistentMessage,
  deleteMessage as deletePersistentMessage,
  followUser as followPersistentUser,
  getAdminCoinsDashboard as getPersistentAdminCoinsDashboard,
  getAdminCoinTransactions as getPersistentAdminCoinTransactions,
  getAdminCoinUser as getPersistentAdminCoinUser,
  getAdminCoinUsers as getPersistentAdminCoinUsers,
  getAdminStats as getPersistentAdminStats,
  getCurrentGameRound,
  getGameRoundHistory,
  getRoundColorStats,
  pauseGameRound as pausePersistentGameRound,
  resumeGameRound as resumePersistentGameRound,
  settleExpiredGameRound,
  getGameResult as getPersistentGameResult,
  getGameRound,
  getFollowStatus as getPersistentFollowStatus,
  getGameHistory,
  adjustWallet as adjustPersistentWallet,
  getNotifications as getPersistentNotifications,
  getPersistentLeaderboard,
  getGroup as getPersistentGroup,
  getGroups as getPersistentGroups,
  getGroupMessages as getPersistentGroupMessages,
  isGroupMember as isPersistentGroupMember,
  joinGroup as joinPersistentGroup,
  markNotificationsRead as markPersistentNotificationsRead,
  getWallet as getPersistentWallet,
  getWalletTransactions as getPersistentWalletTransactions,
  getMyProfile,
  getProfileByUsername,
  getUserById,
  getUserByLogin,
  mapUser,
  unfollowUser as unfollowPersistentUser,
  updateProfile,
} from './persistence.js'

const app = Fastify({ logger: true })
const corsOrigins = [...new Set([
  config.CLIENT_URL,
  'https://win-chat-frontend-pearl.vercel.app',
  'https://win-chat-frontend-beta.vercel.app',
  'https://win-chat-frontend.vercel.app',
  'https://win-chat-frontend-two.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
].filter((origin) => origin && origin !== '*'))]
const corsOptions = { origin: corsOrigins, credentials: true, methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'] }
await app.register(cors, corsOptions)
await app.register(cookie)
const io = new SocketServer(app.server, { cors: corsOptions })

const now = () => new Date().toISOString()
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const publicUser = (user) => ({ id: user.id, username: user.username, email: user.email, role: user.role, status: user.status, displayName: user.displayName })
const demoPlayer = { name: 'Alex Morgan', username: '@alexm', coins: 1250, level: 18, currentXp: 720, wins: 142, gamesPlayed: 180 }
function issueToken(user) { return jwt.sign({ sub: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: '7d' }) }
async function currentUser(request) {
  const token = request.cookies.session || request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  let claims
  try {
    claims = jwt.verify(token, config.JWT_SECRET)
  } catch {
    return null
  }
  if (!demoMode) return getUserById(claims.sub)
  return state.users.find((user) => user.id === claims.sub) || null
}
async function requireAuth(request, reply) {
  const user = await currentUser(request)
  if (!user) return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
  request.user = user
}
async function requireOwnerAdmin(request, reply) {
  await requireAuth(request, reply)
  if (reply.sent) return
  if (!matchesOwnerEmail(request.user.email, config.OWNER_EMAIL)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Owner access required' } })
}
function seed() {
  if (state.users.length) return
  const id = 'demo-user-alex'
  const user = { id, username: demoPlayer.username, email: 'alex@example.com', passwordHash: bcrypt.hashSync('demo-password', 10), role: 'user', status: 'active', displayName: demoPlayer.name, wins: demoPlayer.wins, gamesPlayed: demoPlayer.gamesPlayed, createdAt: now() }
  state.users.push(user)
  state.profiles.push({ userId: id, displayName: demoPlayer.name, bio: '', avatarUrl: null, level: demoPlayer.level, experience: demoPlayer.currentXp })
  state.wallets.push({ userId: id, balance: demoPlayer.coins })
  state.groups.push({ id: 'demo-color-chasers', name: 'Color Chasers', icon: null, ownerId: id, visibility: 'public', memberCount: 128, createdAt: now() })
}
if (demoMode) seed()

function settleDemoRound(round) {
  if (!round || round.status !== 'active' || round.result || new Date(round.endTime) > new Date()) return null
  const result = generateFairGameResult(GAME_COLORS)
  round.status = 'completed'
  round.result = result
  round.resultGeneratedAt = now()
  for (const prediction of state.predictions) {
    if (prediction.roundId === round.id && prediction.status === 'pending') {
      prediction.status = prediction.selectedColor === result ? 'won' : 'lost'
    }
  }
  state.auditEvents.push({
    id: randomUUID(),
    actorId: null,
    action: 'game.round.result_generated',
    entityType: 'game_round',
    entityId: round.id,
    metadata: { result, algorithm: 'node:crypto.randomInt', colorCount: GAME_COLORS.length },
    createdAt: now(),
  })
  return round
}

function getDemoCurrentRound() {
  const previous = state.rounds.at(-1)
  settleDemoRound(previous)
  let round = state.rounds.slice().reverse().find((item) => item.status === 'active' || item.status === 'paused')
  if (round) return round
  const start = Date.now()
  round = {
    id: randomUUID(),
    roundNumber: (previous?.roundNumber || 2048) + 1,
    status: 'active',
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + 42000).toISOString(),
    colors: GAME_COLORS,
    result: null,
    resultGeneratedAt: null,
    pausedAt: null,
  }
  state.rounds.push(round)
  return round
}

function getDemoRoundStatistics(round) {
  if (!round) return null
  const predictions = state.predictions.filter((item) => item.roundId === round.id)
  const totalSelections = predictions.length
  const colors = Object.fromEntries(GAME_COLORS.map((color) => {
    const matches = predictions.filter((item) => item.selectedColor === color)
    return [color, {
      players: new Set(matches.map((item) => item.userId)).size,
      selections: matches.length,
      percentage: totalSelections ? Number((matches.length * 100 / totalSelections).toFixed(1)) : 0,
    }]
  }))
  return {
    roundId: round.id,
    roundNumber: round.roundNumber,
    status: round.status,
    startTime: round.startTime,
    endTime: round.endTime,
    result: round.result || null,
    resultGeneratedAt: round.resultGeneratedAt || null,
    pausedAt: round.pausedAt || null,
    totalSelections,
    activePlayers: new Set(predictions.map((item) => item.userId)).size,
    colors,
  }
}

function getDemoRoundHistory({ limit, offset, status, from, to }) {
  const filtered = state.rounds
    .filter((round) => !status || round.status === status)
    .filter((round) => !from || new Date(round.startTime) >= new Date(from))
    .filter((round) => !to || new Date(round.startTime) < new Date(to))
    .sort((left, right) => right.roundNumber - left.roundNumber)
  return {
    items: filtered.slice(offset, offset + limit).map((round) => ({
      id: round.id,
      roundNumber: round.roundNumber,
      status: round.status,
      startTime: round.startTime,
      endTime: round.endTime,
      result: round.result || null,
      resultGeneratedAt: round.resultGeneratedAt || null,
      totalPlayers: new Set(state.predictions.filter((item) => item.roundId === round.id).map((item) => item.userId)).size,
    })),
    total: filtered.length,
  }
}

async function getOwnerDashboardSnapshot() {
  const round = demoMode ? getDemoCurrentRound() : await getCurrentGameRound(GAME_COLORS)
  const statistics = demoMode
    ? getDemoRoundStatistics(round)
    : await getRoundColorStats(round.id)
  return { currentRound: round, statistics }
}

async function publishOwnerDashboardUpdate() {
  try {
    const snapshot = await getOwnerDashboardSnapshot()
    io.to('admin:game').emit('admin.game.updated', snapshot)
  } catch (error) {
    app.log.error(error, 'Unable to publish game dashboard update')
  }
}

app.get('/health', async () => ({ success: true, data: { status: 'ok', database: demoMode ? 'demo-memory' : 'postgres-configured', timestamp: now() } }))
app.post('/api/auth/register', async (request, reply) => {
  const { username, email, password, displayName = username } = request.body || {}
  if (!username || !email || !password || password.length < 8) return reply.code(400).send({ success: false, error: { code: 'INVALID_INPUT', message: 'Username, email, and an 8-character password are required' } })
  const normalizedUsername = username.trim()
  const normalizedEmail = email.trim().toLowerCase()
  const normalizedDisplayName = String(displayName).trim()
  const passwordHash = await bcrypt.hash(password, 12)
  if (!demoMode) {
    try {
      const created = await createUser({
        username: normalizedUsername,
        email: normalizedEmail,
        passwordHash,
        displayName: normalizedDisplayName || normalizedUsername,
      })
      return reply.code(201).send({ success: true, data: { user: created.user, token: issueToken(created.user) } })
    } catch (error) {
      if (error.code === '23505') return reply.code(409).send({ success: false, error: { code: 'DUPLICATE_USER', message: 'Username or email already exists' } })
      throw error
    }
  }
  if (state.users.some((user) => user.username === username || user.email === email)) return reply.code(409).send({ success: false, error: { code: 'DUPLICATE_USER', message: 'Username or email already exists' } })
  const user = { id: randomUUID(), username: normalizedUsername, email: normalizedEmail, passwordHash, role: 'user', status: 'active', displayName: normalizedDisplayName || normalizedUsername, wins: 0, gamesPlayed: 0, createdAt: now() }
  state.users.push(user); state.profiles.push({ userId: user.id, displayName: user.displayName, bio: '', avatarUrl: null, level: 1, experience: 0 }); state.wallets.push({ userId: user.id, balance: 0 })
  return reply.code(201).send({ success: true, data: { user: publicUser(user), token: issueToken(user) } })
})
app.post('/api/auth/login', async (request, reply) => {
  const { username, password } = request.body || {}
  const user = demoMode
    ? state.users.find((item) => item.username === username || item.email === username)
    : await getUserByLogin(username || '')
  const passwordHash = user?.passwordHash || user?.password_hash
  if (!user || !(await bcrypt.compare(password || '', passwordHash || ''))) return reply.code(401).send({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } })
  if (user.status !== 'active') return reply.code(403).send({ success: false, error: { code: 'ACCOUNT_DISABLED', message: 'Account is not active' } })
  const responseUser = demoMode ? publicUser(user) : mapUser(user)
  return { success: true, data: { user: responseUser, token: issueToken(responseUser) } }
})
app.post('/api/auth/logout', async (request, reply) => { reply.clearCookie('session', { path: '/' }); return { success: true, data: null } })
app.post('/api/auth/forgot-password', async () => ({ success: true, data: { message: 'If the account exists, reset instructions will be sent.' } }))
app.get('/api/users/me', { preHandler: requireAuth }, async (request) => ({
  success: true,
  data: { ...publicUser(request.user), isOwnerAdmin: matchesOwnerEmail(request.user.email, config.OWNER_EMAIL) },
}))
app.get('/api/users/me/profile', { preHandler: requireAuth }, async (request) => ({
  success: true,
  data: demoMode
    ? { user: publicUser(request.user), profile: state.profiles.find((item) => item.userId === request.user.id), wallet: state.wallets.find((item) => item.userId === request.user.id) }
    : await getMyProfile(request.user.id),
}))
app.get('/api/users/:username/profile', async (request, reply) => {
  if (!demoMode) {
    const profile = await getProfileByUsername(request.params.username)
    if (!profile) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } })
    return { success: true, data: profile }
  }
  const user = state.users.find((item) => item.username.toLowerCase() === request.params.username.toLowerCase())
  if (!user) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } })
  const profile = state.profiles.find((item) => item.userId === user.id)
  return {
    success: true,
    data: {
      user: { id: user.id, username: user.username, displayName: user.displayName },
      profile: {
        userId: user.id,
        displayName: profile?.displayName || user.displayName,
        bio: profile?.bio || '',
        avatarUrl: profile?.avatarUrl || null,
        level: profile?.level || 1,
        experience: profile?.experience || 0,
        followers: state.follows.filter((follow) => follow.followingId === user.id).length,
        following: state.follows.filter((follow) => follow.followerId === user.id).length,
      },
    },
  }
})
app.patch('/api/users/me', { preHandler: requireAuth }, async (request, reply) => {
  const { displayName, username, bio } = request.body || {}
  if (!demoMode) {
    try {
      const updated = await updateProfile(request.user.id, { displayName, username, bio })
      if (!updated) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } })
      return { success: true, data: updated }
    } catch (error) {
      if (error.code === '23505') return reply.code(409).send({ success: false, error: { code: 'DUPLICATE_USER', message: 'Username already exists' } })
      throw error
    }
  }
  if (displayName) request.user.displayName = displayName.trim()
  if (username) request.user.username = username.trim()
  const profile = state.profiles.find((item) => item.userId === request.user.id)
  if (bio !== undefined) profile.bio = String(bio)
  profile.displayName = request.user.displayName
  return { success: true, data: { user: publicUser(request.user), profile } }
})
app.post('/api/users/:id/follow', { preHandler: requireAuth }, async (request, reply) => {
  if (String(request.user.id).toLowerCase() === String(request.params.id).toLowerCase()) return reply.code(400).send({ success: false, error: { code: 'INVALID_FOLLOW', message: 'You cannot follow yourself' } })
  if (!demoMode && !isUuid(request.params.id)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } })
  if (demoMode) {
    if (!state.users.some((user) => user.id === request.params.id)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } })
    if (!state.follows.some((item) => item.followerId === request.user.id && item.followingId === request.params.id)) state.follows.push({ followerId: request.user.id, followingId: request.params.id, createdAt: now() })
  } else if (!await followPersistentUser(request.user.id, request.params.id)) {
    return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } })
  }
  return { success: true, data: { following: true } }
})
app.delete('/api/users/:id/follow', { preHandler: requireAuth }, async (request) => {
  if (demoMode) state.follows = state.follows.filter((item) => !(item.followerId === request.user.id && item.followingId === request.params.id))
  else if (isUuid(request.params.id)) await unfollowPersistentUser(request.user.id, request.params.id)
  return { success: true, data: { following: false } }
})
app.get('/api/users/:id/follow-status', { preHandler: requireAuth }, async (request) => ({
  success: true,
  data: {
    following: demoMode
      ? state.follows.some((item) => item.followerId === request.user.id && item.followingId === request.params.id)
      : isUuid(request.params.id) && await getPersistentFollowStatus(request.user.id, request.params.id),
  },
}))
app.get('/api/coin-packages', async () => ({ success: true, data: state.packages.filter((item) => item.isActive).sort((a, b) => a.displayOrder - b.displayOrder) }))
app.get('/api/wallet', { preHandler: requireAuth }, async (request) => ({
  success: true,
  data: demoMode
    ? state.wallets.find((wallet) => wallet.userId === request.user.id)
    : await getPersistentWallet(request.user.id),
}))
app.get('/api/wallet/transactions', { preHandler: requireAuth }, async (request) => ({
  success: true,
  data: demoMode
    ? state.transactions.filter((item) => item.userId === request.user.id)
    : await getPersistentWalletTransactions(request.user.id),
}))
function adjustWallet(userId, amount, type, description, referenceId = null) { const wallet = state.wallets.find((item) => item.userId === userId); if (!wallet || wallet.balance + amount < 0) throw new Error('INSUFFICIENT_COINS'); const before = wallet.balance; wallet.balance += amount; state.transactions.push({ id: randomUUID(), userId, type, amount, balanceBefore: before, balanceAfter: wallet.balance, description, referenceId, createdAt: now() }); return wallet }

const maxCoinBalance = 2_147_483_647
function getDemoCoinUser(user) {
  const profile = state.profiles.find((item) => item.userId === user.id)
  const wallet = state.wallets.find((item) => item.userId === user.id)
  return {
    id: user.id,
    username: user.username,
    fullName: profile?.displayName || user.displayName || user.username,
    balance: wallet?.balance || 0,
    status: user.status,
  }
}
function getDemoAdminCoinDashboard() {
  const adjustments = state.transactions.filter((item) => item.type === 'ADMIN_ADJUSTMENT')
  return {
    registeredUsers: state.users.length,
    totalCoinsHeld: state.wallets.reduce((sum, wallet) => sum + wallet.balance, 0),
    totalAdminCredited: adjustments.reduce((sum, item) => sum + Math.max(item.amount, 0), 0),
    totalAdminDeducted: adjustments.reduce((sum, item) => sum + Math.max(-item.amount, 0), 0),
    adminAdjustments: adjustments.length,
  }
}
function getDemoAdminCoinUsers({ search, limit, offset }) {
  const query = search.trim().toLowerCase()
  const filtered = state.users
    .filter((user) => !query || user.id.toLowerCase().includes(query) || user.username.toLowerCase().includes(query))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  return { items: filtered.slice(offset, offset + limit).map(getDemoCoinUser), total: filtered.length, limit, offset }
}
function getDemoAdminCoinUser(identifier) {
  const normalized = identifier.toLowerCase()
  const user = state.users.find((item) => item.id.toLowerCase() === normalized || item.username.toLowerCase() === normalized)
  return user ? getDemoCoinUser(user) : null
}
function getDemoAdminCoinTransactions({ userId, type, from, to, limit, offset }) {
  const filtered = state.transactions
    .filter((item) => !userId || item.userId === userId)
    .filter((item) => type === 'all' || (type === 'credit' ? item.amount > 0 : item.amount < 0))
    .filter((item) => !from || new Date(item.createdAt) >= new Date(from))
    .filter((item) => !to || new Date(item.createdAt) < new Date(to))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
  return {
    items: filtered.slice(offset, offset + limit).map((item) => ({
      id: item.id,
      userId: item.userId,
      username: state.users.find((user) => user.id === item.userId)?.username || '',
      type: item.amount > 0 ? 'CREDIT' : 'DEBIT',
      amount: Math.abs(item.amount),
      previousBalance: item.balanceBefore,
      newBalance: item.balanceAfter,
      adminId: item.type === 'ADMIN_ADJUSTMENT' ? item.referenceId || null : null,
      reason: item.description || '',
      createdAt: item.createdAt,
    })),
    total: filtered.length,
    limit,
    offset,
  }
}
function validateCoinListQuery(query, reply) {
  const limit = Number(query.limit ?? 20)
  const offset = Number(query.offset ?? 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isInteger(offset) || offset < 0
    || (query.search && String(query.search).length > 120)
    || (query.userId && String(query.userId).length > 120)
    || (query.type && !['all', 'credit', 'debit'].includes(query.type))
    || (query.from && !Number.isFinite(Date.parse(query.from)))
    || (query.to && !Number.isFinite(Date.parse(query.to)))) {
    reply.code(400).send({ success: false, error: { code: 'INVALID_FILTER', message: 'Coins filters are invalid' } })
    return null
  }
  return { limit, offset }
}
function validateAdminAdjustment(body, { signed = false } = {}) {
  const userId = String(body?.userId || '').trim()
  const amount = Number(body?.amount)
  const reason = String(body?.reason || '').trim()
  const idempotencyKey = String(body?.idempotencyKey || '').trim()
  if (!userId || userId.length > 120) throw new Error('INVALID_COIN_ADJUSTMENT')
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > maxCoinBalance || (!signed && amount < 1)) {
    throw new Error('INVALID_COIN_ADJUSTMENT')
  }
  if (reason.length < 3 || reason.length > 300) throw new Error('INVALID_ADJUSTMENT_REASON')
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new Error('INVALID_IDEMPOTENCY_KEY')
  return { userId, amount, reason, idempotencyKey }
}
function applyDemoAdminCoinAdjustment(userId, amount, reason, idempotencyKey, actorId) {
  const referenceType = 'admin_adjustment'
  const referenceId = actorId
  const existing = state.transactions.find((item) => item.idempotencyKey === idempotencyKey)
  if (existing) {
    if (existing.userId !== userId
      || existing.type !== 'ADMIN_ADJUSTMENT'
      || existing.amount !== amount
      || existing.description !== reason
      || existing.referenceType !== referenceType
      || existing.referenceId !== referenceId) {
      throw new Error('IDEMPOTENCY_CONFLICT')
    }
    const wallet = state.wallets.find((item) => item.userId === userId)
    if (!wallet) throw new Error('WALLET_NOT_FOUND')
    return { wallet, transaction: existing, duplicate: true }
  }
  const wallet = state.wallets.find((item) => item.userId === userId)
  if (!wallet) throw new Error('WALLET_NOT_FOUND')
  if (wallet.balance + amount < 0) throw new Error('INSUFFICIENT_COINS')
  if (wallet.balance + amount > maxCoinBalance) throw new Error('BALANCE_LIMIT_EXCEEDED')
  const balanceBefore = wallet.balance
  wallet.balance += amount
  const transaction = {
    id: randomUUID(),
    userId,
    type: 'ADMIN_ADJUSTMENT',
    amount,
    balanceBefore,
    balanceAfter: wallet.balance,
    referenceType,
    referenceId,
    description: reason,
    idempotencyKey,
    createdAt: now(),
  }
  state.transactions.push(transaction)
  state.auditEvents.push({
    id: randomUUID(),
    actorId,
    action: 'admin.wallet.adjusted',
    entityType: 'user_wallet',
    entityId: userId,
    metadata: { amount, type: 'ADMIN_ADJUSTMENT', reason, transactionId: transaction.id },
    createdAt: now(),
  })
  return { wallet, transaction, duplicate: false }
}
async function applyAdminCoinAdjustment(request, reply, amount, { legacy = false, direction = 'credit' } = {}) {
  let input
  try {
    input = validateAdminAdjustment({ ...request.body, amount }, { signed: legacy })
  } catch (error) {
    const messages = {
      INVALID_COIN_ADJUSTMENT: 'User and a valid positive integer coin amount are required',
      INVALID_ADJUSTMENT_REASON: 'A reason of 3-300 characters is required',
      INVALID_IDEMPOTENCY_KEY: 'A valid idempotency key is required',
    }
    return reply.code(400).send({ success: false, error: { code: error.message, message: messages[error.message] || 'Wallet adjustment is invalid' } })
  }
  try {
    const signedAmount = legacy ? input.amount : direction === 'debit' ? -input.amount : input.amount
    const result = demoMode
      ? applyDemoAdminCoinAdjustment(input.userId, signedAmount, input.reason, input.idempotencyKey, request.user.id)
      : await adjustPersistentWallet(input.userId, {
        amount: signedAmount,
        type: 'ADMIN_ADJUSTMENT',
        description: input.reason,
        referenceType: 'admin_adjustment',
        referenceId: request.user.id,
        idempotencyKey: input.idempotencyKey,
        actorId: request.user.id,
      })
    if (legacy) return reply.send({ success: true, data: result.wallet })
    return reply.code(result.duplicate ? 200 : 201).send({
      success: true,
      data: { wallet: result.wallet, transaction: result.transaction, duplicate: result.duplicate },
    })
  } catch (error) {
    const errors = {
      WALLET_NOT_FOUND: [404, 'User wallet not found'],
      INSUFFICIENT_COINS: [409, 'The wallet does not have enough coins'],
      BALANCE_LIMIT_EXCEEDED: [409, 'The resulting wallet balance exceeds the supported limit'],
      IDEMPOTENCY_CONFLICT: [409, 'This idempotency key was already used for a different adjustment'],
    }
    const knownError = errors[error.message]
      || (error.code === '23505' && error.constraint?.includes('idempotency') ? [409, 'This idempotency key was already used'] : null)
    if (!knownError) throw error
    return reply.code(knownError[0]).send({ success: false, error: { code: error.message, message: knownError[1] } })
  }
}

app.get('/api/admin/coins/dashboard', { preHandler: requireOwnerAdmin }, async () => ({
  success: true,
  data: demoMode ? getDemoAdminCoinDashboard() : await getPersistentAdminCoinsDashboard(),
}))
app.get('/api/admin/coins/users', { preHandler: requireOwnerAdmin }, async (request, reply) => {
  const pagination = validateCoinListQuery(request.query, reply)
  if (!pagination) return
  const options = { ...pagination, search: String(request.query.search || '') }
  return {
    success: true,
    data: demoMode ? getDemoAdminCoinUsers(options) : await getPersistentAdminCoinUsers(options),
  }
})
app.get('/api/admin/coins/users/:identifier', { preHandler: requireOwnerAdmin }, async (request, reply) => {
  const identifier = String(request.params.identifier || '').trim()
  if (!identifier || identifier.length > 120) return reply.code(400).send({ success: false, error: { code: 'INVALID_USER', message: 'A valid user ID or username is required' } })
  const user = demoMode ? getDemoAdminCoinUser(identifier) : await getPersistentAdminCoinUser(identifier)
  if (!user) return reply.code(404).send({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } })
  return { success: true, data: user }
})
app.get('/api/admin/coins/transactions', { preHandler: requireOwnerAdmin }, async (request, reply) => {
  const pagination = validateCoinListQuery(request.query, reply)
  if (!pagination) return
  const options = {
    ...pagination,
    userId: String(request.query.userId || ''),
    type: request.query.type || 'all',
    from: request.query.from || null,
    to: request.query.to || null,
  }
  return {
    success: true,
    data: demoMode ? getDemoAdminCoinTransactions(options) : await getPersistentAdminCoinTransactions(options),
  }
})
app.post('/api/admin/coins/credit', { preHandler: requireOwnerAdmin }, async (request, reply) => {
  const amount = Number(request.body?.amount)
  return applyAdminCoinAdjustment(request, reply, amount)
})
app.post('/api/admin/coins/debit', { preHandler: requireOwnerAdmin }, async (request, reply) => {
  const amount = Number(request.body?.amount)
  return applyAdminCoinAdjustment(request, reply, amount, { direction: 'debit' })
})
app.post('/api/admin/wallet-adjustments', { preHandler: requireOwnerAdmin }, async (request, reply) => {
  return applyAdminCoinAdjustment(request, reply, Number(request.body?.amount), { legacy: true })
})
app.get('/api/groups', { preHandler: requireAuth }, async () => ({
  success: true,
  data: demoMode ? state.groups : await getPersistentGroups(),
}))
app.post('/api/groups', { preHandler: requireAuth }, async (request, reply) => {
  const name = String(request.body?.name || '').trim()
  if (!name) return reply.code(400).send({ success: false, error: { code: 'INVALID_GROUP', message: 'Group name is required' } })
  const groupData = {
    id: randomUUID(),
    name,
    icon: request.body.icon || null,
    ownerId: request.user.id,
    visibility: request.body.visibility || 'public',
    memberCount: 1,
    createdAt: now(),
  }
  const group = demoMode
    ? (state.groups.unshift(groupData), groupData)
    : await createPersistentGroup(groupData)
  return reply.code(201).send({ success: true, data: group })
})
app.post('/api/groups/:id/join', { preHandler: requireAuth }, async (request, reply) => {
  if (demoMode) {
    const group = state.groups.find((item) => item.id === request.params.id)
    if (!group) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    if (group.visibility !== 'public') return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'This group cannot be joined' } })
    if (!Array.isArray(group.members)) group.members = []
    const alreadyMember = group.members.some((member) => member.userId === request.user.id || member.id === request.user.id)
    if (!alreadyMember) {
      group.members.push({ userId: request.user.id })
      group.memberCount = Number(group.memberCount || 0) + 1
    }
    return { success: true, data: { groupId: group.id, joined: !alreadyMember, memberCount: group.memberCount } }
  }
  if (!isUuid(request.params.id)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
  try {
    const result = await joinPersistentGroup(request.params.id, request.user.id)
    if (!result) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    return { success: true, data: result }
  } catch (error) {
    if (error.message === 'GROUP_NOT_JOINABLE') return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'This group cannot be joined' } })
    throw error
  }
})
app.get('/api/groups/:id', { preHandler: requireAuth }, async (request, reply) => {
  const group = demoMode
    ? state.groups.find((item) => item.id === request.params.id)
    : isUuid(request.params.id)
      ? await getPersistentGroup(request.params.id)
      : null
  if (!group) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
  return { success: true, data: group }
})
app.get('/api/groups/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
  if (demoMode) {
    const group = state.groups.find((item) => item.id === request.params.id)
    if (!group) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    if (!group.members?.some((member) => member.userId === request.user.id || member.id === request.user.id)) {
      return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Group access denied' } })
    }
    return {
      success: true,
      data: state.messages.filter((item) => item.groupId === request.params.id).map((message) => {
        if (!message.replyToMessageId) return message
        const original = state.messages.find((item) => item.id === message.replyToMessageId && item.groupId === request.params.id)
        if (!original) return message
        return {
          ...message,
          replyTo: {
            id: original.id,
            senderName: original.senderName,
            text: original.deletedAt ? 'This message was deleted' : original.text,
            emoji: original.deletedAt ? null : original.emoji || null,
            deletedAt: original.deletedAt || null,
          },
        }
      }),
    }
  }
  if (!isUuid(request.params.id)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
  if (!await getPersistentGroup(request.params.id)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
  if (!await isPersistentGroupMember(request.params.id, request.user.id)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Group access denied' } })
  return { success: true, data: await getPersistentGroupMessages(request.params.id) }
})
app.post('/api/groups/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
  const text = String(request.body?.text || '').trim()
  if (!text || text.length > 2000) return reply.code(400).send({ success: false, error: { code: 'INVALID_MESSAGE', message: 'Message must be 1-2000 characters' } })
  const replyToMessageId = request.body?.replyToMessageId || null
  const clientMessageId = request.body?.clientMessageId || null
  if (clientMessageId && !isUuid(clientMessageId)) return reply.code(400).send({ success: false, error: { code: 'INVALID_MESSAGE_ID', message: 'Client message ID must be a UUID' } })
  let created = true
  if (!demoMode) {
    if (!isUuid(request.params.id) || !await getPersistentGroup(request.params.id)) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    }
    if (!await isPersistentGroupMember(request.params.id, request.user.id)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Group access denied' } })
    if (replyToMessageId && !isUuid(replyToMessageId)) return reply.code(400).send({ success: false, error: { code: 'INVALID_REPLY_REFERENCE', message: 'Reply target is invalid' } })
    let message
    try {
      const result = await createPersistentMessage({
        id: clientMessageId || randomUUID(),
        groupId: request.params.id,
        senderId: request.user.id,
        text,
        emoji: request.body?.emoji || null,
        replyToMessageId,
      })
      message = result.message
      created = result.created
      if (created) io.to(`group:${request.params.id}`).emit('message.created', message)
    } catch (error) {
      if (error.message === 'INVALID_REPLY_REFERENCE') return reply.code(400).send({ success: false, error: { code: 'INVALID_REPLY_REFERENCE', message: 'Reply target must be in this chat' } })
      if (error.message === 'MESSAGE_ID_CONFLICT') return reply.code(409).send({ success: false, error: { code: 'MESSAGE_ID_CONFLICT', message: 'Client message ID is already in use' } })
      throw error
    }
    return reply.code(created ? 201 : 200).send({ success: true, data: message })
  }
  const group = state.groups.find((item) => item.id === request.params.id)
  if (!group) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
  if (!group.members?.some((member) => member.userId === request.user.id || member.id === request.user.id)) {
    return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Group access denied' } })
  }
  if (clientMessageId) {
    const existing = state.messages.find((item) => item.id === clientMessageId)
    if (existing) {
      if (existing.groupId !== request.params.id || existing.senderId !== request.user.id) {
        return reply.code(409).send({ success: false, error: { code: 'MESSAGE_ID_CONFLICT', message: 'Client message ID is already in use' } })
      }
      return reply.send({ success: true, data: existing })
    }
  }
  const original = replyToMessageId && state.messages.find((item) => item.id === replyToMessageId && item.groupId === request.params.id)
  if (replyToMessageId && !original) return reply.code(400).send({ success: false, error: { code: 'INVALID_REPLY_REFERENCE', message: 'Reply target must be in this chat' } })
  const message = {
    id: clientMessageId || randomUUID(),
    groupId: request.params.id,
    senderId: request.user.id,
    senderName: request.user.displayName,
    senderUsername: request.user.username,
    senderAvatarUrl: state.profiles.find((item) => item.userId === request.user.id)?.avatarUrl || null,
    text,
    emoji: request.body?.emoji || null,
    createdAt: now(),
    deletedAt: null,
    replyTo: original ? {
      id: original.id,
      senderName: original.senderName,
      text: original.deletedAt ? 'This message was deleted' : original.text,
      emoji: original.deletedAt ? null : original.emoji || null,
      deletedAt: original.deletedAt || null,
    } : null,
  }
  message.replyToMessageId = replyToMessageId
  state.messages.push(message)
  io.to(`group:${request.params.id}`).emit('message.created', message)
  return reply.code(201).send({ success: true, data: message })
})
app.delete('/api/groups/:id/messages/:messageId', { preHandler: requireAuth }, async (request, reply) => {
  const { id: groupId, messageId } = request.params
  if (!demoMode && (!isUuid(groupId) || !isUuid(messageId))) {
    return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Message not found' } })
  }
  let message
  if (demoMode) {
    const group = state.groups.find((item) => item.id === groupId)
    if (!group) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    if (!group.members?.some((member) => member.userId === request.user.id || member.id === request.user.id)) {
      return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Group access denied' } })
    }
    const existing = state.messages.find((item) => item.id === messageId && item.groupId === groupId)
    if (!existing) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Message not found' } })
    if (existing.senderId !== request.user.id) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'You can only delete your own messages' } })
    if (!existing.deletedAt) {
      existing.text = 'This message was deleted'
      existing.emoji = null
      existing.deletedAt = now()
    }
    message = existing
  } else {
    if (!await getPersistentGroup(groupId)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    if (!await isPersistentGroupMember(groupId, request.user.id)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Group access denied' } })
    try {
      message = await deletePersistentMessage({ messageId, groupId, senderId: request.user.id })
    } catch (error) {
      if (error.message === 'MESSAGE_FORBIDDEN') return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'You can only delete your own messages' } })
      throw error
    }
    if (!message) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Message not found' } })
  }
  io.to(`group:${groupId}`).emit('message.deleted', message)
  return { success: true, data: message }
})
app.get('/api/game/rounds/current', async () => {
  const finalized = demoMode
    ? settleDemoRound(state.rounds.slice().reverse().find((item) => item.status === 'active'))
    : await settleExpiredGameRound(GAME_COLORS)
  if (finalized) void publishOwnerDashboardUpdate()
  return { success: true, data: demoMode ? getDemoCurrentRound() : await getCurrentGameRound(GAME_COLORS) }
})
app.post('/api/game/rounds/:id/predictions', { preHandler: requireAuth }, async (request, reply) => {
  const amount = Number(request.body?.amount)
  const round = demoMode
    ? state.rounds.find((item) => item.id === request.params.id)
    : isUuid(request.params.id)
      ? await getGameRound(request.params.id)
      : null
  if (!round || round.status !== 'active' || new Date(round.endTime ?? round.end_time) <= new Date()) return reply.code(400).send({ success: false, error: { code: 'ROUND_CLOSED', message: 'Round is closed' } })
  if (!GAME_COLORS.includes(request.body?.color) || !Number.isInteger(amount) || amount <= 0) return reply.code(400).send({ success: false, error: { code: 'INVALID_PREDICTION', message: 'Prediction is invalid' } })
  if (demoMode && state.predictions.some((item) => item.userId === request.user.id && item.roundId === round.id)) return reply.code(409).send({ success: false, error: { code: 'DUPLICATE_PREDICTION', message: 'Prediction already placed' } })
  const roundNumber = round.roundNumber ?? round.round_number
  try {
    if (demoMode) {
      adjustWallet(request.user.id, -amount, 'GAME_ENTRY', `Round ${roundNumber}`, round.id)
    }
    else {
      const prediction = await createPersistentPrediction({
        userId: request.user.id,
        roundId: round.id,
        color: request.body.color,
        amount,
      })
      void publishOwnerDashboardUpdate()
      return reply.code(201).send({ success: true, data: prediction })
    }
  } catch (error) {
    if (error.message === 'DUPLICATE_PREDICTION') return reply.code(409).send({ success: false, error: { code: error.message, message: 'Prediction already placed' } })
    if (error.message === 'ROUND_CLOSED') return reply.code(400).send({ success: false, error: { code: error.message, message: 'Round is closed' } })
    if (error.message === 'INSUFFICIENT_COINS') return reply.code(400).send({ success: false, error: { code: 'INSUFFICIENT_COINS', message: 'Not enough virtual coins' } })
    throw error
  }
  const prediction = { id: randomUUID(), userId: request.user.id, roundId: round.id, selectedColor: request.body.color, virtualCoinAmount: amount, status: 'pending', createdAt: now() }
  state.predictions.push(prediction)
  void publishOwnerDashboardUpdate()
  return reply.code(201).send({ success: true, data: prediction })
})
app.get('/api/games/history', { preHandler: requireAuth }, async (request) => ({
  success: true,
  data: demoMode ? state.predictions.filter((item) => item.userId === request.user.id) : await getGameHistory(request.user.id),
}))
app.get('/api/game/predictions/:id/result', { preHandler: requireAuth }, async (request, reply) => {
  if (!isUuid(request.params.id)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Game result not found' } })
  const prediction = demoMode
    ? state.predictions.find((item) => item.id === request.params.id && item.userId === request.user.id)
    : await getPersistentGameResult(request.params.id, request.user.id)
  if (!prediction) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Game result not found' } })
  const round = demoMode ? state.rounds.find((item) => item.id === prediction.roundId) : null
  const data = demoMode
    ? {
      ...prediction,
      roundNumber: round?.roundNumber ?? null,
      result: round?.result ?? null,
      roundStatus: round?.status ?? null,
    }
    : prediction
  return { success: true, data }
})
app.get('/api/leaderboard', async (request) => {
  if (request.query.metric === 'coins') {
    if (!demoMode) {
      const rows = await getPersistentLeaderboard('coins')
      return {
        success: true,
        data: rankCoinBalances(rows.map((row) => ({
          user: {
            id: row.id,
            username: row.username,
            displayName: row.display_name || row.username,
            avatarUrl: row.avatar_url,
            level: row.level || 1,
          },
          coins: row.coins,
        }))),
      }
    }
    const rows = state.users.map((user) => {
      const profile = state.profiles.find((item) => item.userId === user.id)
      const wallet = state.wallets.find((item) => item.userId === user.id)
      return {
        user: {
          id: user.id,
          username: user.username,
          displayName: profile?.displayName || user.displayName,
          avatarUrl: profile?.avatarUrl || null,
          level: profile?.level || 1,
        },
        coins: wallet?.balance || 0,
      }
    })
    return { success: true, data: rankCoinBalances(rows) }
  }

  if (!demoMode) {
    const rows = await getPersistentLeaderboard('total_wins')
    return {
      success: true,
      data: rows.map((row, index) => ({
        user: publicUser(mapUser(row)),
        wins: row.wins,
        games: row.games,
        score: row.wins,
        rank: index + 1,
        metric: 'total_wins',
      })),
    }
  }
  const rows = state.users.map((user) => ({ user: publicUser(user), wins: user.wins || 0, games: user.gamesPlayed || 0, score: user.wins || 0 })).sort(compareTotalWins).map((row, index) => ({ ...row, rank: index + 1, metric: 'total_wins' }))
  return { success: true, data: rows }
})
app.get('/api/notifications', { preHandler: requireAuth }, async (request) => ({
  success: true,
  data: demoMode ? state.notifications.filter((item) => item.userId === request.user.id) : await getPersistentNotifications(request.user.id),
}))
app.post('/api/notifications/read-all', { preHandler: requireAuth }, async (request) => {
  if (demoMode) state.notifications.filter((item) => item.userId === request.user.id).forEach((item) => { item.readAt = now() })
  else await markPersistentNotificationsRead(request.user.id)
  return { success: true, data: null }
})
app.get('/api/admin/stats', { preHandler: requireOwnerAdmin }, async () => ({
  success: true,
  data: demoMode
    ? { users: state.users.length, groups: state.groups.length, messages: state.messages.length, rounds: state.rounds.length, transactions: state.transactions.length }
    : await getPersistentAdminStats(),
}))
app.get('/api/admin/game', { preHandler: requireOwnerAdmin }, async () => {
  const dashboard = await getOwnerDashboardSnapshot()
  const history = demoMode
    ? getDemoRoundHistory({ limit: 10, offset: 0 })
    : await getGameRoundHistory({ limit: 10, offset: 0 })
  return { success: true, data: { ...dashboard, history } }
})
app.get('/api/admin/game/rounds', { preHandler: requireOwnerAdmin }, async (request, reply) => {
  const { status, from, to } = request.query
  const allowedStatuses = new Set(['scheduled', 'active', 'closed', 'processing', 'completed', 'paused'])
  const limit = Number(request.query.limit ?? 10)
  const offset = Number(request.query.offset ?? 0)
  if ((status && status !== 'all' && !allowedStatuses.has(status))
    || !Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isInteger(offset) || offset < 0
    || (from && !Number.isFinite(Date.parse(from)))
    || (to && !Number.isFinite(Date.parse(to)))) {
    return reply.code(400).send({ success: false, error: { code: 'INVALID_FILTER', message: 'Round history filters are invalid' } })
  }
  const filters = { limit, offset, status: status === 'all' ? null : status, from, to }
  const history = demoMode ? getDemoRoundHistory(filters) : await getGameRoundHistory(filters)
  return { success: true, data: history }
})
app.post('/api/admin/game/rounds/:id/pause', { preHandler: requireOwnerAdmin }, async (request, reply) => {
  const roundId = request.params.id
  const reason = String(request.body?.reason || '').trim()
  if (!isUuid(roundId)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Round not found' } })
  if (reason.length < 3 || reason.length > 300) return reply.code(400).send({ success: false, error: { code: 'INVALID_REASON', message: 'A pause reason of 3-300 characters is required' } })
  try {
    let round
    if (demoMode) {
      round = state.rounds.find((item) => item.id === roundId)
      if (!round) throw new Error('ROUND_NOT_FOUND')
      if (round.status !== 'active') throw new Error('ROUND_NOT_ACTIVE')
      if (new Date(round.endTime) <= new Date()) throw new Error('ROUND_CLOSED')
      round.status = 'paused'
      round.pausedAt = now()
      state.auditEvents.push({ id: randomUUID(), actorId: request.user.id, action: 'game.round.paused', entityType: 'game_round', entityId: roundId, metadata: { reason }, createdAt: now() })
    } else {
      round = await pausePersistentGameRound(roundId, request.user.id, reason)
    }
    void publishOwnerDashboardUpdate()
    return { success: true, data: round }
  } catch (error) {
    if (error.message === 'ROUND_NOT_FOUND') return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Round not found' } })
    if (error.message === 'ROUND_NOT_ACTIVE') return reply.code(409).send({ success: false, error: { code: 'ROUND_NOT_ACTIVE', message: 'Only an active round can be paused' } })
    if (error.message === 'ROUND_CLOSED') return reply.code(409).send({ success: false, error: { code: 'ROUND_CLOSED', message: 'An expired round cannot be paused' } })
    throw error
  }
})
app.post('/api/admin/game/rounds/:id/resume', { preHandler: requireOwnerAdmin }, async (request, reply) => {
  const roundId = request.params.id
  if (!isUuid(roundId)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Round not found' } })
  try {
    let round
    if (demoMode) {
      round = state.rounds.find((item) => item.id === roundId)
      if (!round) throw new Error('ROUND_NOT_FOUND')
      if (round.status !== 'paused') throw new Error('ROUND_NOT_PAUSED')
      const pausedDuration = Date.now() - new Date(round.pausedAt).getTime()
      round.endTime = new Date(new Date(round.endTime).getTime() + pausedDuration).toISOString()
      round.pausedAt = null
      round.status = 'active'
      state.auditEvents.push({ id: randomUUID(), actorId: request.user.id, action: 'game.round.resumed', entityType: 'game_round', entityId: roundId, metadata: {}, createdAt: now() })
    } else {
      round = await resumePersistentGameRound(roundId, request.user.id)
    }
    void publishOwnerDashboardUpdate()
    return { success: true, data: round }
  } catch (error) {
    if (error.message === 'ROUND_NOT_FOUND') return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Round not found' } })
    if (error.message === 'ROUND_NOT_PAUSED') return reply.code(409).send({ success: false, error: { code: 'ROUND_NOT_PAUSED', message: 'Only a paused round can be resumed' } })
    throw error
  }
})

io.use(async (socket, next) => {
  try {
    const claims = jwt.verify(socket.handshake.auth?.token, config.JWT_SECRET)
    const user = demoMode
      ? state.users.find((item) => item.id === claims.sub)
      : await getUserById(claims.sub)
    if (!user || user.status !== 'active') throw new Error('Unauthorized')
    socket.user = { sub: user.id, email: user.email }
    next()
  } catch {
    next(new Error('Unauthorized'))
  }
})
io.on('connection', (socket) => {
  socket.on('admin.game.join', async (acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {}
    if (!matchesOwnerEmail(socket.user.email, config.OWNER_EMAIL)) {
      respond({ success: false, error: { code: 'FORBIDDEN', message: 'Owner access required' } })
      return
    }
    await socket.join('admin:game')
    respond({ success: true })
  })
  socket.on('group.join', async (groupId, acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {}
    try {
      const authorized = typeof groupId === 'string' && (demoMode
        ? state.users.some((user) => user.id === socket.user.sub && user.status === 'active')
          && state.groups.find((group) => group.id === groupId)?.members?.some((member) => member.userId === socket.user.sub || member.id === socket.user.sub)
        : isUuid(groupId) && await isPersistentGroupMember(groupId, socket.user.sub))
      if (!authorized) {
        respond({ success: false, error: { code: 'FORBIDDEN', message: 'Group access denied' } })
        return
      }
      await socket.join(`group:${groupId}`)
      respond({ success: true })
    } catch (error) {
      app.log.error(error, 'Unable to authorize Socket.IO group join')
      respond({ success: false, error: { code: 'INTERNAL', message: 'Unable to join group' } })
    }
  })
  socket.on('group.leave', (groupId) => {
    if (typeof groupId === 'string') socket.leave(`group:${groupId}`)
  })
  socket.on('typing', ({ groupId, typing } = {}) => {
    if (typeof groupId === 'string' && socket.rooms.has(`group:${groupId}`)) {
      socket.to(`group:${groupId}`).emit('typing', { userId: socket.user.sub, typing })
    }
  })
})

const roundSettlementInterval = setInterval(async () => {
  try {
    const completed = demoMode
      ? settleDemoRound(state.rounds.slice().reverse().find((item) => item.status === 'active'))
      : await settleExpiredGameRound(GAME_COLORS)
    if (completed) await publishOwnerDashboardUpdate()
  } catch (error) {
    app.log.error(error, 'Unable to settle an expired game round')
  }
}, 1000)
roundSettlementInterval.unref()

const port = Number(config.PORT)
await app.listen({ port, host: '0.0.0.0' })
app.log.info(`OtazexPlay backend listening on ${port} (${demoMode ? 'demo memory mode' : 'postgres mode'})`)

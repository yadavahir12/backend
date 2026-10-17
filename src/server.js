import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Server as SocketServer } from 'socket.io'
import { randomUUID } from 'node:crypto'
import { config, demoMode, pool, state } from './db.js'
import { GAME_COLORS, compareTotalWins, rankCoinBalances } from './gameRules.js'
import {
  createUser,
  createPrediction as createPersistentPrediction,
  createGroup as createPersistentGroup,
  createMessage as createPersistentMessage,
  followUser as followPersistentUser,
  getAdminStats as getPersistentAdminStats,
  getCurrentGameRound,
  getGameRound,
  getFollowStatus as getPersistentFollowStatus,
  getGameHistory,
  adjustWallet as adjustPersistentWallet,
  getNotifications as getPersistentNotifications,
  getPersistentLeaderboard,
  getGroup as getPersistentGroup,
  getGroups as getPersistentGroups,
  getGroupMessages as getPersistentGroupMessages,
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
await app.register(cors, { origin: config.CLIENT_URL, credentials: true })
await app.register(cookie)
const io = new SocketServer(app.server, { cors: { origin: config.CLIENT_URL, credentials: true } })

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
async function requireAdmin(request, reply) {
  await requireAuth(request, reply)
  if (reply.sent) return
  if (!['admin', 'super_admin', 'moderator'].includes(request.user.role)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Administrator access required' } })
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
app.get('/api/users/me', { preHandler: requireAuth }, async (request) => ({ success: true, data: publicUser(request.user) }))
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
  const user = state.users.find((item) => item.username === request.params.username)
  if (!user) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } })
  return { success: true, data: { user: publicUser(user), profile: state.profiles.find((item) => item.userId === user.id), wallet: state.wallets.find((item) => item.userId === user.id) } }
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
app.post('/api/admin/wallet-adjustments', { preHandler: requireAdmin }, async (request, reply) => {
  try {
    if (demoMode) {
      const wallet = adjustWallet(request.body.userId, Number(request.body.amount), 'ADMIN_ADJUSTMENT', request.body.reason || 'Admin adjustment')
      return { success: true, data: wallet }
    }
    const result = await adjustPersistentWallet(request.body.userId, {
      amount: Number(request.body.amount),
      type: 'ADMIN_ADJUSTMENT',
      description: request.body.reason || 'Admin adjustment',
    })
    return { success: true, data: result.wallet }
  } catch (error) {
    const code = error.message === 'INSUFFICIENT_COINS' ? error.message : error.message === 'WALLET_NOT_FOUND' ? error.message : 'INVALID_COIN_ADJUSTMENT'
    return reply.code(400).send({ success: false, error: { code, message: 'Wallet adjustment failed' } })
  }
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
    if (!state.groups.some((item) => item.id === request.params.id)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    return { success: true, data: state.messages.filter((item) => item.groupId === request.params.id) }
  }
  if (!isUuid(request.params.id)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
  if (!await getPersistentGroup(request.params.id)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
  return { success: true, data: await getPersistentGroupMessages(request.params.id) }
})
app.post('/api/groups/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
  const text = String(request.body?.text || '').trim()
  if (!text || text.length > 2000) return reply.code(400).send({ success: false, error: { code: 'INVALID_MESSAGE', message: 'Message must be 1-2000 characters' } })
  if (!demoMode) {
    if (!isUuid(request.params.id) || !await getPersistentGroup(request.params.id)) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
    }
    const message = await createPersistentMessage({
      id: randomUUID(),
      groupId: request.params.id,
      senderId: request.user.id,
      text,
      emoji: request.body?.emoji || null,
    })
    io.to(`group:${request.params.id}`).emit('message.created', message)
    return reply.code(201).send({ success: true, data: message })
  }
  if (!state.groups.some((item) => item.id === request.params.id)) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
  const message = { id: randomUUID(), groupId: request.params.id, senderId: request.user.id, senderName: request.user.displayName, text, emoji: request.body?.emoji || null, createdAt: now() }
  state.messages.push(message)
  io.to(`group:${request.params.id}`).emit('message.created', message)
  return reply.code(201).send({ success: true, data: message })
})
app.get('/api/game/rounds/current', async () => {
  if (!demoMode) return { success: true, data: await getCurrentGameRound(GAME_COLORS) }
  let round = state.rounds.at(-1)
  if (!round || new Date(round.endTime) <= new Date()) {
    const start = Date.now()
    round = { id: randomUUID(), roundNumber: (round?.roundNumber || 2048) + 1, status: 'active', startTime: new Date(start).toISOString(), endTime: new Date(start + 42000).toISOString(), colors: GAME_COLORS, result: null }
    state.rounds.push(round)
  }
  return { success: true, data: round }
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
  return reply.code(201).send({ success: true, data: prediction })
})
app.get('/api/games/history', { preHandler: requireAuth }, async (request) => ({
  success: true,
  data: demoMode ? state.predictions.filter((item) => item.userId === request.user.id) : await getGameHistory(request.user.id),
}))
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
app.get('/api/admin/stats', { preHandler: requireAdmin }, async () => ({
  success: true,
  data: demoMode
    ? { users: state.users.length, groups: state.groups.length, messages: state.messages.length, rounds: state.rounds.length, transactions: state.transactions.length }
    : await getPersistentAdminStats(),
}))

io.use((socket, next) => { try { const token = socket.handshake.auth?.token; socket.user = jwt.verify(token, config.JWT_SECRET); next() } catch { next(new Error('Unauthorized')) } })
io.on('connection', (socket) => { socket.on('group.join', (groupId) => socket.join(`group:${groupId}`)); socket.on('group.leave', (groupId) => socket.leave(`group:${groupId}`)); socket.on('typing', ({ groupId, typing }) => socket.to(`group:${groupId}`).emit('typing', { userId: socket.user.sub, typing })) })

const port = Number(config.PORT)
await app.listen({ port, host: '0.0.0.0' })
app.log.info(`OtazexPlay backend listening on ${port} (${demoMode ? 'demo memory mode' : 'postgres mode'})`)

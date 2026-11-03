import { randomUUID } from 'node:crypto'
import { pool, withTransaction } from './db.js'

export function mapUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    displayName: row.display_name ?? row.displayName,
  }
}

export function mapProfile(row) {
  if (!row) return null
  return {
    userId: row.user_id ?? row.userId,
    displayName: row.display_name ?? row.displayName,
    bio: row.bio || '',
    avatarUrl: row.avatar_url ?? row.avatarUrl ?? null,
    level: row.level,
    experience: row.experience,
    privacy: row.privacy || {},
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  }
}

export function mapWallet(row) {
  if (!row) return null
  return {
    userId: row.user_id ?? row.userId,
    balance: row.balance,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  }
}

export function mapCoinTransaction(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id ?? row.userId,
    type: row.type,
    amount: row.amount,
    balanceBefore: row.balance_before ?? row.balanceBefore,
    balanceAfter: row.balance_after ?? row.balanceAfter,
    referenceType: row.reference_type ?? row.referenceType ?? null,
    referenceId: row.reference_id ?? row.referenceId ?? null,
    description: row.description || '',
    idempotencyKey: row.idempotency_key ?? row.idempotencyKey ?? null,
    createdAt: row.created_at ?? row.createdAt,
  }
}

export function mapGroup(row) {
  if (!row) return null
  const group = {
    id: row.id,
    name: row.name,
    icon: row.icon_url ?? row.icon ?? null,
    ownerId: row.owner_id ?? row.ownerId,
    visibility: row.visibility,
    memberCount: Number(row.member_count ?? row.memberCount ?? 0),
    createdAt: row.created_at ?? row.createdAt,
  }
  return group
}

export function mapMessage(row) {
  if (!row) return null
  const deletedAt = row.deleted_at ?? row.deletedAt ?? null
  const replyToMessageId = row.reply_to_message_id ?? row.replyToMessageId ?? null
  return {
    id: row.id,
    groupId: row.group_id ?? row.groupId,
    senderId: row.sender_id ?? row.senderId,
    senderName: row.sender_name ?? row.senderName,
    senderUsername: row.sender_username ?? row.senderUsername ?? null,
    senderAvatarUrl: row.sender_avatar_url ?? row.senderAvatarUrl ?? null,
    text: deletedAt ? 'This message was deleted' : row.text,
    emoji: deletedAt ? null : row.emoji ?? null,
    createdAt: row.created_at ?? row.createdAt,
    deletedAt,
    replyTo: replyToMessageId ? {
      id: replyToMessageId,
      senderName: row.reply_sender_name ?? null,
      text: row.reply_text ?? '',
      emoji: row.reply_emoji ?? null,
      deletedAt: row.reply_deleted_at ?? null,
    } : null,
  }
}

export function mapGameRound(row) {
  if (!row) return null
  return {
    id: row.id,
    roundNumber: Number(row.round_number ?? row.roundNumber),
    status: row.status,
    startTime: row.start_time ?? row.startTime,
    endTime: row.end_time ?? row.endTime,
    colors: row.colors,
    result: row.result ?? null,
  }
}

export function mapPrediction(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id ?? row.userId,
    roundId: row.round_id ?? row.roundId,
    selectedColor: row.selected_color ?? row.selectedColor,
    virtualCoinAmount: row.virtual_coin_amount ?? row.virtualCoinAmount,
    status: row.status,
    reward: row.reward ?? 0,
    createdAt: row.created_at ?? row.createdAt,
  }
}

export function mapNotification(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id ?? row.userId,
    type: row.type,
    title: row.title,
    body: row.body,
    readAt: row.read_at ?? row.readAt ?? null,
    createdAt: row.created_at ?? row.createdAt,
  }
}

export async function createUser({ id = randomUUID(), username, email, passwordHash, displayName }, database = pool) {
  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO users (id, username, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, role, status`,
      [id, username, email, passwordHash],
    )
    const user = inserted.rows[0]
    const profile = await client.query(
      `INSERT INTO profiles (user_id, display_name)
       VALUES ($1, $2)
       RETURNING user_id, display_name, bio, avatar_url, level, experience, privacy, created_at, updated_at`,
      [user.id, displayName],
    )
    const wallet = await client.query(
      `INSERT INTO coin_wallets (user_id, balance)
       VALUES ($1, 120)
       RETURNING user_id, balance, created_at, updated_at`,
      [user.id],
    )
    await client.query(
      `INSERT INTO coin_transactions
         (id, user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, idempotency_key)
       VALUES ($1, $2, 'SIGNUP_BONUS', 120, 0, 120, 'signup', $3, 'Signup bonus', $4)`,
      [randomUUID(), user.id, user.id, `signup-bonus:${user.id}`],
    )
    return {
      user: mapUser({ ...user, display_name: displayName }),
      profile: mapProfile(profile.rows[0]),
      wallet: mapWallet(wallet.rows[0]),
    }
  }, database)
}

export async function getUserByLogin(login, database = pool) {
  const result = await database.query(
    `SELECT u.id, u.username, u.email, u.password_hash, u.role, u.status,
            p.display_name
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     WHERE lower(u.username) = lower($1) OR lower(u.email) = lower($1)
     LIMIT 1`,
    [login],
  )
  return result.rows[0] || null
}

export async function getUserById(userId, database = pool) {
  const result = await database.query(
    `SELECT u.id, u.username, u.email, u.role, u.status, p.display_name
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  )
  return mapUser(result.rows[0])
}

export async function getMyProfile(userId, database = pool) {
  const [userResult, profileResult, walletResult] = await Promise.all([
    database.query(
      `SELECT u.id, u.username, u.email, u.role, u.status, p.display_name
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    ),
    database.query(
      `SELECT user_id, display_name, bio, avatar_url, level, experience, privacy, created_at, updated_at
       FROM profiles WHERE user_id = $1`,
      [userId],
    ),
    database.query(
      `SELECT user_id, balance, created_at, updated_at
       FROM coin_wallets WHERE user_id = $1`,
      [userId],
    ),
  ])
  if (!userResult.rows[0]) return null
  return {
    user: mapUser(userResult.rows[0]),
    profile: mapProfile(profileResult.rows[0]),
    wallet: mapWallet(walletResult.rows[0]),
  }
}

export async function getProfileByUsername(username, database = pool) {
  const userResult = await database.query(
    `SELECT u.id, u.username, p.display_name, p.bio, p.avatar_url, p.level, p.experience,
            (SELECT count(*)::int FROM follows f WHERE f.following_id = u.id) AS followers,
            (SELECT count(*)::int FROM follows f WHERE f.follower_id = u.id) AS following
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     WHERE lower(u.username) = lower($1) AND u.status = 'active'`,
    [username],
  )
  const user = userResult.rows[0]
  if (!user) return null
  return {
    user: { id: user.id, username: user.username, displayName: user.display_name },
    profile: {
      userId: user.id,
      displayName: user.display_name || user.username,
      bio: user.bio || '',
      avatarUrl: user.avatar_url || null,
      level: user.level,
      experience: user.experience,
      followers: user.followers,
      following: user.following,
    },
  }
}

export async function updateProfile(userId, { username, displayName, bio }, database = pool) {
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT u.id, u.username, u.email, u.role, u.status, p.display_name
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    )
    if (!existing.rows[0]) return null
    const currentUser = existing.rows[0]
    const nextUsername = username?.trim() || null
    const nextDisplayName = displayName?.trim() || currentUser.display_name || currentUser.username
    const updatedUser = await client.query(
      `UPDATE users
       SET username = COALESCE($2, username), updated_at = now()
       WHERE id = $1
       RETURNING id, username, email, role, status`,
      [userId, nextUsername],
    )
    const updatedProfile = await client.query(
      `UPDATE profiles
       SET display_name = $2, bio = COALESCE($3, bio), updated_at = now()
       WHERE user_id = $1
       RETURNING user_id, display_name, bio, avatar_url, level, experience, privacy, created_at, updated_at`,
      [userId, nextDisplayName, bio === undefined ? null : String(bio)],
    )
    return {
      user: mapUser({ ...updatedUser.rows[0], display_name: nextDisplayName }),
      profile: mapProfile(updatedProfile.rows[0]),
    }
  }, database)
}

export async function getWallet(userId, database = pool) {
  const result = await database.query(
    `SELECT user_id, balance, created_at, updated_at
     FROM coin_wallets WHERE user_id = $1`,
    [userId],
  )
  return mapWallet(result.rows[0])
}

export async function getWalletTransactions(userId, database = pool) {
  const result = await database.query(
    `SELECT id, user_id, type, amount, balance_before, balance_after,
            reference_type, reference_id, description, idempotency_key, created_at
     FROM coin_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  )
  return result.rows.map(mapCoinTransaction)
}

export async function adjustWallet(userId, { amount, type, description, referenceType = null, referenceId = null, idempotencyKey = null }, database = pool) {
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error('INVALID_COIN_ADJUSTMENT')
  return withTransaction(async (client) => {
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT id, user_id, type, amount, balance_before, balance_after,
                reference_type, reference_id, description, idempotency_key, created_at
         FROM coin_transactions WHERE idempotency_key = $1`,
        [idempotencyKey],
      )
      if (existing.rows[0]) {
        const wallet = await client.query(
          `SELECT user_id, balance, created_at, updated_at
           FROM coin_wallets WHERE user_id = $1`,
          [userId],
        )
        return { wallet: mapWallet(wallet.rows[0]), transaction: mapCoinTransaction(existing.rows[0]), duplicate: true }
      }
    }

    const locked = await client.query(
      `SELECT user_id, balance, created_at, updated_at
       FROM coin_wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    )
    const currentWallet = locked.rows[0]
    if (!currentWallet) throw new Error('WALLET_NOT_FOUND')
    if (currentWallet.balance + amount < 0) throw new Error('INSUFFICIENT_COINS')

    const updated = await client.query(
      `UPDATE coin_wallets
       SET balance = balance + $2, updated_at = now()
       WHERE user_id = $1
       RETURNING user_id, balance, created_at, updated_at`,
      [userId, amount],
    )
    const transaction = await client.query(
      `INSERT INTO coin_transactions
         (id, user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, user_id, type, amount, balance_before, balance_after,
                 reference_type, reference_id, description, idempotency_key, created_at`,
      [
        randomUUID(),
        userId,
        type,
        amount,
        currentWallet.balance,
        updated.rows[0].balance,
        referenceType,
        referenceId == null ? null : String(referenceId),
        description || '',
        idempotencyKey,
      ],
    )
    return { wallet: mapWallet(updated.rows[0]), transaction: mapCoinTransaction(transaction.rows[0]), duplicate: false }
  }, database)
}

export async function getCurrentGameRound(colors, database = pool) {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [684029])
    const active = await client.query(
      `SELECT id, round_number, status, start_time, end_time, result
       FROM game_rounds
       WHERE status = 'active' AND end_time > now()
       ORDER BY round_number DESC
       LIMIT 1
       FOR UPDATE`,
    )
    if (active.rows[0]) return mapGameRound({ ...active.rows[0], colors })

    await client.query(
      `UPDATE game_rounds SET status = 'completed', updated_at = now()
       WHERE status = 'active' AND end_time <= now()`,
    )
    const latest = await client.query('SELECT COALESCE(MAX(round_number), 2048) AS round_number FROM game_rounds')
    const startTime = new Date()
    const endTime = new Date(startTime.getTime() + 42000)
    const created = await client.query(
      `INSERT INTO game_rounds (id, round_number, status, start_time, end_time)
       VALUES ($1, $2, 'active', $3, $4)
       RETURNING id, round_number, status, start_time, end_time, result`,
      [randomUUID(), Number(latest.rows[0].round_number) + 1, startTime, endTime],
    )
    return mapGameRound({ ...created.rows[0], colors })
  }, database)
}

export async function getGameRound(roundId, database = pool) {
  const result = await database.query(
    `SELECT id, round_number, status, start_time, end_time, result
     FROM game_rounds WHERE id = $1`,
    [roundId],
  )
  return mapGameRound(result.rows[0])
}

export async function createPrediction({ id = randomUUID(), userId, roundId, color, amount }, database = pool) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('INVALID_PREDICTION')
  return withTransaction(async (client) => {
    const roundResult = await client.query(
      `SELECT id, status, end_time
       FROM game_rounds WHERE id = $1 FOR UPDATE`,
      [roundId],
    )
    const round = roundResult.rows[0]
    if (!round || round.status !== 'active' || new Date(round.end_time) <= new Date()) throw new Error('ROUND_CLOSED')

    const existing = await client.query(
      `SELECT id FROM game_predictions WHERE user_id = $1 AND round_id = $2`,
      [userId, roundId],
    )
    if (existing.rows[0]) throw new Error('DUPLICATE_PREDICTION')

    const walletResult = await client.query(
      `SELECT user_id, balance
       FROM coin_wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    )
    const wallet = walletResult.rows[0]
    if (!wallet) throw new Error('WALLET_NOT_FOUND')
    if (wallet.balance < amount) throw new Error('INSUFFICIENT_COINS')

    const updatedWallet = await client.query(
      `UPDATE coin_wallets SET balance = balance - $2, updated_at = now()
       WHERE user_id = $1
       RETURNING balance`,
      [userId, amount],
    )
    await client.query(
      `INSERT INTO coin_transactions
         (id, user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, idempotency_key)
       VALUES ($1, $2, 'GAME_ENTRY', $3, $4, $5, 'game_round', $6, $7, $8)`,
      [
        randomUUID(),
        userId,
        -amount,
        wallet.balance,
        updatedWallet.rows[0].balance,
        roundId,
        `Round ${roundId}`,
        `game-prediction:${roundId}:${userId}`,
      ],
    )
    const prediction = await client.query(
      `INSERT INTO game_predictions (id, user_id, round_id, selected_color, virtual_coin_amount)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, round_id, selected_color, virtual_coin_amount, status, reward, created_at`,
      [id, userId, roundId, color, amount],
    )
    return mapPrediction(prediction.rows[0])
  }, database)
}

export async function getGameHistory(userId, database = pool) {
  const result = await database.query(
    `SELECT id, user_id, round_id, selected_color, virtual_coin_amount, status, reward, created_at
     FROM game_predictions
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  )
  return result.rows.map(mapPrediction)
}

export async function followUser(followerId, followingId, database = pool) {
  if (String(followerId).toLowerCase() === String(followingId).toLowerCase()) throw new Error('INVALID_FOLLOW')
  return withTransaction(async (client) => {
    const target = await client.query(
      `SELECT id FROM users WHERE id = $1 AND status = 'active' FOR KEY SHARE`,
      [followingId],
    )
    if (!target.rows[0]) return false
    await client.query(
      `INSERT INTO follows (follower_id, following_id)
       VALUES ($1, $2)
       ON CONFLICT (follower_id, following_id) DO NOTHING`,
      [followerId, followingId],
    )
    return true
  }, database)
}

export async function unfollowUser(followerId, followingId, database = pool) {
  await database.query(
    `DELETE FROM follows WHERE follower_id = $1 AND following_id = $2`,
    [followerId, followingId],
  )
}

export async function getFollowStatus(followerId, followingId, database = pool) {
  const result = await database.query(
    `SELECT EXISTS (
       SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2
     ) AS following`,
    [followerId, followingId],
  )
  return result.rows[0].following
}

export async function getNotifications(userId, database = pool) {
  const result = await database.query(
    `SELECT id, user_id, type, title, body, read_at, created_at
     FROM notifications WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  )
  return result.rows.map(mapNotification)
}

export async function markNotificationsRead(userId, database = pool) {
  await database.query(
    `UPDATE notifications SET read_at = now()
     WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  )
}

export async function getPersistentLeaderboard(metric, database = pool) {
  if (metric === 'coins') {
    const result = await database.query(
      `SELECT u.id, u.username, p.display_name, p.avatar_url, p.level,
              COALESCE(w.balance, 0)::int AS coins
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       LEFT JOIN coin_wallets w ON w.user_id = u.id
       WHERE u.status = 'active'
       ORDER BY coins DESC, u.created_at ASC`,
    )
    return result.rows
  }
  const result = await database.query(
    `SELECT u.id, u.username, u.email, u.role, u.status,
            COALESCE(p.display_name, u.username) AS display_name,
            count(gp.id)::int AS games,
            count(gp.id) FILTER (WHERE gp.status = 'won')::int AS wins
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     LEFT JOIN game_predictions gp ON gp.user_id = u.id
     WHERE u.status = 'active'
     GROUP BY u.id, p.display_name
     ORDER BY wins DESC, games DESC, u.created_at ASC`,
  )
  return result.rows
}

export async function getAdminStats(database = pool) {
  const result = await database.query(
    `SELECT
       (SELECT count(*)::int FROM users) AS users,
       (SELECT count(*)::int FROM groups WHERE status = 'active') AS groups,
       (SELECT count(*)::int FROM messages WHERE deleted_at IS NULL) AS messages,
       (SELECT count(*)::int FROM game_rounds) AS rounds,
       (SELECT count(*)::int FROM coin_transactions) AS transactions,
       (SELECT count(*)::int FROM game_predictions) AS predictions`,
  )
  return result.rows[0]
}

export async function getGroups(database = pool) {
  const result = await database.query(
    `SELECT g.id, g.name, g.icon_url, g.owner_id, g.visibility, g.created_at,
            COALESCE(m.member_count, 0)::int AS member_count
     FROM groups g
     LEFT JOIN LATERAL (
       SELECT count(*) AS member_count
       FROM group_members gm WHERE gm.group_id = g.id
     ) m ON true
     WHERE g.status = 'active'
     ORDER BY g.created_at DESC`,
  )
  return result.rows.map(mapGroup)
}

export async function getGroup(groupId, database = pool) {
  const result = await database.query(
    `SELECT g.id, g.name, g.icon_url, g.owner_id, g.visibility, g.created_at,
            count(gm.user_id)::int AS member_count
     FROM groups g
     LEFT JOIN group_members gm ON gm.group_id = g.id
     WHERE g.id = $1 AND g.status = 'active'
     GROUP BY g.id`,
    [groupId],
  )
  return mapGroup(result.rows[0])
}

export async function isGroupMember(groupId, userId, database = pool) {
  const result = await database.query(
    `SELECT 1
     FROM group_members gm
     JOIN groups g ON g.id = gm.group_id AND g.status = 'active'
     JOIN users u ON u.id = gm.user_id AND u.status = 'active'
     WHERE gm.group_id = $1 AND gm.user_id = $2`,
    [groupId, userId],
  )
  return Boolean(result.rows[0])
}

export async function createGroup({ id = randomUUID(), name, icon = null, ownerId, visibility = 'public' }, database = pool) {
  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO groups (id, name, icon_url, owner_id, visibility)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, icon_url, owner_id, visibility, created_at`,
      [id, name, icon, ownerId, visibility],
    )
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [id, ownerId],
    )
    return mapGroup({ ...inserted.rows[0], member_count: 1 })
  }, database)
}

export async function joinGroup(groupId, userId, database = pool) {
  return withTransaction(async (client) => {
    const groupResult = await client.query(
      `SELECT id, visibility FROM groups WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [groupId],
    )
    const group = groupResult.rows[0]
    if (!group) return null
    const existing = await client.query(
      `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId],
    )
    if (!existing.rows[0] && group.visibility !== 'public') throw new Error('GROUP_NOT_JOINABLE')
    if (!existing.rows[0]) {
      await client.query(
        `INSERT INTO group_members (group_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, userId],
      )
    }
    const count = await client.query(
      `SELECT count(*)::int AS member_count FROM group_members WHERE group_id = $1`,
      [groupId],
    )
    return { groupId, joined: !existing.rows[0], memberCount: count.rows[0].member_count }
  }, database)
}

export async function getGroupMessages(groupId, database = pool) {
  const result = await database.query(
    `${messageSelect} WHERE m.group_id = $1 ORDER BY m.created_at ASC`,
    [groupId],
  )
  return result.rows.map(mapMessage)
}

const messageSelect = `SELECT m.id, m.group_id, m.sender_id,
       COALESCE(p.display_name, u.username) AS sender_name,
       u.username AS sender_username, p.avatar_url AS sender_avatar_url,
       CASE WHEN m.deleted_at IS NOT NULL THEN 'This message was deleted' ELSE m.text END AS text,
       m.emoji, m.created_at, m.deleted_at, m.reply_to_message_id,
       COALESCE(rp.display_name, ru.username) AS reply_sender_name,
       CASE WHEN r.deleted_at IS NOT NULL THEN 'This message was deleted' ELSE r.text END AS reply_text,
       r.emoji AS reply_emoji, r.deleted_at AS reply_deleted_at
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     LEFT JOIN profiles p ON p.user_id = u.id
     LEFT JOIN messages r ON r.id = m.reply_to_message_id AND r.group_id = m.group_id
     LEFT JOIN users ru ON ru.id = r.sender_id
     LEFT JOIN profiles rp ON rp.user_id = ru.id`

export async function createMessage({ id = randomUUID(), groupId, senderId, text, emoji = null, replyToMessageId = null }, database = pool) {
  return withTransaction(async (client) => {
    if (replyToMessageId) {
      const original = await client.query(
        'SELECT id FROM messages WHERE id = $1 AND group_id = $2',
        [replyToMessageId, groupId],
      )
      if (!original.rows[0]) throw new Error('INVALID_REPLY_REFERENCE')
    }
    const inserted = await client.query(
      `INSERT INTO messages (id, group_id, sender_id, text, emoji, reply_to_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [id, groupId, senderId, text, emoji, replyToMessageId],
    )
    const created = Boolean(inserted.rows[0])
    if (!created) {
      const existing = await client.query(
        'SELECT group_id, sender_id FROM messages WHERE id = $1 FOR UPDATE',
        [id],
      )
      if (
        String(existing.rows[0]?.group_id).toLowerCase() !== String(groupId).toLowerCase()
        || String(existing.rows[0]?.sender_id).toLowerCase() !== String(senderId).toLowerCase()
      ) throw new Error('MESSAGE_ID_CONFLICT')
    }
    const result = await client.query(`${messageSelect} WHERE m.id = $1`, [id])
    return { message: mapMessage(result.rows[0]), created }
  }, database)
}

export async function deleteMessage({ messageId, groupId, senderId }, database = pool) {
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT sender_id, deleted_at
       FROM messages WHERE id = $1 AND group_id = $2
       FOR UPDATE`,
      [messageId, groupId],
    )
    const message = existing.rows[0]
    if (!message) return null
    if (String(message.sender_id).toLowerCase() !== String(senderId).toLowerCase()) {
      throw new Error('MESSAGE_FORBIDDEN')
    }
    if (!message.deleted_at) {
      await client.query(
        `UPDATE messages
         SET deleted_at = now(), text = '', emoji = NULL
         WHERE id = $1 AND group_id = $2 AND sender_id = $3`,
        [messageId, groupId, senderId],
      )
    }
    const result = await client.query(`${messageSelect} WHERE m.id = $1`, [messageId])
    return mapMessage(result.rows[0])
  }, database)
}

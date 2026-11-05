import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { matchesOwnerEmail } from '../src/ownerAccess.js'

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url))
const backendDirectory = fileURLToPath(new URL('../', import.meta.url))

async function reservePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const { port } = listener.address()
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  return port
}

async function startBackend(ownerEmail) {
  const port = await reservePort()
  const child = spawn(process.execPath, [serverPath], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      DEMO_MODE: 'true',
      JWT_SECRET: 'owner-access-test-secret-123456',
      OWNER_EMAIL: ownerEmail,
    },
    stdio: 'ignore',
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited before becoming ready (${child.exitCode}).`)
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return { child, baseUrl }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  child.kill()
  throw new Error('Backend did not become ready in time.')
}

async function stopBackend(child) {
  if (child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))])
}

async function apiRequest(baseUrl, path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await response.json() }
}

test('owner email matching is case-insensitive and denies missing configuration', () => {
  assert.equal(matchesOwnerEmail(' Owner@Example.com ', 'owner@example.COM'), true)
  assert.equal(matchesOwnerEmail('owner@example.com', ''), false)
  assert.equal(matchesOwnerEmail('owner@example.com', undefined), false)
  assert.equal(matchesOwnerEmail('', 'owner@example.com'), false)
})

test('owner status and admin APIs use the authenticated account email', async () => {
  const backend = await startBackend('Alex@Example.com')
  try {
    const ownerLogin = await apiRequest(backend.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'alex@example.com', password: 'demo-password' },
    })
    assert.equal(ownerLogin.status, 200)
    const ownerToken = ownerLogin.body.data.token
    const regularRegistration = await apiRequest(backend.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { username: 'regular-test', email: 'regular@example.com', password: 'regular-test-password' },
    })
    assert.equal(regularRegistration.status, 201)
    const regularToken = regularRegistration.body.data.token
    const regularUserId = regularRegistration.body.data.user.id

    const [ownerStatus, regularStatus] = await Promise.all([
      apiRequest(backend.baseUrl, '/api/users/me', { token: ownerToken }),
      apiRequest(backend.baseUrl, '/api/users/me?email=alex@example.com', { token: regularToken }),
    ])
    assert.equal(ownerStatus.body.data.isOwnerAdmin, true)
    assert.equal(regularStatus.body.data.isOwnerAdmin, false)
    assert.equal('ownerEmail' in ownerStatus.body.data, false)

    assert.equal((await apiRequest(backend.baseUrl, '/api/admin/stats')).status, 401)
    assert.equal((await apiRequest(backend.baseUrl, '/api/admin/stats', { token: regularToken })).status, 403)
    assert.equal((await apiRequest(backend.baseUrl, '/api/admin/wallet-adjustments', {
      token: regularToken,
      method: 'POST',
      body: {},
    })).status, 403)
    assert.equal((await apiRequest(backend.baseUrl, '/api/admin/stats', { token: ownerToken })).status, 200)

    assert.equal((await apiRequest(backend.baseUrl, '/api/admin/game', { token: regularToken })).status, 403)
    const forbiddenPausePath = '/api/admin/game/rounds/00000000-0000-4000-8000-000000000001/pause'
    assert.equal((await apiRequest(backend.baseUrl, '/api/admin/game/rounds?status=all', { token: regularToken })).status, 403)
    assert.equal((await apiRequest(backend.baseUrl, forbiddenPausePath, {
      token: regularToken,
      method: 'POST',
      body: { reason: 'Should be denied' },
    })).status, 403)
    assert.equal((await apiRequest(backend.baseUrl, forbiddenPausePath.replace('/pause', '/resume'), {
      token: regularToken,
      method: 'POST',
      body: {},
    })).status, 403)
    const adjusted = await apiRequest(backend.baseUrl, '/api/admin/wallet-adjustments', {
      token: ownerToken,
      method: 'POST',
      body: { userId: regularUserId, amount: 100, reason: 'dashboard test', idempotencyKey: 'legacy-adjustment-1' },
    })
    assert.equal(adjusted.status, 200)
    const initialDashboard = await apiRequest(backend.baseUrl, '/api/admin/game', { token: ownerToken })
    assert.equal(initialDashboard.status, 200)
    const roundId = initialDashboard.body.data.currentRound.id
    const ownerPrediction = await apiRequest(backend.baseUrl, `/api/game/rounds/${roundId}/predictions`, {
      token: ownerToken,
      method: 'POST',
      body: { color: 'Red', amount: 50 },
    })
    const regularPrediction = await apiRequest(backend.baseUrl, `/api/game/rounds/${roundId}/predictions`, {
      token: regularToken,
      method: 'POST',
      body: { color: 'Green', amount: 50 },
    })
    assert.equal(ownerPrediction.status, 201)
    assert.equal(regularPrediction.status, 201)
    const populatedDashboard = await apiRequest(backend.baseUrl, '/api/admin/game', { token: ownerToken })
    const statistics = populatedDashboard.body.data.statistics
    assert.equal(statistics.activePlayers, 2)
    assert.equal(statistics.totalSelections, 2)
    assert.deepEqual(statistics.colors.Red, { players: 1, selections: 1, percentage: 50 })
    assert.deepEqual(statistics.colors.Green, { players: 1, selections: 1, percentage: 50 })
    assert.deepEqual(statistics.colors.Violet, { players: 0, selections: 0, percentage: 0 })

    const pause = await apiRequest(backend.baseUrl, `/api/admin/game/rounds/${roundId}/pause`, {
      token: ownerToken,
      method: 'POST',
      body: { reason: 'Testing technical pause' },
    })
    assert.equal(pause.status, 200)
    assert.equal(pause.body.data.status, 'paused')
    const resume = await apiRequest(backend.baseUrl, `/api/admin/game/rounds/${roundId}/resume`, {
      token: ownerToken,
      method: 'POST',
      body: {},
    })
    assert.equal(resume.status, 200)
    assert.equal(resume.body.data.status, 'active')
    const page = await apiRequest(backend.baseUrl, '/api/admin/game/rounds?status=all&limit=10&offset=0', { token: ownerToken })
    assert.equal(page.status, 200)
    assert.equal(page.body.data.total, 1)
  } finally {
    await stopBackend(backend.child)
  }
})

test('owner coin APIs search users and atomically credit, debit, and list transactions', async () => {
  const backend = await startBackend('alex@example.com')
  try {
    const ownerLogin = await apiRequest(backend.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'alex@example.com', password: 'demo-password' },
    })
    const ownerToken = ownerLogin.body.data.token
    const registration = await apiRequest(backend.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { username: 'coins-target', email: 'coins-target@example.com', password: 'coins-target-password', displayName: 'Coins Target' },
    })
    const targetToken = registration.body.data.token
    const targetId = registration.body.data.user.id

    const userOnlyRequests = [
      ['/api/admin/coins/dashboard', {}],
      ['/api/admin/coins/users', {}],
      [`/api/admin/coins/users/${targetId}`, {}],
      ['/api/admin/coins/transactions', {}],
      ['/api/admin/coins/credit', { method: 'POST', body: { userId: targetId, amount: 1 } }],
      ['/api/admin/coins/debit', { method: 'POST', body: { userId: targetId, amount: 1 } }],
    ]
    for (const [path, options] of userOnlyRequests) {
      assert.equal((await apiRequest(backend.baseUrl, path, { ...options, token: targetToken })).status, 403, path)
    }

    const initialDashboard = await apiRequest(backend.baseUrl, '/api/admin/coins/dashboard', { token: ownerToken })
    assert.equal(initialDashboard.status, 200)
    assert.equal(initialDashboard.body.data.registeredUsers, 2)
    assert.equal(initialDashboard.body.data.totalCoinsHeld, 1250)
    assert.equal(initialDashboard.body.data.totalAdminCredited, 0)

    const userSearch = await apiRequest(backend.baseUrl, '/api/admin/coins/users?search=coins-target&limit=10&offset=0', { token: ownerToken })
    assert.equal(userSearch.status, 200)
    assert.equal(userSearch.body.data.total, 1)
    assert.deepEqual(userSearch.body.data.items[0], {
      id: targetId,
      username: 'coins-target',
      fullName: 'Coins Target',
      balance: 0,
      status: 'active',
    })
    assert.equal('email' in userSearch.body.data.items[0], false)
    const userByUsername = await apiRequest(backend.baseUrl, '/api/admin/coins/users/coins-target', { token: ownerToken })
    assert.equal(userByUsername.body.data.id, targetId)

    const creditBody = {
      userId: targetId,
      amount: 50,
      reason: 'Event participation reward',
      idempotencyKey: 'coins-credit-request-1',
    }
    const credit = await apiRequest(backend.baseUrl, '/api/admin/coins/credit', {
      token: ownerToken,
      method: 'POST',
      body: creditBody,
    })
    assert.equal(credit.status, 201)
    assert.equal(credit.body.data.wallet.balance, 50)
    assert.equal(credit.body.data.transaction.balanceBefore, 0)
    assert.equal(credit.body.data.transaction.balanceAfter, 50)
    assert.equal(credit.body.data.transaction.idempotencyKey, creditBody.idempotencyKey)
    const creditRetry = await apiRequest(backend.baseUrl, '/api/admin/coins/credit', {
      token: ownerToken,
      method: 'POST',
      body: creditBody,
    })
    assert.equal(creditRetry.status, 200)
    assert.equal(creditRetry.body.data.duplicate, true)
    assert.equal(creditRetry.body.data.wallet.balance, 50)

    const debitBody = {
      userId: targetId,
      amount: 25,
      reason: 'Duplicate event credit correction',
      idempotencyKey: 'coins-debit-request-1',
    }
    const debit = await apiRequest(backend.baseUrl, '/api/admin/coins/debit', {
      token: ownerToken,
      method: 'POST',
      body: debitBody,
    })
    assert.equal(debit.status, 201)
    assert.equal(debit.body.data.wallet.balance, 25)
    const debitRetry = await apiRequest(backend.baseUrl, '/api/admin/coins/debit', {
      token: ownerToken,
      method: 'POST',
      body: debitBody,
    })
    assert.equal(debitRetry.status, 200)
    assert.equal(debitRetry.body.data.wallet.balance, 25)

    const concurrentCreditBody = {
      userId: targetId,
      amount: 10,
      reason: 'Concurrent retry protection',
      idempotencyKey: 'coins-concurrent-credit-1',
    }
    const concurrentCredits = await Promise.all([
      apiRequest(backend.baseUrl, '/api/admin/coins/credit', {
        token: ownerToken,
        method: 'POST',
        body: concurrentCreditBody,
      }),
      apiRequest(backend.baseUrl, '/api/admin/coins/credit', {
        token: ownerToken,
        method: 'POST',
        body: concurrentCreditBody,
      }),
    ])
    assert.deepEqual(concurrentCredits.map((result) => result.status).sort(), [200, 201])
    assert.equal(concurrentCredits[0].body.data.wallet.balance, 35)
    assert.equal(concurrentCredits[1].body.data.wallet.balance, 35)

    const insufficient = await apiRequest(backend.baseUrl, '/api/admin/coins/debit', {
      token: ownerToken,
      method: 'POST',
      body: { userId: targetId, amount: 1000, reason: 'Invalid deduction test', idempotencyKey: 'coins-insufficient-1' },
    })
    assert.equal(insufficient.status, 409)
    const invalidAmount = await apiRequest(backend.baseUrl, '/api/admin/coins/credit', {
      token: ownerToken,
      method: 'POST',
      body: { userId: targetId, amount: 1.5, reason: 'Invalid fractional amount', idempotencyKey: 'coins-invalid-amount-1' },
    })
    assert.equal(invalidAmount.status, 400)
    const missingReason = await apiRequest(backend.baseUrl, '/api/admin/coins/credit', {
      token: ownerToken,
      method: 'POST',
      body: { userId: targetId, amount: 1, idempotencyKey: 'coins-missing-reason-1' },
    })
    assert.equal(missingReason.status, 400)
    const reusedKey = await apiRequest(backend.baseUrl, '/api/admin/coins/credit', {
      token: ownerToken,
      method: 'POST',
      body: { ...creditBody, amount: 51 },
    })
    assert.equal(reusedKey.status, 409)

    const history = await apiRequest(backend.baseUrl, `/api/admin/coins/transactions?userId=${targetId}&type=debit&limit=10&offset=0`, { token: ownerToken })
    assert.equal(history.status, 200)
    assert.equal(history.body.data.total, 1)
    assert.deepEqual({
      type: history.body.data.items[0].type,
      amount: history.body.data.items[0].amount,
      previousBalance: history.body.data.items[0].previousBalance,
      newBalance: history.body.data.items[0].newBalance,
      adminId: history.body.data.items[0].adminId,
      reason: history.body.data.items[0].reason,
    }, {
      type: 'DEBIT',
      amount: 25,
      previousBalance: 50,
      newBalance: 25,
      adminId: 'demo-user-alex',
      reason: debitBody.reason,
    })

    const finalDashboard = await apiRequest(backend.baseUrl, '/api/admin/coins/dashboard', { token: ownerToken })
    assert.deepEqual(finalDashboard.body.data, {
      registeredUsers: 2,
      totalCoinsHeld: 1285,
      totalAdminCredited: 60,
      totalAdminDeducted: 25,
      adminAdjustments: 3,
    })
  } finally {
    await stopBackend(backend.child)
  }
})

test('an empty OWNER_EMAIL denies owner status and admin API access', async () => {
  const backend = await startBackend('')
  try {
    const registration = await apiRequest(backend.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { username: 'owner-test', email: 'owner@example.com', password: 'owner-test-password' },
    })
    assert.equal(registration.status, 201)
    const token = registration.body.data.token
    const status = await apiRequest(backend.baseUrl, '/api/users/me', { token })
    assert.equal(status.body.data.isOwnerAdmin, false)
    assert.equal((await apiRequest(backend.baseUrl, '/api/admin/stats', { token })).status, 403)
  } finally {
    await stopBackend(backend.child)
  }
})

test('game results require authentication, belong to the requesting player, and stay pending until settled', async () => {
  const backend = await startBackend('')
  try {
    const login = await apiRequest(backend.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'alex@example.com', password: 'demo-password' },
    })
    assert.equal(login.status, 200)
    const token = login.body.data.token
    const roundResponse = await apiRequest(backend.baseUrl, '/api/game/rounds/current')
    const roundId = roundResponse.body.data.id
    const submitted = await apiRequest(backend.baseUrl, `/api/game/rounds/${roundId}/predictions`, {
      token,
      method: 'POST',
      body: { color: 'Green', amount: 50 },
    })
    assert.equal(submitted.status, 201)
    const predictionId = submitted.body.data.id
    const path = `/api/game/predictions/${predictionId}/result`

    assert.equal((await apiRequest(backend.baseUrl, path)).status, 401)
    const result = await apiRequest(backend.baseUrl, path, { token })
    assert.equal(result.status, 200)
    assert.equal(result.body.data.status, 'pending')
    assert.equal(result.body.data.result, null)

    const otherRegistration = await apiRequest(backend.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { username: 'other-player', email: 'other@example.com', password: 'other-test-password' },
    })
    assert.equal(otherRegistration.status, 201)
    assert.equal((await apiRequest(backend.baseUrl, path, { token: otherRegistration.body.data.token })).status, 404)
  } finally {
    await stopBackend(backend.child)
  }
})

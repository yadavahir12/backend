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
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited before becoming ready (${child.exitCode}).`)
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return { child, baseUrl }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
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

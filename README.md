# OtazexPlay Backend

Fastify REST and Socket.IO backend for the virtual-only OtazexPlay application.

## Runtime

- Node.js 20+
- PostgreSQL for durable mode
- Socket.IO for realtime group events

The current machine does not have PostgreSQL installed, so `npm start` runs in clearly labeled demo-memory mode when `DATABASE_URL` is absent. Demo mode is for local API/UI development only and is not durable.

## Setup

```powershell
Copy-Item .env.example .env
npm install
npm run migrate
npm run seed
npm start
```

Set `DEMO_MODE=false` and a valid `DATABASE_URL` before using a durable environment. The schema is in `schema.sql`; migrations require a configured PostgreSQL connection through `npm run migrate`.

For an existing deployment, run `npm run migrate` with `DATABASE_URL_UNPOOLED` set to the direct PostgreSQL connection string before deploying the chat API changes. This applies `migrations/20261101_add_message_reply_reference.sql` transactionally and records it in `schema_migrations`; the migration adds nullable UUID reply references and the message deletion timestamp without removing existing messages.

Demo login:

- Username: `@alexm`
- Password: `demo-password`

Do not use these credentials outside local development.

## API

- `GET /health`
- `/api/auth/*`
- `/api/users/*`
- `/api/wallet/*`
- `/api/coin-packages`
- `/api/groups/*`
- `/api/game/*`
- `/api/leaderboard`
- `/api/notifications/*`
- `/api/admin/*`

Group messages accept an optional `replyToMessageId` that must reference a message in the same group. `DELETE /api/groups/:id/messages/:messageId` deletes a message for everyone; only its sender can perform this operation. Deleted messages remain in history as “This message was deleted,” and their reply previews update accordingly. Group members receive `message.created` and `message.deleted` Socket.IO events.

Public profile responses expose display name, username, avatar, bio, level, and follower/following counts; they do not include email or wallet data.

In PostgreSQL mode, game rounds and predictions, follows, notifications, and group memberships use their existing tables. `POST /api/groups/:id/join` joins an active public group; private groups cannot be joined through this endpoint. Coin entry debits and prediction creation are committed together. Game-result settlement and notification creation are not implemented yet.

Socket.IO events currently include `group.join`, `group.leave`, `typing`, and server-emitted `message.created`.

## Virtual-only boundary

Coins are in-app points. This backend does not implement real-money betting, cash-out, withdrawal, or payment-to-bet functionality.
Coin packages and wallet activity are read-only; payment initiation, gateway verification, and purchase credits are not implemented.

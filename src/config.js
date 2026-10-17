import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  CLIENT_URL: z.string().default('http://127.0.0.1:5173'),
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().min(16).default('development-only-change-me-please'),
  DEMO_MODE: z.enum(['true', 'false']).default('false'),
})

export const config = schema.parse(process.env)
export const demoMode = config.DEMO_MODE === 'true' || !config.DATABASE_URL

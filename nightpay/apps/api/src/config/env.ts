import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be ≥32 chars'),
  COOKIE_SECRET: z.string().min(32),
  ENCRYPTION_KEK: z.string().min(32),
  WIPAY_API_URL: z.string().url(),
  WIPAY_WEBHOOK_SECRET: z.string().min(8),
  PEANPE_API_URL: z.string().url(),
  PEANPE_WEBHOOK_SECRET: z.string().min(8),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('❌ Invalid environment:');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

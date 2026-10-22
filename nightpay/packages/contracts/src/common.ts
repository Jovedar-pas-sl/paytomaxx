import { z } from 'zod';

export const UuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof UuidSchema>;

export const ProblemDetailsSchema = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  traceId: z.string().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  /** El commit construido o `source:<huella>` del código (apps/api/build-info.json); `unknown` sin construir. */
  version: z.string(),
  /** BUILD_MARKER si se puso al construir; si no, la huella corta. */
  build: z.string().optional(),
  sourceDigest: z.string().optional(),
  builtAt: z.string().optional(),
  timestamp: z.string(),
  checks: z.record(z.string(), z.enum(['ok', 'fail', 'skip'])),
});
export type Health = z.infer<typeof HealthSchema>;

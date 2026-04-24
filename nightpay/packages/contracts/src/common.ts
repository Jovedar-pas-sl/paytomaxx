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
  version: z.string(),
  timestamp: z.string(),
  checks: z.record(z.string(), z.enum(['ok', 'fail', 'skip'])),
});
export type Health = z.infer<typeof HealthSchema>;

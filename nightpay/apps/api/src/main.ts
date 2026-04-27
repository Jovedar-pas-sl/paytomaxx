import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();

  // Custom JSON parser que preserva el rawBody — necesario para HMAC verification
  // de webhooks (Wipay/Peanpe firman el body crudo, no el JSON re-serializado).
  const adapter = new FastifyAdapter({ logger: { level: env.LOG_LEVEL } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fastify = adapter.getInstance() as any;
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req: any, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
      // Guardar buffer original
      req.rawBody = body;
      try {
        const parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
        done(null, parsed);
      } catch (err) {
        done(err as Error);
      }
    },
  );

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);

  app.setGlobalPrefix('v1');
  app.enableCors({
    origin: true,
    credentials: true,
  });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`NightPay API listening on http://0.0.0.0:${env.PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed:', err);
  process.exit(1);
});

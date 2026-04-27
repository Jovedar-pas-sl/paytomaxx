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

  const adapter = new FastifyAdapter({ logger: { level: env.LOG_LEVEL } });

  // `rawBody: true` hace que NestJS preserve el body crudo en `req.rawBody`
  // sin chocar con el content-type parser que platform-fastify registra por defecto.
  // Necesario para verificacion HMAC de webhooks (Wipay/Peanpe firman el body crudo).
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    rawBody: true,
  });

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

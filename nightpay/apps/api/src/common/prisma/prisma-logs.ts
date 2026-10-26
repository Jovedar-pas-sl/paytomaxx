import { redactSecretsInText } from '../logging/redact-url';

/** Un evento de log de Prisma (`log: [{ emit: 'event', level }]`). */
export interface PrismaLogEvent {
  message: string;
  target: string;
  timestamp: Date;
}

/** Lo que hace falta del cliente de Prisma: engancharse a sus avisos y errores. */
export interface PrismaLogSource {
  $on(event: 'warn' | 'error', callback: (e: PrismaLogEvent) => void): void;
}

interface PrismaLogger {
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** Lo que cabe de un mensaje del motor en una línea de log. */
const MAX_MESSAGE_CHARS = 500;

/**
 * El fallo de una consulta lo emite el cliente con el método como origen
 * (`user.create`, `$queryRaw`); lo del motor (pool, conexión, pánicos) trae
 * la ruta de su módulo (`quaint::pooled`, `query_engine`).
 */
const CLIENT_METHOD = /^(?:\$\w+|\w+\.\$?\w+)$/;

/** Una línea, recortada y sin credenciales en las URLs (la de la base lleva la contraseña). */
function engineMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  const clipped = oneLine.length > MAX_MESSAGE_CHARS ? `${oneLine.slice(0, MAX_MESSAGE_CHARS)}…` : oneLine;
  return redactSecretsInText(clipped.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@`'"]+@/gi, '$1***@'));
}

/**
 * Los avisos y errores de Prisma al log (antes se emitían como eventos y no
 * los escuchaba nadie). Del motor: el mensaje (recortado, sin credenciales).
 * El de una consulta que falla NO: lo recibe quien la hizo (y, si no lo trata,
 * el filtro de errores), y lleva los datos de la consulta (emails, hashes…).
 */
export function attachPrismaLogs(client: PrismaLogSource, logger: PrismaLogger): void {
  client.$on('warn', (e) => logger.warn(`Prisma (${e.target || 'cliente'}): ${engineMessage(e.message)}`));
  client.$on('error', (e) => {
    if (CLIENT_METHOD.test(e.target)) {
      logger.debug(`Prisma: falló ${e.target} (lo trata quien la llamó; los datos de la consulta no van al log)`);
      return;
    }
    logger.error(`Prisma (${e.target || 'motor'}): ${engineMessage(e.message)}`);
  });
}

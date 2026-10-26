type Task = () => Promise<unknown>;
type Results<T extends readonly Task[]> = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };

/**
 * Como Promise.all de las tareas, pero con como mucho `limit` en marcha a la
 * vez (empiezan en orden; cada resultado en su sitio; el primer error
 * rechaza). Para no ocupar de golpe medio pool de conexiones de Prisma.
 */
export async function runLimited<const T extends readonly Task[]>(tasks: T, limit: number): Promise<Results<T>> {
  const results: unknown[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next;
      next += 1;
      results[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, worker));
  return results as Results<T>;
}

/**
 * Suelta un candado de Redis (SET clave <valor único> NX EX) solo si sigue
 * siendo nuestro: si caducó y lo tomó otra réplica, es suyo y no se toca.
 * GET y DEL en un solo paso (Lua): entre los dos no se cuela nadie.
 * Uso: `redis.eval(RELEASE_LOCK_LUA, 1, clave, valor)` → 1 si lo soltó, 0 si no.
 */
export const RELEASE_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

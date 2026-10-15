// Admin API client. Todo se importa de aquí (`@/lib/api`); el código está
// repartido en lib/http.ts (sesión y fetch) y lib/endpoints/* (por dominio).

export * from './http';
export * from './endpoints/venues';
export * from './endpoints/payments';
export * from './endpoints/incidents';
export * from './endpoints/nights';
export * from './endpoints/operators';
export * from './endpoints/wallets';
export * from './endpoints/settings';
export * from './endpoints/totp';
export * from './endpoints/terminals';
export * from './endpoints/carta';
export * from './endpoints/bank';

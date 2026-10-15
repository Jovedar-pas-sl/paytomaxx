// apps/admin no tiene vitest entre sus dependencias (package.json no se toca
// desde aquí): los tests de src/lib se lanzan con el vitest de apps/operator
//   cd nightpay/apps/admin && ../operator/node_modules/.bin/vitest run --root .
// y este fichero tipa lo poco que usan (.ts y no .d.ts: los .d.ts de src/ están
// en .gitignore). Si se añade vitest a apps/admin, borrarlo.
declare module 'vitest' {
  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toContain(expected: string): void;
    toMatch(expected: RegExp | string): void;
    not: Matchers;
  }
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function expect(actual: unknown): Matchers;
}

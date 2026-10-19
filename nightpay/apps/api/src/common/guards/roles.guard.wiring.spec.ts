import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { RoleSchema } from '@nightpay/contracts';

/**
 * Cableado de los guards en TODOS los controladores (lectura estática del
 * código, sin arrancar Nest): un @Roles sin RolesGuard no protege nada
 * (RolesGuard no es global), y las rutas de superadmin, debug y métricas
 * tienen que pasar siempre por su guard.
 */

interface Route {
  label: string;
  basePath: string;
  roles: string[] | null;
  guards: string[];
  isPublic: boolean;
}

const MODULES_DIR = join(__dirname, '..', '..', 'modules');
const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Head', 'Options']);

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.controller.ts'))
    .map((f) => join(dir, f));
}

interface Deco {
  name: string;
  args: ts.Expression[];
}

function decoratorsOf(node: ts.Node): Deco[] {
  if (!ts.canHaveDecorators(node)) return [];
  return (ts.getDecorators(node) ?? []).flatMap((d) => {
    const e = d.expression;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return [{ name: e.expression.text, args: [...e.arguments] }];
    return ts.isIdentifier(e) ? [{ name: e.text, args: [] }] : [];
  });
}

const textsOf = (args: ts.Expression[]) => args.map((a) => (ts.isStringLiteralLike(a) ? a.text : a.getText()));
const find = (decos: Deco[], name: string) => decos.find((d) => d.name === name);

function routesOf(cls: ts.ClassDeclaration): Route[] {
  const classDecos = decoratorsOf(cls);
  const controller = find(classDecos, 'Controller');
  if (!controller) return [];
  const basePath = textsOf(controller.args)[0] ?? '';
  const classRoles = find(classDecos, 'Roles');
  const classGuards = classDecos.filter((d) => d.name === 'UseGuards').flatMap((d) => textsOf(d.args));
  return cls.members.filter(ts.isMethodDeclaration).flatMap((m) => {
    const decos = decoratorsOf(m);
    if (!decos.some((d) => HTTP_DECORATORS.has(d.name))) return [];
    const roles = find(decos, 'Roles') ?? classRoles;
    return [
      {
        label: `${cls.name?.text ?? '?'}.${m.name.getText()}`,
        basePath,
        roles: roles ? textsOf(roles.args) : null,
        guards: [...decos.filter((d) => d.name === 'UseGuards').flatMap((d) => textsOf(d.args)), ...classGuards],
        isPublic: Boolean(find(decos, 'Public') ?? find(classDecos, 'Public')),
      },
    ];
  });
}

function allRoutes(): Route[] {
  return controllerFiles(MODULES_DIR).flatMap((file) => {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    return sf.statements.filter(ts.isClassDeclaration).flatMap(routesOf);
  });
}

const routes = allRoutes();
const labels = (rs: Route[]) => rs.map((r) => r.label);

describe('cableado de RolesGuard en los controladores', () => {
  it('se encuentran las rutas (la búsqueda no está vacía)', () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.filter((r) => r.roles !== null).length).toBeGreaterThan(20);
  });

  it('toda ruta con @Roles pasa por RolesGuard (en el método o en la clase)', () => {
    expect(labels(routes.filter((r) => r.roles !== null && !r.guards.includes('RolesGuard')))).toEqual([]);
  });

  it('@Roles solo usa roles que existen y nunca va vacío', () => {
    const validos = new Set<string>(RoleSchema.options);
    const malos = routes.filter((r) => r.roles !== null && (r.roles.length === 0 || r.roles.some((x) => !validos.has(x))));
    expect(labels(malos)).toEqual([]);
  });

  it('una ruta @Public no lleva @Roles (sin sesión, RolesGuard la cortaría siempre)', () => {
    expect(labels(routes.filter((r) => r.isPublic && r.roles !== null))).toEqual([]);
  });
});

describe('rutas que siempre van con su guard', () => {
  it('superadmin/*: todas pasan por SuperAdminGuard y ninguna es pública', () => {
    const sa = routes.filter((r) => r.basePath.startsWith('superadmin'));
    expect(sa.length).toBeGreaterThan(0);
    expect(labels(sa.filter((r) => !r.guards.includes('SuperAdminGuard') || r.isPublic))).toEqual([]);
  });

  it('debug/*: todas pasan por DebugEndpointsGuard', () => {
    const debug = routes.filter((r) => r.basePath.startsWith('debug'));
    expect(debug.length).toBeGreaterThan(0);
    expect(labels(debug.filter((r) => !r.guards.includes('DebugEndpointsGuard')))).toEqual([]);
  });

  it('metrics: pasa por MetricsAccessGuard', () => {
    const metrics = routes.filter((r) => r.basePath.startsWith('metrics'));
    expect(metrics.length).toBeGreaterThan(0);
    expect(labels(metrics.filter((r) => !r.guards.includes('MetricsAccessGuard')))).toEqual([]);
  });

  it('las rutas del datáfono con DeviceGuard son @Public (no piden JWT de personal)', () => {
    const device = routes.filter((r) => r.guards.includes('DeviceGuard'));
    expect(device.length).toBeGreaterThan(0);
    expect(labels(device.filter((r) => !r.isPublic || r.roles !== null))).toEqual([]);
  });
});

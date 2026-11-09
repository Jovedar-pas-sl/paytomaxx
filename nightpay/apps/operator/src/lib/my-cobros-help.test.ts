import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PaymentStatusSchema } from '@nightpay/contracts';
import { ownCobroState } from './my-cobros';
import {
  MY_COBROS_HELP_SCREEN,
  OWN_COBRO_STATUSES,
  myCobrosHelpLine,
  myCobrosSituations,
  myCobrosStates,
} from './my-cobros-help';

const CHICA = { cancelPending: true };
const STAFF = { cancelPending: false };

/** Sin mayúsculas sostenidas, sin emojis ni signos de exclamación (encargo Grafito 2). */
function plain(text: string): void {
  expect(text).not.toMatch(/[!¡]/);
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  // Siglas aparte (PIN, QR), ninguna palabra entera en mayúsculas.
  expect(text.replace(/\b(PIN|QR)\b/g, '')).not.toMatch(/\b[A-ZÁÉÍÓÚÑ]{3,}\b/);
}

describe('los estados que pueden salir en «Cobros»', () => {
  it('los del cobro con tarjeta (todos los PaymentStatus) y los del saldo (aceptado o anulado)', () => {
    expect(OWN_COBRO_STATUSES).toEqual([...PaymentStatusSchema.options, 'ACCEPTED', 'REVERSED']);
  });

  it('cada estado que puede salir tiene su explicación (por su palabra), y ninguna sobra', () => {
    const explained = myCobrosStates(CHICA).map((s) => s.label);
    const shown = [...new Set(OWN_COBRO_STATUSES.map((s) => ownCobroState(s).label))];
    expect([...explained].sort()).toEqual([...shown].sort());
    // Sin repetir (AUTHORIZED y ACCEPTED dicen los dos «Cobrado»).
    expect(new Set(explained).size).toBe(explained.length);
    // «Rechazado» (DECLINED) no lo trae el API: no se explica.
    expect(explained).not.toContain('Rechazado');
  });

  it('el chip de cada uno es el de las filas (misma palabra, color e icono)', () => {
    const cobrado = myCobrosStates(STAFF)[0]!;
    expect(cobrado).toMatchObject({ label: 'Cobrado', tone: 'ok', icon: 'check' });
    expect(myCobrosStates(STAFF).find((s) => s.label === 'Fallido')).toMatchObject({ tone: 'bad', icon: 'x' });
  });

  it('un pendiente: la chica lo cancela con «Cancelar»; el resto, caduca solo', () => {
    const pendiente = (viewer: { cancelPending: boolean }) => myCobrosStates(viewer).find((s) => s.label === 'Pendiente')!.text;
    expect(pendiente(CHICA)).toContain('toca «Cancelar»');
    expect(pendiente(STAFF)).not.toContain('«Cancelar»');
    expect(pendiente(STAFF)).toContain('caduca solo');
  });
});

describe('«Si pasa esto»', () => {
  it('el banco tarda, se va sin pagar, dos veces, que le devuelvan y su saldo', () => {
    expect(myCobrosSituations(STAFF).map((c) => c.when)).toEqual([
      'El banco tarda',
      'El cliente se va sin pagar',
      'Dice que ha pagado dos veces',
      'Quiere que le devuelvan un cobro',
      'Quiere lo que le queda en el saldo',
    ]);
  });

  it('con el botón exacto que hay en la app, o a quién avisar', () => {
    const esperando = readFileSync(new URL('../components/cobrar/Esperando.tsx', import.meta.url), 'utf8');
    const myCobros = readFileSync(new URL('../components/MyCobros.tsx', import.meta.url), 'utf8');
    const desk = readFileSync(new URL('../components/reception/desk/ReceptionDesk.tsx', import.meta.url), 'utf8');
    const [banco, seVa, dosVeces, devolver, saldo] = myCobrosSituations(STAFF);
    expect(banco!.todo).toContain('«Avisar al encargado»');
    expect(esperando).toContain("'Avisar al encargado'");
    expect(esperando).toContain('Sin confirmar');
    expect(seVa!.todo).toContain('«Cancelar cobro»');
    expect(esperando).toContain("'Cancelar cobro'");
    expect(myCobrosSituations(CHICA)[1]!.todo).toContain('«Cancelar»');
    expect(myCobros).toMatch(/>\s*Cancelar\s*</);
    expect(dosVeces!.todo).toContain('avisa al encargado');
    expect(devolver!.todo).toContain('avisa al encargado o al dueño');
    expect(saldo!.todo).toContain('«Salida»');
    expect(desk).toContain("'Salida'");
  });

  it('lo de «dos veces» dice lo mismo que la fila del cobro', () => {
    const note = readFileSync(new URL('./my-cobros.ts', import.meta.url), 'utf8');
    expect(note).toContain('la tarjeta se devolvió sola');
    expect(note).toContain('hay que devolver');
  });
});

describe('la línea de arriba', () => {
  it('qué es la lista y qué se puede hacer, según quién mira', () => {
    expect(MY_COBROS_HELP_SCREEN).toBe('cobros');
    expect(myCobrosHelpLine(CHICA)).toContain('toca «Cancelar»');
    expect(myCobrosHelpLine(STAFF)).toContain('avisa al encargado o al dueño');
  });

  it('todo en español llano: sin mayúsculas, emojis ni exclamaciones', () => {
    for (const viewer of [CHICA, STAFF]) {
      plain(myCobrosHelpLine(viewer));
      for (const s of myCobrosStates(viewer)) plain(s.text);
      for (const c of myCobrosSituations(viewer)) {
        plain(c.when);
        plain(c.todo);
      }
    }
  });
});

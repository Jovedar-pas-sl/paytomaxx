import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { myCobrosSituations } from './my-cobros-help';

const CHICA = { cancelPending: true };
const STAFF = { cancelPending: false };

/** Sin mayúsculas sostenidas, sin emojis ni signos de exclamación (encargo Grafito 2). */
function plain(text: string): void {
  expect(text).not.toMatch(/[!¡]/);
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  // Siglas aparte (PIN, QR), ninguna palabra entera en mayúsculas.
  expect(text.replace(/\b(PIN|QR)\b/g, '')).not.toMatch(/\b[A-ZÁÉÍÓÚÑ]{3,}\b/);
}

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

describe('español llano', () => {
  it('sin mayúsculas, emojis ni exclamaciones', () => {
    for (const viewer of [CHICA, STAFF]) {
      for (const c of myCobrosSituations(viewer)) {
        plain(c.when);
        plain(c.todo);
      }
    }
  });
});

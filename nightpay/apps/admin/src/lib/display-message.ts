// Ajustes → Carta → «Pantalla del cliente»: el mensaje del reposo. Se valida
// con el mismo esquema que el API, así la vista previa enseña lo que se guarda.

import { UpdateDisplayMessageSchema, type CustomerDisplayMessage } from '@nightpay/contracts';

export interface DisplayMessageDraft {
  line1: string;
  line2: string;
}

export type DisplayMessagePlan = { ok: true; message: CustomerDisplayMessage } | { ok: false; problem: string };

/** Lo que se guardaría con lo escrito, o por qué no se puede. */
export function displayMessagePlan(draft: DisplayMessageDraft): DisplayMessagePlan {
  const parsed = UpdateDisplayMessageSchema.safeParse(draft);
  if (parsed.success) return { ok: true, message: parsed.data };
  return { ok: false, problem: parsed.error.issues[0]?.message ?? 'Revisa el mensaje' };
}

/** Las letras de una línea como se guardan (los espacios de sobra no cuentan). */
export function lineLength(text: string): number {
  return text.replace(/[\s\p{Cc}]+/gu, ' ').trim().length;
}

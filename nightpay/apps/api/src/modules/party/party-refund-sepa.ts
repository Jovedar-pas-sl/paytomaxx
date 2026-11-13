import { transferConcept } from './party-refund-csv';
import { buildPain001, type Pain001Transfer } from './sepa';

/**
 * El fichero SEPA (pain.001.001.03, buildPain001) de las transferencias de
 * «Lo que sobra» pendientes: una por petición, al IBAN que dio el asistente.
 * Del asistente solo se guarda el IBAN (y, si quiso, un correo): el nombre
 * del beneficiario es «Asistente <marca> <pulsera>». La referencia de punta a
 * punta es el id de la petición (sin guiones): así se reconoce en el extracto.
 * Subirlo al banco no marca nada: cada una se marca «Hecha» en el panel.
 */

export interface RefundTransfer {
  id: string;
  amountCents: number;
  iban: string;
  /** «P-0412» (null: sin pulsera). */
  pulsera: string | null;
}

export interface RefundSepaInput {
  messageId: string;
  createdAt: Date;
  /** Día en que el banco las hace (AAAA-MM-DD). */
  executionDate: string;
  /** La marca de la fiesta («OxioParty»): va en el concepto. */
  brand: string;
  debtor: { name: string; iban: string };
  transfers: readonly RefundTransfer[];
}

export interface RefundSepaFile {
  xml: string;
  messageId: string;
  count: number;
  totalCents: number;
}

/** La transferencia del fichero para una petición. */
export function refundTransfer(t: RefundTransfer, brand: string): Pain001Transfer {
  return {
    endToEndId: t.id.replace(/-/g, ''),
    creditorName: `Asistente ${brand}${t.pulsera ? ` ${t.pulsera}` : ''}`,
    creditorIban: t.iban,
    amountCents: t.amountCents,
    remittance: transferConcept(brand, t.pulsera, t.id),
  };
}

/** El XML y sus cuentas (NbOfTxs, CtrlSum). Sin transferencias, SepaInputError. */
export function refundTransfersSepa(input: RefundSepaInput): RefundSepaFile {
  const xml = buildPain001({
    messageId: input.messageId,
    createdAt: input.createdAt,
    executionDate: input.executionDate,
    debtor: input.debtor,
    transfers: input.transfers.map((t) => refundTransfer(t, input.brand)),
  });
  return {
    xml,
    messageId: input.messageId,
    count: input.transfers.length,
    totalCents: input.transfers.reduce((a, t) => a + t.amountCents, 0),
  };
}

/** «transferencias-pendientes-2027-06-30.xml» */
export function refundSepaFileName(day: string): string {
  return `transferencias-pendientes-${day}.xml`;
}

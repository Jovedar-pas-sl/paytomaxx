/**
 * Fichero de transferencias SEPA para el banco: ISO 20022 pain.001.001.03
 * (el que aceptan todos los bancos españoles para subir transferencias en
 * lote). Puro y reutilizable: lo usan la liquidación de las casetas y las
 * transferencias de «Lo que sobra». Solo IBAN (sin BIC: en SEPA no hace
 * falta desde 2016; el banco del deudor va como NOTPROVIDED).
 *
 * Los textos se pasan al juego de caracteres de SEPA (letras sin acentos,
 * números y / - ? : ( ) . , ' +): «Peña» → «Pena». Los importes, en euros con
 * punto y dos decimales; NbOfTxs y CtrlSum cuadran con las transferencias.
 */

export interface Pain001Transfer {
  /** Referencia de punta a punta (≤ 35; se recorta). */
  endToEndId: string;
  creditorName: string;
  creditorIban: string;
  amountCents: number;
  /** Concepto (≤ 140; se recorta). */
  remittance: string;
}

export interface Pain001Input {
  /** Identificador del fichero (≤ 35). */
  messageId: string;
  createdAt: Date;
  /** Día en que el banco las hace (AAAA-MM-DD). */
  executionDate: string;
  debtor: { name: string; iban: string };
  transfers: readonly Pain001Transfer[];
}

export class SepaInputError extends Error {}

/** Sin la cuenta del local (la pone OxioPay) no hay deudor: 409, en el cierre y en las devoluciones. */
export const NO_DEBTOR_IBAN_CODE = 'NO_DEBTOR_IBAN';
export const NO_DEBTOR_IBAN_MESSAGE =
  'El local no tiene su cuenta (IBAN) para hacer las transferencias: la pone OxioPay. Pídesela y vuelve a probar.';
/** Ninguna transferencia que hacer: 409. */
export const NO_TRANSFERS_CODE = 'NO_TRANSFERS';

const NAME_MAX = 70;
const ID_MAX = 35;
const REMITTANCE_MAX = 140;
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Al juego de caracteres de SEPA: sin acentos (ñ → n, ç → c), el resto de
 * signos fuera, espacios seguidos en uno y recortado a `max`.
 */
export function sepaText(value: string, max: number): string {
  const plain = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, max).trim();
}

/** Identificadores (MsgId, EndToEndId…): solo letras, números y guiones; sin espacios. */
export function sepaId(value: string): string {
  return sepaText(value, ID_MAX * 2)
    .replace(/[^A-Za-z0-9-]/g, '')
    .slice(0, ID_MAX);
}

/** 1234 → "12.34". */
export function sepaAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new SepaInputError('Importe no válido');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function iban(value: string): string {
  const v = value.replace(/\s+/g, '').toUpperCase();
  if (!IBAN_RE.test(v)) throw new SepaInputError('IBAN no válido');
  return v;
}

/** «2026-11-13T10:00:00» (sin zona, como lo piden los bancos). */
function isoSeconds(d: Date): string {
  return d.toISOString().slice(0, 19);
}

/** El XML pain.001.001.03 con una orden (PmtInf) y una transferencia por acreedor. Sin transferencias, error. */
export function buildPain001(input: Pain001Input): string {
  if (input.transfers.length === 0) throw new SepaInputError('No hay transferencias que hacer');
  if (!DATE_RE.test(input.executionDate)) throw new SepaInputError('Fecha de ejecución no válida');
  const messageId = sepaId(input.messageId);
  if (!messageId) throw new SepaInputError('Falta el identificador del fichero');
  const debtorName = sepaText(input.debtor.name, NAME_MAX) || 'Organizador';
  const debtorIban = iban(input.debtor.iban);
  const transfers = input.transfers.map((t) => {
    if (t.amountCents <= 0) throw new SepaInputError('Una transferencia sin importe');
    return {
      endToEndId: sepaId(t.endToEndId) || 'NOTPROVIDED',
      name: sepaText(t.creditorName, NAME_MAX) || 'Beneficiario',
      iban: iban(t.creditorIban),
      amount: sepaAmount(t.amountCents),
      remittance: sepaText(t.remittance, REMITTANCE_MAX),
    };
  });
  const count = String(transfers.length);
  const ctrlSum = sepaAmount(input.transfers.reduce((a, t) => a + t.amountCents, 0));
  const txs = transfers
    .map(
      (t) => `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${xml(t.endToEndId)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">${t.amount}</InstdAmt></Amt>
        <Cdtr><Nm>${xml(t.name)}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${t.iban}</IBAN></Id></CdtrAcct>${
          t.remittance ? `\n        <RmtInf><Ustrd>${xml(t.remittance)}</Ustrd></RmtInf>` : ''
        }
      </CdtTrfTxInf>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${xml(messageId)}</MsgId>
      <CreDtTm>${isoSeconds(input.createdAt)}</CreDtTm>
      <NbOfTxs>${count}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <InitgPty><Nm>${xml(debtorName)}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${xml(messageId)}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${count}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt>${input.executionDate}</ReqdExctnDt>
      <Dbtr><Nm>${xml(debtorName)}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${debtorIban}</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
${txs}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}

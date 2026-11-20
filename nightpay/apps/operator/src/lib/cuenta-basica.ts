// «Cuenta de pago básica» (/cuenta-basica): la guía para quien no tiene cuenta
// de banco. Qué es, quién tiene derecho, qué papeles llevar, cuánto cuesta,
// cuándo contesta el banco y cómo reclamar. Información general, no
// asesoramiento legal (la carta del local para el banco queda para cuando la
// revise el abogado).

export interface CuentaBasicaSection {
  /** El ancla (/cuenta-basica#plazo). */
  id: string;
  title: string;
  points: readonly string[];
}

export const CUENTA_BASICA: readonly CuentaBasicaSection[] = [
  {
    id: 'que-es',
    title: 'Qué es',
    points: [
      'Una cuenta de banco sencilla para el día a día: te pueden pagar en ella, tienes una tarjeta para pagar y sacar dinero del cajero, y puedes hacer transferencias.',
      'Cuando la tengas, pásale tu IBAN al dueño del local y te pagarán ahí.',
    ],
  },
  {
    id: 'derecho',
    title: 'Quién tiene derecho',
    points: [
      'Toda persona que vive legalmente en la Unión Europea, también si no tiene domicilio fijo.',
      'Quien ha pedido asilo (protección internacional), y quien no tiene permiso de residencia pero no puede ser expulsada.',
      'Lo dice el Real Decreto-ley 19/2017, de cuentas de pago básicas: los bancos que trabajan en España tienen que abrírtela.',
      'Te la pueden negar si ya tienes en España otra cuenta con lo mismo, o por las normas contra el blanqueo de dinero.',
    ],
  },
  {
    id: 'papeles',
    title: 'Qué papeles llevar',
    points: [
      'Tu documento de identidad: pasaporte, NIE o TIE. Si has pedido asilo, el documento de tu solicitud.',
      'Algo que diga dónde vives, si lo tienes: por ejemplo, el empadronamiento.',
      'El banco te preguntará a qué te dedicas y de dónde viene tu dinero: la ley se lo exige. Contesta la verdad.',
      'Pídela por escrito («Solicito abrir una cuenta de pago básica») y quédate una copia con la fecha.',
    ],
  },
  {
    id: 'cuesta',
    title: 'Cuánto cuesta',
    points: [
      'Como mucho 3 € al mes, con todo lo básico incluido.',
      'Si estás en una situación de vulnerabilidad, puede ser gratis: pregúntalo en el banco.',
    ],
  },
  {
    id: 'plazo',
    title: 'Cuándo te contestan',
    points: [
      'El banco tiene que abrírtela o decirte que no en 10 días hábiles desde que entregas todo.',
      'Si te dice que no, tiene que decírtelo por escrito, gratis y con el motivo (salvo que la ley no le deje decirlo).',
    ],
  },
  {
    id: 'reclamar',
    title: 'Cómo reclamar',
    points: [
      'Primero, por escrito al servicio de atención al cliente del banco. Guarda el justificante.',
      'Si no te contestan o no te dan la razón, reclama gratis al Banco de España, en su Portal del Cliente Bancario (clientebancario.bde.es).',
    ],
  },
];

export const CUENTA_BASICA_SOURCES =
  'Información general, no es asesoramiento legal. Fuentes: Real Decreto-ley 19/2017 (cuentas de pago básicas) y Orden ETD/699/2020 (lo que cuesta).';

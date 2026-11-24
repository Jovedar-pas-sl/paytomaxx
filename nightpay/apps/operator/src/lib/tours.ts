// Los tutoriales de las pantallas del personal: el «?» de la cabecera abre uno
// por pantalla y, la primera vez que alguien entra en ella en este móvil, sale
// solo (si la pantalla está libre). Cada paso apunta a un elemento con
// `data-tour="…"`; si ese elemento no está en pantalla (por el rol o por el
// estado), el paso se salta. Textos cortos, en español sencillo.

import type { TourStep } from '@nightpay/ui';
import { AMOUNT_HELP, METHOD_HELP, tapHelp } from './reception-help';

export interface TourDef {
  /** Una clave de localStorage por pantalla: np-tour-<screen>-v1. */
  screen: string;
  steps: readonly TourStep[];
  /**
   * La primera vez no sale sola: la pantalla es un cobro o un resultado
   * (PAGADO, CARGADO) y no se oscurece con el cliente delante. El «?» sí.
   */
  manualOnly?: boolean;
}

export const TOURS = {
  cobrar: {
    screen: 'cobrar',
    steps: [
      { target: 'cobrar-carta', title: 'La carta', text: 'Toca lo que se lleva el cliente: cada toque suma una unidad. Cada sección tiene su color y su nombre.' },
      { target: 'cobrar-otro', title: 'Otro importe', text: 'Si no está en la carta, teclea el importe y elige la sección.' },
      { target: 'cobrar-resumen', title: 'Lo que llevas', text: '«Deshacer» quita lo último que has tocado. «Ver cuenta» abre la lista para cambiar cantidades.' },
      { target: 'cobrar-cobrar', title: 'Cobrar', text: 'Cuando esté todo, toca «Cobrar». El cliente paga con el QR o, si el local usa fichas, acercando su ficha.' },
      { target: 'cobrar-miqr', title: 'Mi QR', text: 'Enséñaselo al camarero cuando te inviten a una copa.' },
      { target: 'cobrar-recargar', title: 'Recargar saldo', text: 'Para cargar dinero en el saldo de un cliente, con las mismas pantallas que Recepción.' },
    ],
  },
  cuenta: {
    screen: 'cuenta',
    steps: [
      { target: 'cuenta-lineas', title: 'Lo que lleva', text: 'Cada línea es un producto. Con «−» y «+» cambias cuántos son; con «−» en el último, se quita.' },
      { target: 'cuenta-anadir', title: 'Añadir algo', text: 'Vuelve a la carta para sumar más cosas sin perder la cuenta.' },
      { target: 'cuenta-reparto', title: 'Cómo se reparte', text: 'Cuánto va a cada sección. Es para que lo veas; no hay que hacer nada.' },
      { target: 'cuenta-total', title: 'Total', text: 'Lo que va a pagar el cliente.' },
      { target: 'cuenta-cobrar', title: 'Cobrar', text: 'Toca «Cobrar» y sale el cobro. Si ves «Con datáfono», el cobro se hace en el datáfono en vez de con el QR.' },
    ],
  },
  esperando: {
    screen: 'esperando',
    manualOnly: true,
    steps: [
      { target: 'esperando-importe', title: 'Lo que paga', text: 'Es el importe que va a pagar el cliente. Que lo vea antes de pagar.' },
      { target: 'esperando-qr', title: 'El QR', text: 'El cliente lo escanea con la cámara de su móvil y paga con tarjeta o con su saldo.' },
      { target: 'esperando-formas', title: 'QR o ficha', text: 'Si el local usa fichas, también puede acercar su ficha por detrás del móvil. Vale la primera que llegue.' },
      { target: 'esperando-estado', title: 'Cómo va', text: 'Aquí ves qué pasa y cuánto le queda al QR. Cuando pague, sale PAGADO. Si el banco tarda, no cobres otra vez.' },
      { target: 'esperando-sinmovil', title: 'Sin móvil ni ficha', text: 'Si el cliente no tiene ni móvil ni ficha, cobra aquí con su código o su pase, y su PIN.' },
      { target: 'esperando-cancelar', title: 'Cancelar cobro', text: 'Si el cliente ya no va a pagar, cancela el cobro.' },
    ],
  },
  sinMovil: {
    screen: 'sin-movil',
    manualOnly: true,
    steps: [
      { target: 'sinmovil-opciones', title: 'Dos formas', text: 'Elige la que tenga el cliente: su código del saldo o el QR de su pase.' },
      { target: 'sinmovil-codigo', title: 'Su código', text: 'Escribe el código de su saldo (como K7Q-4M2). Después, el cliente pone su PIN.' },
      { target: 'sinmovil-pase', title: 'Su pase', text: 'Apunta la cámara al QR de su pase de Google Wallet o al de la página de su saldo.' },
      { target: 'sinmovil-otra', title: 'Otra forma de pagar', text: 'Vuelve atrás para elegir la otra forma.' },
    ],
  },
  miQr: {
    screen: 'mi-qr',
    steps: [
      { target: 'miqr-codigo', title: 'Tu QR', text: 'El camarero lo escanea cuando te invitan a una copa. Si no se lee, sube el brillo del móvil.' },
      { target: 'miqr-noche', title: 'Tus invitaciones', text: 'Cuántas copas te han invitado esta noche y lo que llevas de ellas.' },
      { target: 'miqr-brillo', title: 'El brillo', text: 'Sube el brillo del móvil al máximo para que el lector del camarero lo vea bien.' },
    ],
  },
  cobros: {
    screen: 'cobros',
    steps: [
      { target: 'cobros-total', title: 'Tu noche', text: 'Arriba, lo vendido esta noche, con propinas y sin devoluciones. Las recargas se cuentan aparte: no son venta.' },
      { target: 'cobros-fila', title: 'Cada cobro', text: 'Tus cobros, del último al primero. Toca uno para ver su detalle.' },
      { target: 'cobros-estado', title: 'El estado', text: 'Pagado: ya cuenta en tu noche. Pendiente o Pagando: aún no ha pagado, espera. Fallido, Caducado o Cancelado: no se ha cobrado nada.' },
      { target: 'cobros-cancelar', title: 'Cancelar', text: 'Si un cobro sigue pendiente y el cliente ya no paga, toca «Cancelar».' },
      { target: 'cobros-lista', title: 'Si pasa esto', text: 'Si el banco tarda, no cobres otra vez. Para devolver un cobro, avisa al encargado o al dueño: se hace desde el panel.' },
    ],
  },
  ganancias: {
    screen: 'ganancias',
    steps: [
      { target: 'ganancias-noche', title: 'Esta noche', text: 'Lo que te pagarán al cerrar la noche. Toca para ver de dónde sale.' },
      { target: 'ganancias-otras', title: 'Lo demás', text: 'Lo pendiente de otras noches, lo que está en espera y las deudas o descuentos. Toca una fila para verla.' },
      { target: 'ganancias-proximo', title: 'Próximo pago', text: 'Lo que entra en tu próximo pago y de dónde sale.' },
      { target: 'ganancias-pagos', title: 'Pagos recibidos', text: 'Los últimos pagos, con su fecha y la cuenta a la que se te paga.' },
    ],
  },
  recepcionLectura: {
    screen: 'recepcion-lectura',
    steps: [
      { target: 'recep-modo', title: 'Entrada o salida', text: 'Entrada: el cliente carga saldo. Salida: ve lo que le queda y se lo guarda para la próxima visita.' },
      { target: 'recep-nfc', title: 'Acerca la ficha', text: tapHelp('entrada') },
      { target: 'recep-otras', title: 'Sin ficha a mano', text: 'Si no se puede leer, escribe su código o busca el número impreso en la ficha.' },
      { target: 'recep-mas', title: 'Fichas y pendientes', text: 'Preparar fichas nuevas, asignar recargas pendientes, dar una ficha a un saldo o cambiar una ficha perdida.' },
    ],
  },
  recepcionImporte: {
    screen: 'recepcion-importe',
    manualOnly: true,
    steps: [
      { target: 'recep-ficha', title: 'La ficha leída', text: 'Aquí ves de quién es: su número, si es nueva o lo que ya tiene.' },
      { target: 'recep-importes', title: '¿Cuánto carga?', text: AMOUNT_HELP },
      { target: 'recep-pin', title: 'Su PIN', text: 'Si hace falta, que el cliente elija su PIN antes de cargar.' },
    ],
  },
  recepcionPago: {
    screen: 'recepcion-pago',
    manualOnly: true,
    steps: [
      { target: 'recep-total', title: 'Lo que se carga', text: 'Gira el móvil: el cliente ve el importe y su ficha antes de pagar.' },
      { target: 'recep-metodos', title: '¿Cómo paga?', text: `${METHOD_HELP} «Efectivo» carga en cuanto lo tocas: no lo toques antes de tener el dinero.` },
      { target: 'recep-nota', title: 'Sobre el PIN', text: 'Esta nota dice si el saldo ya tiene PIN o si hay que ponerlo al pasar de un tope.' },
    ],
  },
  recepcionCargado: {
    screen: 'recepcion-cargado',
    manualOnly: true,
    steps: [
      { target: 'recep-cargado', title: 'Cargado', text: 'El dinero ya está dentro del saldo. Abajo, lo que has de hacer ahora, en orden.' },
      { target: 'recep-ids', title: 'Ficha y código', text: 'El número de su ficha y su código. Dale la ficha al cliente y que apunte su código.' },
      { target: 'recep-siguiente', title: 'Seguir', text: '«Siguiente cliente» vuelve a la primera pantalla. Si sale «Que elija su PIN», pásale el móvil.' },
    ],
  },
  recepcionSalida: {
    screen: 'recepcion-salida',
    manualOnly: true,
    steps: [
      { target: 'recep-quedan', title: 'Lo que le queda', text: 'El saldo que el cliente tiene al salir.' },
      { target: 'recep-guardar', title: 'Guardar', text: 'Se queda en su ficha y su código para otra noche. No se toca nada.' },
      { target: 'recep-regla', title: 'No se devuelve', text: 'El saldo no se devuelve: se queda para la próxima visita. Ni en efectivo ni a la tarjeta.' },
    ],
  },
  prepararFichas: {
    screen: 'preparar-fichas',
    steps: [
      { target: 'prep-contador', title: 'Fichas preparadas', text: 'Cuántas fichas has preparado ya en el stock de este local.' },
      { target: 'prep-accion', title: 'Empezar', text: 'Toca «Empezar», acerca una ficha, retírala y acerca la siguiente. «Parar» cuando acabes.' },
      { target: 'prep-numero', title: 'Número impreso', text: 'Copia el número que lleva impreso cada ficha, con sus ceros. Te proponemos el siguiente.' },
      { target: 'prep-registro', title: 'Últimas fichas', text: 'Aquí sale cada ficha que has preparado y si hubo algún problema.' },
    ],
  },
  fichaPerdida: {
    screen: 'ficha-perdida',
    steps: [
      { target: 'perdida-escanear', title: 'Su QR', text: 'Escanea el QR de su saldo para encontrarlo: es lo más rápido.' },
      {
        target: 'perdida-codigo',
        title: 'Su código',
        text: 'O busca su saldo por el código. Lo encuentres como lo encuentres, si no eres encargado el cliente pondrá su PIN (si no tiene PIN, se la da el encargado).',
      },
      { target: 'perdida-numero', title: 'Número de la ficha', text: 'O busca por el número de la ficha que perdió. Después se acerca la ficha nueva, que cuesta lo que diga el local.' },
      { target: 'perdida-volver', title: 'Volver', text: 'Vuelve a Recepción sin cambiar nada.' },
    ],
  },
  darFicha: {
    screen: 'dar-ficha',
    steps: [
      { target: 'dar-escanear', title: 'Su QR', text: 'Quien cargó su saldo desde casa te enseña el QR de su saldo en el móvil.' },
      { target: 'dar-codigo', title: 'Su código', text: 'O teclea el código del saldo. Si no eres encargado, el cliente pondrá su PIN.' },
      { target: 'dar-acercar', title: 'Acercar la ficha', text: 'Con el saldo encontrado, acerca una ficha nueva o del stock: queda unida a ese saldo.' },
      { target: 'dar-volver', title: 'Volver', text: 'Vuelve a Recepción sin dar ninguna ficha.' },
    ],
  },
  perfil: {
    screen: 'perfil',
    steps: [
      { target: 'perfil-foto', title: 'Tu foto y tu nombre', text: 'Toca «Cambiar foto» para elegir una de la galería o hacerla con la cámara. El nombre es el que ve el resto del personal en los cobros.' },
      { target: 'perfil-contacto', title: 'Contacto', text: 'Tu teléfono y el correo con el que entras. Para cambiar el correo hace falta tu contraseña de ahora.' },
      { target: 'perfil-seguridad', title: 'Seguridad', text: 'Cambia tu contraseña o cierra la sesión de este móvil. Al cambiar la contraseña se cierran tus sesiones en otros móviles.' },
      { target: 'perfil-movil', title: 'Este móvil', text: 'Tema, vibrar al tocar y letra más grande. Se guardan solo en este móvil.' },
    ],
  },
} as const satisfies Record<string, TourDef>;

export type TourKey = keyof typeof TOURS;

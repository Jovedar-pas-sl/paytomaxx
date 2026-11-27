// Los tutoriales del panel: el «?» de la barra de arriba abre el de la pestaña
// que se ve y, la primera vez que alguien abre cada una en este ordenador,
// sale solo (si la pantalla está libre). Cada paso apunta a un elemento con
// `data-tour="…"`; si no está en pantalla (por el rol, por los permisos o por
// el estado), el paso se salta. Textos cortos, en español sencillo.

import type { TourStep } from '@nightpay/ui';
import type { TabKey } from './roles';

export interface TourDef {
  /** Una clave de localStorage por pantalla: np-tour-<screen>-v1. */
  screen: string;
  steps: readonly TourStep[];
}

export const TOURS = {
  resumen: {
    screen: 'panel-resumen',
    steps: [
      { target: 'resumen-noche', title: 'Esta noche', text: 'Lo pagado desde que abriste la noche, hora a hora.' },
      { target: 'resumen-mapa', title: 'Tu dinero', text: 'Lo ganado, la caja y lo que debes. Toca una para abrir el mapa.' },
      { target: 'resumen-atencion', title: 'Pide tu atención', text: 'Lo que tienes que decidir o revisar.' },
      { target: 'resumen-cobros', title: 'Últimos cobros', text: 'Toca uno para ver su detalle.' },
    ],
  },
  payments: {
    screen: 'panel-cobros',
    steps: [
      { target: 'cobros-resumen', title: 'Hoy en cifras', text: 'Lo cobrado hoy y esta semana: pagos con tarjeta, reembolsos y neto.' },
      { target: 'cobros-filtros', title: 'Buscar y filtrar', text: 'Busca un cobro por su referencia (C-0025) o por el código del cliente, o filtra por estado.' },
      { target: 'cobros-tabla', title: 'La lista de cobros', text: 'Cada fila es un cobro, el más reciente arriba; la lista se actualiza sola. Toca uno para ver su detalle: abajo salen sus botones (devolver, anular, resolver).' },
      { target: 'cobros-estado', title: 'El estado', text: 'Pagado: cobrado. Sin pagar: abierto, caduca solo. Esperando pago: el cliente está pagando y falta la respuesta del banco. Sin confirmar: el banco no dijo si lo cobró; míralo en su portal. Devuelto: se devolvió.' },
    ],
  },
  money: {
    screen: 'panel-mapa-dinero',
    steps: [
      { target: 'mapa-fechas', title: 'Fechas', text: 'Por defecto sale esta noche. Cambia las fechas para ver otro periodo y vuelve con «Esta noche».' },
      { target: 'mapa-ganado', title: '¿Cuánto he ganado?', text: 'Lo tuyo: lo vendido menos lo de las compañeras, las comisiones y lo que se haya devuelto de ventas.' },
      { target: 'mapa-caja', title: 'La caja', text: 'Lo que debería haber en la caja: fondo más efectivo cobrado, menos salidas. Con la noche abierta, «Cerrar la caja» te lleva a cerrarla.' },
      { target: 'mapa-banco', title: 'El banco', text: 'Lo cobrado con tarjeta, menos lo devuelto. El día de abono lo confirma el banco.' },
      { target: 'mapa-debo', title: 'Lo que debes', text: 'Lo que se debe a las compañeras. «Ver por compañera» abre sus pagos.' },
      { target: 'mapa-vendido', title: 'Lo vendido', text: 'Cuánto se ha vendido en cada sección de la carta. Toca una para ver sus cobros.' },
    ],
  },
  incidents: {
    screen: 'panel-avisos',
    steps: [
      { target: 'aprobar-titulo', title: 'Por aprobar', text: 'Lo que pide el encargado: pagos a las compañeras y devoluciones grandes. Se aprueba con tu código 2FA y quien lo pide no puede aprobarlo. Sin decidir, caduca a las 24 horas.' },
      { target: 'aprobar-pendientes', title: 'Pendientes', text: 'Cada tarjeta es una solicitud. «Aprobar» o «Rechazar» (con motivo).' },
      { target: 'avisos-abiertos', title: 'Avisos abiertos', text: 'Lo que el panel ha visto raro: un cobro doble, un pago sin confirmar… Cada aviso trae su botón para arreglarlo.' },
      { target: 'avisos-resueltos', title: 'Resueltos hoy', text: 'Lo que ya se ha resuelto hoy, por si hace falta mirarlo.' },
    ],
  },
  operators: {
    screen: 'panel-companeras',
    steps: [
      { target: 'chicas-nueva', title: 'Nueva compañera', text: 'Para dar de alta a una compañera nueva.' },
      { target: 'chicas-tabla', title: 'Tus compañeras', text: 'Cada fila es una compañera, con su comisión, lo que se le debe y lo que ya se le ha pagado. Toca una para abrir su ficha.' },
      { target: 'chicas-estado', title: 'Estado', text: 'Si ya ha entrado y tiene todo listo para cobrar, o si le falta algo (cuenta, documentos).' },
      { target: 'chicas-camareros', title: 'Camareros', text: 'Los camareros salen aparte, con la misma ficha.' },
      { target: 'chicas-rrpp', title: 'Tus RRPP', text: 'Un RRPP es alguien de tu equipo con su % y su enlace para reservar. Se llevan en Clientes → Reservados y RRPP: este botón te lleva.' },
    ],
  },
  wallets: {
    screen: 'panel-saldos',
    steps: [
      { target: 'saldos-resumen', title: 'Saldos de hoy', text: 'Cuántos saldos activos hay y cuánto suman, y lo recargado, consumido y devuelto hoy.' },
      { target: 'saldos-lista', title: 'Lista de saldos', text: 'Cada fila es el saldo de un cliente, con su código. Arriba puedes buscar uno por su teléfono.' },
      { target: 'saldos-acciones', title: 'Acciones de un saldo', text: 'El saldo no se devuelve: se queda para la próxima visita. En cada saldo, según el caso: «Terminar devolución» (solo las pedidas antes), «Enlace nuevo», «Cobrar sin Face ID», «Desbloquear PIN», «Borrar PIN» y «Bloquear ficha».' },
    ],
  },
  fichas: {
    screen: 'panel-fichas',
    steps: [
      { target: 'fichas-resumen', title: 'Fichas en cifras', text: 'En stock: grabadas y sin dar. Entregadas: ahora mismo en manos de clientes.' },
      { target: 'fichas-noche', title: 'Por noche', text: 'Las fichas que se han movido cada noche.' },
      { target: 'fichas-lista', title: 'Cada ficha', text: 'Busca una ficha. Según el caso, puedes poner o cambiar su número impreso, marcarla como perdida o bloquearla.' },
    ],
  },
  nights: {
    screen: 'panel-noches',
    steps: [
      { target: 'noches-actual', title: 'La noche de hoy', text: 'Abre la noche al empezar y ciérrala al terminar: el cierre repasa lo pendiente, cuenta la caja y guarda el informe Z, que ya no cambia. Si nadie la cierra, se cierra sola a las 08:00.' },
      { target: 'noches-cerrar', title: 'Cerrar noche', text: 'Abre el cierre paso a paso. No se cierra hasta que lo pendiente esté repasado.' },
      { target: 'noches-lista', title: 'Noches anteriores', text: 'Cada fila es una noche con su horario, lo cobrado y cuándo se cerró. Toca «Ver» para abrir su informe.' },
    ],
  },
  bank: {
    screen: 'panel-banco',
    steps: [
      { target: 'banco-cuadre', title: 'Cuadre con el banco', text: 'Sube lo que el banco dice que cobró y se compara con lo apuntado aquí, cobro a cobro. Hazlo cada mañana con el día anterior.' },
      { target: 'banco-origen', title: 'De dónde es el fichero', text: 'Elige de dónde es el fichero que subes.' },
      { target: 'banco-subir', title: 'Hacer el cuadre', text: 'Elige el fichero y pulsa el botón. Lo que no cuadra sale abajo y en Avisos.' },
      { target: 'banco-anteriores', title: 'Cuadres anteriores', text: 'Los cuadres que ya hiciste. Toca uno para verlo.' },
    ],
  },
  carta: {
    screen: 'panel-carta',
    steps: [
      { target: 'carta-anadir', title: 'Añadir a la carta', text: 'Crea un producto con su precio y su sección. Es lo que el personal toca en su app para cobrar.' },
      { target: 'carta-lista', title: 'La carta', text: 'Los productos, sección por sección. El precio y la sección salen de aquí: nadie los teclea a mano.' },
      { target: 'carta-editar', title: 'Editar o desactivar', text: '«Editar» cambia el producto. «Desactivar» lo quita de la carta del personal sin borrarlo.' },
    ],
  },
  sections: {
    screen: 'panel-secciones',
    steps: [
      { target: 'secciones-local', title: 'Secciones del local', text: 'Cada cobro va a su sección. Cambia el nombre y el color, o apaga las que no uses.' },
      { target: 'secciones-puestos', title: 'Qué cobra cada puesto', text: 'Cada persona solo ve y cobra lo de su puesto. Las compañeras son siempre Sala; tú y el encargado lo podéis todo.' },
      { target: 'secciones-invitaciones', title: 'Invitaciones', text: '«Copa con invitación»: el cliente invita a una compañera a una copa y quien cobra escanea su QR. Ella se lleva su parte y el local, el resto.' },
      { target: 'secciones-ademas', title: 'Además', text: 'Las propinas y los cobros antiguos salen solos en los informes: no se eligen al cobrar.' },
    ],
  },
  terminals: {
    screen: 'panel-datafonos',
    steps: [
      { target: 'datafonos-alta', title: 'Dar de alta uno', text: 'Rellena los datos del datáfono para añadirlo a la red de tu local, por zona.' },
      { target: 'datafonos-lote', title: 'Crear un lote', text: 'Si tienes muchos, «+ Crear lote» los da de alta de una vez.' },
      { target: 'datafonos-lista', title: 'Tus datáfonos', text: 'Cada fila es un datáfono. La compañera elige la zona al cobrar y el camarero de esa zona lo confirma.' },
    ],
  },
  rules: {
    screen: 'panel-reglas',
    steps: [
      { target: 'reglas-comision', title: 'Comisión del servicio', text: 'Lo que paga el cliente por encima del precio. La cambia OxioPay; aquí ves cuál es.' },
      { target: 'reglas-chicas', title: 'Cobros de las compañeras', text: 'El tope por cobro de una compañera y la comisión del local sobre lo que cobra.' },
      { target: 'reglas-pagos', title: 'Pagos a las compañeras', text: 'Cuándo se les paga y cuántos días se espera por si hay devoluciones.' },
      { target: 'reglas-devoluciones', title: 'Devoluciones', text: 'Desde qué importe el encargado necesita tu aprobación para devolver.' },
    ],
  },
  methods: {
    screen: 'panel-formas-cobro',
    steps: [
      { target: 'formas-cobro', title: 'Formas de cobro', text: 'Lo que apagues deja de salir en las apps del personal.' },
      { target: 'formas-propinas', title: 'Propinas', text: 'La propina la elige el cliente al pagar. Aquí pones las que se le sugieren.' },
      { target: 'formas-casa', title: 'Cargar saldo desde casa', text: 'Un enlace del local para que el cliente cargue su saldo antes de llegar. Cualquiera con el enlace puede cargar.' },
    ],
  },
  night: {
    screen: 'panel-noche',
    steps: [
      { target: 'noche-nfc', title: 'Ficha sin PIN', text: 'El cliente solo acerca su ficha y queda pagado. Por encima de un importe, o al pasar el tope de la noche, pone su PIN.' },
      { target: 'noche-pin', title: 'Teclado del PIN', text: 'Lo que ve el cliente al poner su PIN en el móvil del personal o en el datáfono.' },
      { target: 'noche-recepcion', title: 'Recepción', text: 'Al recargar un saldo: los importes de un toque y el botón grande.' },
      { target: 'noche-cobrar', title: 'Al cobrar', text: 'El aviso de pagado o no pagado en las apps del personal.' },
      { target: 'noche-pantallas', title: 'Pantallas del personal', text: 'Cómo se ven los móviles del personal en este local, por ejemplo con contraste alto para salas con poca luz.' },
    ],
  },
  permissions: {
    screen: 'panel-permisos',
    steps: [
      { target: 'permisos-encargados', title: 'Encargados', text: 'Lo que pueden hacer todos los encargados. Tú siempre puedes todo.' },
      { target: 'permisos-persona', title: 'Por persona', text: 'Solo si alguien necesita algo distinto a los demás de su rol.' },
      { target: 'permisos-camareros', title: 'Camareros', text: 'Lo que pueden hacer todos los camareros del local.' },
    ],
  },
  partners: {
    screen: 'panel-plataformas',
    steps: [
      { target: 'plataformas', title: 'Otras plataformas', text: 'Las que entran con una clave en el saldo de tu local. Por ahora, los cajeros que cargan saldo aquí.' },
      { target: 'plataformas-estado', title: 'Cómo está', text: 'Activa, en pausa, dormida (90 días sin usarla), caducada o anulada. La pausa de OxioPay solo la quita OxioPay.' },
      { target: 'plataformas-botones', title: 'Qué puedes hacer', text: 'Cambiar la clave, pausarla, reanudarla o anularla. La clave nueva se ve una sola vez: cópiala al momento.' },
    ],
  },
  alerts: {
    screen: 'panel-telegram',
    steps: [
      { target: 'telegram-chat', title: 'El chat', text: 'A qué chat de Telegram van los avisos de este local. «Probar» manda un mensaje de prueba.' },
      { target: 'telegram-avisos', title: 'Qué avisos salen', text: 'Elige qué avisos te llegan al chat.' },
      { target: 'telegram-personas', title: 'Avisos por persona', text: 'Desde cuántas cancelaciones, «Otro importe», PIN fallados o cobros seguidos al mismo saldo de una persona en una noche te avisamos. 0 = no avisar.' },
      { target: 'telegram-privacidad', title: 'Privacidad', text: 'Qué datos viajan en los mensajes.' },
    ],
  },
  security: {
    screen: 'panel-seguridad',
    steps: [
      { target: 'seguridad-cuenta', title: 'Tu cuenta', text: 'Quién está dentro y el botón «Salir».' },
      { target: 'seguridad-2fa', title: 'Verificación en dos pasos', text: 'Pide un código de tu app de verificación para lo importante, como devolver o resolver un cobro.' },
      { target: 'seguridad-llave', title: 'Llave de acceso', text: 'Para confirmar con Face ID o huella en vez de con un código.' },
    ],
  },
  nightClose: {
    screen: 'panel-cierre-noche',
    steps: [
      { target: 'cierre-progreso', title: 'Pasos listos', text: 'Cuántos pasos del cierre están listos. Cada uno repasa algo de la noche.' },
      { target: 'cierre-pasos', title: 'Los pasos', text: 'Cada paso dice si está listo o necesita algo. «Ir a…» te lleva a donde se arregla. Si algo no se puede arreglar, marca «Lo he visto: cerrar igualmente».' },
      { target: 'cierre-congelar', title: 'Congelar el Z', text: 'Guarda el informe de la noche y la caja: ya no cambian. Solo se activa cuando todo está listo.' },
    ],
  },
  perfil: {
    screen: 'panel-perfil',
    steps: [
      { target: 'perfil-foto', title: 'Tu foto y tu nombre', text: 'Cambia tu foto (de la galería o con la cámara) y el nombre que ven los demás en las listas y en los cobros. Sin foto salen tus iniciales.' },
      { target: 'perfil-contacto', title: 'Contacto', text: 'Tu teléfono y el correo con el que entras al panel. Para cambiar el correo hace falta tu contraseña de ahora.' },
      { target: 'perfil-seguridad', title: 'Seguridad', text: 'Cambia tu contraseña o cierra la sesión. Al cambiar la contraseña se cierran tus sesiones en otros dispositivos.' },
      { target: 'perfil-movil', title: 'Este equipo', text: 'El tema del panel: oscuro, claro o como el equipo. Se guarda solo en este navegador.' },
    ],
  },
  reservations: {
    screen: 'panel-reservados',
    steps: [
      { target: 'reservados-vistas', title: 'Cuatro vistas', text: '«Reservas de la noche», los «Paquetes» que vendes, «RRPP y sus enlaces» (su % y su enlace) y el «Enlace web y señales» para reservar con señal.' },
      { target: 'reservados-noche', title: 'La noche', text: 'Cambia de noche con las flechas o la fecha. Debajo salen sus reservas y «Reservar para un cliente».' },
      { target: 'reservados-reserva', title: 'Cada reserva', text: 'El cliente, su referencia y lo pagado. Cuando llega, «Ha venido»; si no aparece, «No vino» (se puede deshacer).' },
    ],
  },
} as const satisfies Record<string, TourDef>;



export type TourKey = keyof typeof TOURS;

/** El tutorial de cada pestaña del panel (las que no salen aquí no llevan «?»). */
export const TAB_TOURS: Readonly<Partial<Record<TabKey, TourDef>>> = {
  resumen: TOURS.resumen,
  payments: TOURS.payments,
  money: TOURS.money,
  incidents: TOURS.incidents,
  operators: TOURS.operators,
  wallets: TOURS.wallets,
  fichas: TOURS.fichas,
  nights: TOURS.nights,
  bank: TOURS.bank,
  carta: TOURS.carta,
  sections: TOURS.sections,
  terminals: TOURS.terminals,
  rules: TOURS.rules,
  methods: TOURS.methods,
  night: TOURS.night,
  permissions: TOURS.permissions,
  alerts: TOURS.alerts,
  partners: TOURS.partners,
  security: TOURS.security,
  reservations: TOURS.reservations,
};

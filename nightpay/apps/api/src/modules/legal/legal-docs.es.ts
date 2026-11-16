import type { LegalDocs } from './legal-docs';
import type { LegalOwner } from './legal-owner';

/**
 * Los textos legales en castellano: la versión que vale. Si cambias algo
 * aquí, cambia lo mismo en legal-docs.en.ts y la fecha de legal-owner.ts.
 */
export function legalDocsEs(o: LegalOwner): LegalDocs {
  const mail = `[${o.email}](mailto:${o.email})`;
  return {
    'aviso-legal': {
      title: 'Aviso legal',
      blocks: [
        { h: 'Quién es el titular' },
        {
          p: `Según la Ley 34/2002 de servicios de la sociedad de la información y de comercio electrónico (LSSI), te informamos de que OxioPay es un servicio de ${o.name}.`,
        },
        {
          ul: [
            `Titular: ${o.name}`,
            `NIF: ${o.taxId}`,
            `Domicilio: ${o.address}`,
            `Email: ${mail}`,
            ...(o.registry ? [`Datos registrales: ${o.registry}`] : []),
          ],
        },
        { h: 'Qué es OxioPay' },
        {
          p: 'OxioPay es la herramienta con la que pagas en los locales que la usan: con tarjeta, con saldo prepago y, si el local lo ofrece, con bitcoin. Lo que compras te lo vende el local; OxioPay gestiona el cobro y el saldo.',
        },
        { h: 'Propiedad intelectual' },
        {
          p: 'La marca, el logotipo, los textos, el diseño y el software de OxioPay son de su titular o se usan con licencia. No puedes copiarlos ni usarlos con fines comerciales sin permiso por escrito.',
        },
        { h: 'Responsabilidad' },
        {
          p: 'Trabajamos para que el servicio funcione siempre, pero puede haber cortes por mantenimiento o por causas ajenas, como el banco o la conexión. Si algo falla durante un pago, la página te dice si se ha cobrado o no; ante cualquier duda, pregunta al personal del local.',
        },
        {
          p: 'Los enlaces a páginas de otros (por ejemplo, la del banco donde escribes la tarjeta) llevan a servicios que no controlamos y que tienen sus propias condiciones.',
        },
        { h: 'Ley aplicable' },
        {
          p: 'Este aviso se rige por la ley española. Si eres consumidor, puedes reclamar ante los tribunales de tu domicilio.',
        },
        {
          p: 'Más información: [Privacidad](/legal/privacidad), [Cookies](/legal/cookies) y [Condiciones](/legal/condiciones).',
        },
      ],
    },

    privacidad: {
      title: 'Política de privacidad',
      blocks: [
        {
          p: 'Aquí te explicamos qué datos tuyos trata OxioPay, para qué y qué derechos tienes.',
        },
        { h: 'Quién es el responsable' },
        {
          p: `${o.name} (NIF ${o.taxId}), ${o.address}. Para cualquier tema de privacidad, escríbenos a ${mail}.`,
        },
        { h: 'Si pagas en un local', id: 'clientes' },
        { p: 'Tratamos estos datos:' },
        {
          ul: [
            'Los del pago: importe, propina, local, fecha y hora, forma de pago y su resultado.',
            'Tu tarjeta la escribes en la página segura del banco (Redsys), no en OxioPay: no vemos ni guardamos su número completo. Del banco solo recibimos el resultado del pago.',
            'Si usas saldo: el saldo y sus movimientos, el código de tu QR o de tu ficha y, si los activas, tu PIN (guardado cifrado: nadie puede leerlo) y la llave de Face ID o huella de tu móvil. Tu cara y tu huella nunca salen del teléfono: solo guardamos una llave pública que no sirve para identificarte fuera de OxioPay.',
            'Tu teléfono, solo si nos lo das, para ayudarte a recuperar el saldo si pierdes la ficha.',
            'Si cargas saldo desde casa: lo mismo que en un pago, y una cookie que recuerda en tu móvil los saldos que has cargado.',
            'Datos técnicos: dirección IP, tipo de navegador y registros de seguridad.',
          ],
        },
        { p: 'Para qué los usamos y con qué base legal:' },
        {
          ul: [
            'Cobrar, darte el justificante y gestionar tu saldo y sus devoluciones: hace falta para el servicio que pides (contrato).',
            'Llevar la contabilidad y cumplir con Hacienda: obligación legal.',
            'Proteger el servicio, evitar fraudes y arreglar errores: interés legítimo.',
            'Guardar tu teléfono para recuperar el saldo: tu consentimiento, que puedes retirar cuando quieras.',
          ],
        },
        {
          p: 'No te enviamos publicidad, no vendemos tus datos, no hacemos perfiles comerciales y no tomamos decisiones automáticas que te afecten de forma importante.',
        },
        { h: 'Si trabajas en un local', id: 'personal' },
        {
          p: 'Si usas las apps del personal (panel, TPV o app de cobro), tratamos tu nombre, email, teléfono, foto (si la subes), tus cobros y comisiones, la cuenta bancaria donde te pagamos, tus accesos y la verificación en dos pasos.',
        },
        {
          p: 'Lo hacemos para darte acceso, calcular y pagarte lo que te corresponde, avisarte (por ejemplo, por Telegram) y mantener la seguridad. La base es tu relación con el local y las obligaciones legales, contables y fiscales.',
        },
        { h: 'Con quién compartimos los datos' },
        { p: 'Solo con quien hace falta para que el servicio funcione, siempre con contrato y deber de confidencialidad:' },
        {
          ul: [
            'El banco y las pasarelas de pago (Redsys y el banco del local) y los datáfonos (Paytef), para cobrar y devolver.',
            'Proveedores técnicos: el alojamiento del servidor y las copias de seguridad, Cloudflare (red y seguridad), Sentry (aviso de errores, con los datos personales tapados), Resend (envío de emails) y Telegram (avisos al personal).',
            'Google, si añades tu saldo a Google Wallet.',
            'Las autoridades, cuando la ley lo exige.',
          ],
        },
        {
          p: 'Algunos proveedores (como Cloudflare, Google, Sentry o Resend) pueden tratar datos fuera del Espacio Económico Europeo. Cuando pasa, lo hacen con las garantías del RGPD: el Marco de Privacidad de Datos UE-EE. UU. o las cláusulas contractuales tipo de la Comisión Europea.',
        },
        { h: 'Cuánto tiempo los guardamos' },
        {
          ul: [
            'Pagos, recargas, devoluciones y comisiones: 6 años, porque lo exige la ley mercantil (art. 30 del Código de Comercio).',
            'Tu saldo, tu teléfono y tus llaves: mientras el saldo exista. Si pides cerrarlo o borrar tus datos, quitamos el teléfono y las llaves y guardamos solo lo que pide la contabilidad durante el plazo anterior.',
            'Registros técnicos y de seguridad: el tiempo necesario para proteger el servicio y aclarar incidencias.',
            'Datos del personal: mientras dure la relación con el local y, después, los plazos que marca la ley.',
          ],
        },
        { h: 'Tus derechos', id: 'derechos' },
        {
          p: `Puedes pedirnos ver tus datos, corregirlos, borrarlos, limitar su uso, oponerte a que los usemos o llevártelos a otro sitio. Escríbenos a ${mail} con el asunto «Privacidad OxioPay» y, si lo tienes, el código de tu saldo o de tu justificante. Te contestamos en un mes como máximo y borramos todo lo que la ley no nos obligue a guardar.`,
        },
        {
          p: 'Si crees que no hemos atendido bien tu petición, puedes reclamar ante la Agencia Española de Protección de Datos: [www.aepd.es](https://www.aepd.es).',
        },
        { h: 'Menores' },
        {
          p: 'OxioPay se usa en locales de ocio para mayores de 18 años. No tratamos a sabiendas datos de menores.',
        },
        { h: 'Cambios' },
        { p: 'Si cambiamos esta política, lo verás aquí con la fecha de la última actualización.' },
      ],
    },

    cookies: {
      title: 'Política de cookies',
      blocks: [
        {
          p: 'OxioPay solo usa cookies técnicas: las imprescindibles para que funcionen el pago, el saldo y el idioma. No usamos cookies de analítica, de publicidad ni de redes sociales.',
        },
        {
          p: 'Por eso no te pedimos permiso con un banner: la ley (art. 22.2 de la LSSI) no lo exige para las cookies necesarias para darte el servicio que pides. Aun así, te contamos cuáles son:',
        },
        {
          table: {
            head: ['Nombre', 'Para qué sirve', 'Duración'],
            rows: [
              ['np_lang', 'Recuerda el idioma que eliges.', '12 horas'],
              ['npw_…', 'Confirma que este móvil hizo el pago, para activar después tu saldo.', '7 días'],
              ['npwv_…', 'Mantiene abierto tu saldo después de desbloquearlo con Face ID o huella.', '15 minutos sin uso (1 hora como máximo)'],
              ['np_saldos', 'Recuerda en este móvil los saldos que cargaste desde casa.', '180 días'],
              ['np_cola', 'Cuenta las cargas hechas con este móvil desde el cartel del local, para evitar abusos.', '1 día'],
              ['np_rt_…', 'Mantiene abierta la sesión del personal en el panel, el TPV y la app de cobro.', '30 días'],
              ['__cf_bm y similares', 'De Cloudflare: protegen la web de robots y ataques.', 'Hasta 30 minutos'],
            ],
          },
        },
        {
          p: 'Además, tu navegador guarda (en su almacenamiento local) el idioma que eliges durante 12 horas y, en las apps del personal, el tema claro u oscuro. Funcionan igual que las cookies técnicas.',
        },
        {
          p: 'Cuando pagas con tarjeta pasas a la página del banco (Redsys), que tiene sus propias cookies y su propia política.',
        },
        { h: 'Cómo borrarlas' },
        {
          p: 'Puedes borrar o bloquear las cookies desde los ajustes de tu navegador. Si las bloqueas, puede que no puedas pagar o ver tu saldo.',
        },
      ],
    },

    condiciones: {
      title: 'Condiciones de uso',
      blocks: [
        { p: 'Estas condiciones se aplican cuando pagas o usas saldo con OxioPay en un local. Al pagar, las aceptas.' },
        { h: 'Quién presta el servicio' },
        {
          p: `OxioPay es un servicio de ${o.name} (NIF ${o.taxId}). Lo que compras (bebidas, servicios…) te lo vende el local; OxioPay gestiona el cobro y el saldo. Más datos en el [Aviso legal](/legal/aviso-legal).`,
        },
        { h: 'Solo mayores de 18 años' },
        { p: 'Los locales que usan OxioPay son de ocio para adultos: para pagar tienes que ser mayor de edad.' },
        { h: 'Cómo se paga' },
        {
          ul: [
            'Antes de pagar ves el total: el precio, la comisión del servicio si el local la aplica y la propina, que es voluntaria. No hay cargos ocultos.',
            'La tarjeta (o Apple Pay y Google Pay) la escribes en la página segura del banco, no en OxioPay.',
            'Cuando el banco lo confirma, ves «Pagado» y puedes guardar el justificante.',
            'Si el local acepta bitcoin, el importe en bitcoin se fija durante unos minutos. Un pago en bitcoin no se puede anular desde la red.',
          ],
        },
        { h: 'El saldo', id: 'saldo' },
        {
          ul: [
            'El saldo es dinero que cargas por adelantado para pagar en el local o en los locales del mismo grupo que lo aceptan. No es una cuenta bancaria y no da intereses.',
            'Lo identifica tu QR o tu ficha. Protégelo con PIN o con Face ID o huella, y no compartas tu PIN.',
            'Si pierdes la ficha o el móvil, avisa al personal: bloqueamos el saldo para que nadie lo use.',
            `Puedes pedir cuando quieras que te devolvamos el saldo que no hayas gastado: en recepción, en efectivo al momento, o escribiendo a ${mail}, y te lo devolvemos a la tarjeta con la que lo cargaste en un plazo máximo de 14 días.`,
            'La comisión del servicio de una recarga, si la hubo, no forma parte del saldo.',
          ],
        },
        { h: 'Devoluciones y reclamaciones', id: 'devoluciones' },
        {
          ul: [
            'Lo que ya se ha consumido o el servicio ya prestado no se devuelve, salvo que haya un error.',
            `Si ves un cobro repetido, un importe equivocado o un cargo que no reconoces, díselo al personal del local o escríbenos a ${mail}. Si hay un error, te devolvemos el dinero a la misma tarjeta, o al saldo, en un plazo máximo de 14 días desde que lo comprobamos.`,
            'Tienes hojas de reclamaciones a tu disposición en el local.',
          ],
        },
        { h: 'Tus datos' },
        { p: 'Cómo tratamos tus datos está en [Privacidad](/legal/privacidad), y las cookies, en [Cookies](/legal/cookies).' },
        { h: 'Cambios' },
        { p: 'Podemos actualizar estas condiciones. A cada pago se le aplican las que estén vigentes en ese momento.' },
        { h: 'Ley y tribunales' },
        { p: 'Se aplica la ley española. Si eres consumidor, puedes reclamar ante los tribunales de tu domicilio.' },
      ],
    },
  };
}

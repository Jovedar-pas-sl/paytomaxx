import type { LegalDocs } from './legal-docs';
import type { LegalOwner } from './legal-owner';

/**
 * The legal texts in English: a translation of legal-docs.es.ts (the Spanish
 * version prevails). Same blocks, same order, same anchors.
 */
export function legalDocsEn(o: LegalOwner): LegalDocs {
  const mail = `[${o.email}](mailto:${o.email})`;
  return {
    'aviso-legal': {
      title: 'Legal notice',
      blocks: [
        { h: 'Who runs OxioPay' },
        {
          p: `Under Spanish Law 34/2002 on information society services and e-commerce (LSSI), we inform you that OxioPay is a service of ${o.name}.`,
        },
        {
          ul: [
            `Owner: ${o.name}`,
            `Tax ID (NIF): ${o.taxId}`,
            `Registered address: ${o.address}`,
            `Email: ${mail}`,
            ...(o.registry ? [`Registry details: ${o.registry}`] : []),
          ],
        },
        { h: 'What OxioPay is' },
        {
          p: 'OxioPay is the tool you pay with at the venues that use it: by card, with prepaid balance and, where the venue offers it, with bitcoin to load your balance or pay for a reservation. The venue sells you what you buy; OxioPay handles the payment and the balance.',
        },
        { h: 'Intellectual property' },
        {
          p: 'The OxioPay brand, logo, texts, design and software belong to their owner or are used under licence. You may not copy them or use them commercially without written permission.',
        },
        { h: 'Liability' },
        {
          p: 'We work to keep the service running at all times, but there may be interruptions for maintenance or for reasons beyond our control, such as the bank or the connection. If something goes wrong during a payment, the page tells you whether you were charged or not; if in doubt, ask the venue staff.',
        },
        {
          p: "Links to other sites (for example, the bank page where you enter your card) lead to services we do not control and that have their own terms.",
        },
        { h: 'Governing law' },
        {
          p: 'This notice is governed by Spanish law. If you are a consumer, you may bring a claim before the courts of your place of residence.',
        },
        {
          p: 'More information: [Privacy](/legal/privacidad), [Cookies](/legal/cookies) and [Terms](/legal/condiciones).',
        },
      ],
    },

    privacidad: {
      title: 'Privacy policy',
      blocks: [
        { p: 'This page explains what personal data OxioPay processes, why, and what rights you have.' },
        { h: 'Who is responsible' },
        {
          p: `${o.name} (Tax ID ${o.taxId}), ${o.address}. For any privacy matter, write to ${mail}.`,
        },
        { h: 'If you pay at a venue', id: 'clientes' },
        { p: 'We process this data:' },
        {
          ul: [
            'Payment data: amount, tip, venue, date and time, payment method and its result.',
            'You enter your card on the bank’s secure page (Redsys), not on OxioPay: we never see or store its full number. From the bank we only receive the result of the payment.',
            'If you use a balance: the balance and its movements, the code of your QR or card and, if you turn them on, your PIN (stored encrypted: nobody can read it) and your phone’s Face ID or fingerprint key. Your face and fingerprint never leave your phone: we only store a public key that cannot identify you outside OxioPay.',
            'Your phone number, only if you give it to us, to help you recover your balance if you lose your card.',
            'If you top up from home: the same as for a payment, plus a cookie that remembers on your phone the balances you topped up.',
            'If you make a reservation: your name, your phone number and the notes you write when booking.',
            'If you ask for the receipt by email: your email address, only to send it to you (Resend sends it). We do not store it in OxioPay.',
            'If you turn on “Notify me of every charge” in your balance (it is optional): the details your browser gives us to send you notifications (its notification address and keys) and the language of the notification.',
            'Technical data: IP address, browser type and security logs.',
          ],
        },
        { p: 'Why we use it and on what legal basis:' },
        {
          ul: [
            'To charge you, give you the receipt, manage your balance and refund charges with errors: needed for the service you ask for (contract).',
            'To manage your reservation and contact you about it: needed for the reservation you make (contract).',
            'To keep accounts and meet tax rules: legal obligation.',
            'To protect the service, prevent fraud and fix errors: legitimate interest.',
            'To keep your phone number for balance recovery: your consent, which you can withdraw at any time.',
            'To notify you of every charge on your balance: your consent. You can turn it off at any time in your balance, under “Notify me of every charge”.',
          ],
        },
        {
          p: 'We do not send you advertising, we do not sell your data, we do not build marketing profiles and we do not take automated decisions that significantly affect you.',
        },
        { h: 'If you work at a venue', id: 'personal' },
        {
          p: 'If you use the staff apps (dashboard, POS or payment app), we process your name, email, phone number, photo (if you upload one), your sales and commissions, the bank account we pay you into, your logins and two-step verification.',
        },
        {
          p: 'We do this to give you access, work out and pay what you are owed, send you alerts (for example, on Telegram) and keep things secure. The legal basis is your relationship with the venue and our legal, accounting and tax obligations.',
        },
        { h: 'Who we share data with' },
        { p: 'Only with those needed to run the service, always under contract and a duty of confidentiality:' },
        {
          ul: [
            'The bank and payment gateways (Redsys and the venue’s bank) and card terminals (Paytef), to take and refund payments.',
            'Technical providers: server hosting and backups, Cloudflare (network and security), Sentry (error reports, with personal data masked), Resend (email delivery) and Telegram (staff alerts).',
            'Google, if you add your balance to Google Wallet.',
            'Your browser’s notification service (from Google, Apple, Mozilla or Microsoft), if you turn on “Notify me of every charge”: it carries the notification to your phone encrypted and cannot read it.',
            'Public authorities, when the law requires it.',
          ],
        },
        {
          p: 'Some providers (such as Cloudflare, Google, Sentry or Resend) may process data outside the European Economic Area. When they do, they use GDPR safeguards: the EU-US Data Privacy Framework or the European Commission’s standard contractual clauses.',
        },
        { h: 'How long we keep it' },
        {
          ul: [
            'Payments, top-ups, refunds and commissions: 6 years, as required by Spanish commercial law (art. 30 of the Commercial Code).',
            'Your balance, phone number and keys: while the balance exists. If you ask us to close it or delete your data, we remove the phone number and keys and keep only what accounting requires, for the period above.',
            'Your reservation details (name, phone number and notes): like your balance data, while the reservation or its balance exists. If you ask us to delete them, we remove them and keep only what accounting requires, for the period above.',
            'Your “Notify me of every charge” subscription: until you turn it off or your browser stops accepting it.',
            'Technical and security logs: as long as needed to protect the service and look into incidents.',
            'Staff data: for as long as the relationship with the venue lasts and then for the periods set by law.',
          ],
        },
        { h: 'Your rights', id: 'derechos' },
        {
          p: `You can ask us to see your data, correct it, delete it, restrict its use, object to its use or take it elsewhere. Write to ${mail} with the subject "OxioPay privacy" and, if you have it, the code of your balance, receipt or reservation. We reply within one month and delete everything the law does not require us to keep.`,
        },
        {
          p: 'If you think we have not handled your request properly, you can complain to the Spanish Data Protection Agency: [www.aepd.es](https://www.aepd.es).',
        },
        { h: 'Minors' },
        { p: 'OxioPay is used at nightlife venues for people aged 18 and over. We do not knowingly process data of minors.' },
        { h: 'Changes' },
        { p: 'If we change this policy, you will see it here with the date of the last update.' },
      ],
    },

    cookies: {
      title: 'Cookie policy',
      blocks: [
        {
          p: 'OxioPay only uses technical cookies: the ones needed for payments, balances and your language to work. We do not use analytics, advertising or social media cookies.',
        },
        {
          p: 'That is why we do not ask for permission with a banner: the law (art. 22.2 of the LSSI) does not require it for cookies needed to provide the service you ask for. Even so, here they are:',
        },
        {
          table: {
            head: ['Name', 'What it does', 'Lifetime'],
            rows: [
              ['np_lang', 'Remembers the language you choose.', '12 hours'],
              ['npw_…', 'Confirms this phone made the payment, so you can activate your balance afterwards.', '7 days'],
              ['npwv_…', 'Keeps your balance open after you unlock it with Face ID or fingerprint.', '15 minutes idle (1 hour at most)'],
              ['np_saldos', 'Remembers on this phone the balances you topped up from home.', '180 days'],
              ['np_cola', 'Counts the top-ups made with this phone from the venue’s poster, to prevent abuse.', '1 day'],
              ['np_rt_…', 'Keeps staff signed in to the dashboard, the POS and the payment app.', '30 days'],
              ['__cf_bm and similar', 'Set by Cloudflare: protect the site against bots and attacks.', 'Up to 30 minutes'],
            ],
          },
        },
        {
          p: 'Your browser also keeps (in its local storage) the language you choose for 12 hours and, in the staff apps, the light or dark theme. They work like technical cookies.',
        },
        {
          p: 'When you pay by card you go to the bank’s page (Redsys), which has its own cookies and its own policy.',
        },
        { h: 'How to delete them' },
        {
          p: 'You can delete or block cookies in your browser settings. If you block them, you may not be able to pay or see your balance.',
        },
      ],
    },

    condiciones: {
      title: 'Terms of use',
      blocks: [
        { p: 'These terms apply when you pay, use a balance or make a reservation with OxioPay at a venue. By paying, you accept them.' },
        { h: 'Who provides the service' },
        {
          p: `OxioPay is a service of ${o.name} (Tax ID ${o.taxId}). The venue sells you what you buy (drinks, services…); OxioPay handles the payment and the balance. More details in the [Legal notice](/legal/aviso-legal).`,
        },
        { h: 'Adults only (18+)' },
        { p: 'The venues that use OxioPay are adult nightlife venues: you must be of legal age to pay.' },
        { h: 'How payment works' },
        {
          ul: [
            'Before paying you see the total: the price, the service fee if the venue applies one, and the tip, which is optional. There are no hidden charges.',
            'You enter your card (or Apple Pay and Google Pay) on the bank’s secure page, not on OxioPay.',
            'Once the bank confirms it, you see "Paid" and can save the receipt.',
            'If the venue accepts bitcoin (only to load your balance and to pay for a reservation, not at the bar), the bitcoin amount is fixed for a few minutes. A bitcoin payment cannot be reversed on the network.',
          ],
        },
        { h: 'Your balance', id: 'saldo' },
        {
          ul: [
            'Your balance is money you load in advance to pay at the venue, or at venues of the same group that accept it. It is not a bank account and it earns no interest.',
            'It is identified by your QR code or card. Protect it with a PIN or with Face ID or fingerprint, and do not share your PIN.',
            'If you lose your card or phone, tell the staff: we block the balance so nobody can use it.',
            'What you do not spend stays in your balance for your next visits to the venue (and to venues of the same group, if they share the balance). Your balance is not refunded in money, neither in cash nor to your card, however you loaded it: in cash, by card, with bitcoin or by paying for a reservation.',
            'The service fee on a top-up, if there was one, is not part of the balance.',
          ],
        },
        { h: 'Reservations', id: 'reservados' },
        {
          ul: [
            'To book, you pay a deposit of 30 % of the price of the reservation, or the full price. The deposit is not refunded.',
            'You can change the date once, at least 48 hours before the venue’s opening time that night.',
            'You can cancel the reservation at least 48 hours before the venue’s opening time: you lose the deposit and anything else you paid stays as balance for another night. With less than 48 hours to go, you can no longer cancel.',
            'If you do not show up that night, you lose the deposit and anything else you paid stays as balance for another night.',
            'If the venue cancels the reservation, what you paid stays as balance for another night.',
            'That balance follows the balance rules: it is not refunded in money.',
          ],
        },
        { h: 'Refunds and complaints', id: 'devoluciones' },
        {
          ul: [
            'What has already been consumed, or a service already provided, is not refunded unless there is an error.',
            `If a charge has an error (you are charged twice, you pay after it was cancelled, the amount is wrong or you do not recognise the charge), tell the venue staff or write to ${mail}. If there is an error, we refund that charge to the same card, or to your balance, within 14 days of checking it.`,
            'Official complaint forms (hojas de reclamaciones) are available at the venue.',
          ],
        },
        { h: 'Your data' },
        { p: 'How we handle your data is explained in [Privacy](/legal/privacidad), and cookies in [Cookies](/legal/cookies).' },
        { h: 'Changes' },
        { p: 'We may update these terms. Each payment is governed by the terms in force at the time.' },
        { h: 'Law and courts' },
        { p: 'Spanish law applies. If you are a consumer, you may bring a claim before the courts of your place of residence.' },
      ],
    },
  };
}

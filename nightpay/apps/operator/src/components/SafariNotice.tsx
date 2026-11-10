'use client';

import type { CSSProperties } from 'react';
import { useInstall } from '@nightpay/ui';
import { SAFARI_NOTICE_SCREEN, SAFARI_NOTICE_TEXT, showSafariNotice } from '../lib/staff-install';
import { HelpLine, useHelp } from './HelpLine';

/**
 * La app instalada en un iPhone o un iPad: para cobrar con ficha o leer una
 * invitación con la cámara, que abra OxioPay en Safari. Una línea con
 * «Entendido»; en cualquier otro móvil, nada.
 */
export function SafariNotice({ style }: { style?: CSSProperties }) {
  const { platform, apple } = useInstall();
  const help = useHelp(SAFARI_NOTICE_SCREEN);
  if (!showSafariNotice(platform, apple)) return null;
  return (
    <HelpLine help={help} style={style}>
      {SAFARI_NOTICE_TEXT}
    </HelpLine>
  );
}

import type { FastifyReply } from 'fastify';
import type { SettlementDetail } from '@nightpay/contracts';
import { settlementCsv, settlementDocumentHtml, settlementFileName } from './settlement-document';

/** El documento para imprimir / guardar como PDF (lo abre el panel; también se puede guardar). */
export function sendSettlementDocument(res: FastifyReply, detail: SettlementDetail, now: Date = new Date()): void {
  res
    .status(200)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Content-Disposition', `inline; filename="${settlementFileName(detail, 'html')}"`)
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(settlementDocumentHtml(detail, now));
}

export function sendSettlementCsv(res: FastifyReply, detail: SettlementDetail): void {
  res
    .status(200)
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${settlementFileName(detail, 'csv')}"`)
    .header('Cache-Control', 'no-store')
    .send(settlementCsv(detail));
}

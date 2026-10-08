import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { WebhookIngestProcessor } from './webhook-ingest.processor';

const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const TENANT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function makeProcessor(rawBody: string, provider = 'REDSYS') {
  const prisma = {
    webhookDelivery: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: BigInt(7),
        provider,
        tenantId: TENANT_ID,
        processedAt: null,
        rawBody: Buffer.from(rawBody, 'utf8'),
      }),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
  const payments = { transition: vi.fn().mockResolvedValue(undefined) };
  const adapter = {
    mapWebhookToFsmEvent: vi.fn().mockReturnValue({
      paymentId: PAYMENT_ID,
      event: { type: 'AUTHORIZED', providerTxId: 'abc123def456', provider },
    }),
  };
  const gateways = { get: vi.fn().mockReturnValue(adapter) };
  const processor = new WebhookIngestProcessor(
    prisma as any,
    payments as any,
    gateways as any,
  );
  const job = { data: { deliveryId: '7' } } as Job<{ deliveryId: string }>;
  return { processor, prisma, payments, adapter, job };
}

describe('WebhookIngestProcessor — formato del body persistido', () => {
  it('procesa body form-urlencoded (Redsys) sin intentar JSON.parse', async () => {
    const { processor, payments, adapter, prisma, job } = makeProcessor(
      `Ds_SignatureVersion=HMAC_SHA256_V1&Ds_MerchantParameters=eyJ9&Ds_Signature=sig&_paymentId=${PAYMENT_ID}`,
    );

    await processor.process(job);

    expect(adapter.mapWebhookToFsmEvent).toHaveBeenCalledWith(
      expect.objectContaining({ Ds_Signature: 'sig', _paymentId: PAYMENT_ID }),
    );
    expect(payments.transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      expect.objectContaining({ type: 'AUTHORIZED' }),
      TENANT_ID,
    );
    expect(prisma.webhookDelivery.update).toHaveBeenCalled();
  });

  it('sigue procesando body JSON (Peanpe/Paytef)', async () => {
    const { processor, adapter, payments, job } = makeProcessor(
      JSON.stringify({ status: '200', _paymentId: PAYMENT_ID }),
      'PEANPE',
    );

    await processor.process(job);

    expect(adapter.mapWebhookToFsmEvent).toHaveBeenCalledWith({
      status: '200',
      _paymentId: PAYMENT_ID,
    });
    expect(payments.transition).toHaveBeenCalled();
  });
});

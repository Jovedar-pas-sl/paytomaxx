import { z } from 'zod';
import { partnerSchemas } from './common';
import { LIVE_CODE_RE } from './wallet';

// La demo en modo prueba (PR 8 parte A): las fichas de prueba y las ayudas
// `POST /test/live-codes` y `POST /test/fixtures/reset`. Esquemas Fixture,
// TestLiveCodeRequest y TestLiveCode del contrato (pilot/openapi-piloto.yaml),
// que manda. Las ayudas solo existen con PARTNER_API_MODE=test y
// PARTNER_TEST_HELPERS=1 (apps/api/src/config/partner-test-mode.ts).

/** Las fichas de prueba, en el orden del contrato. */
export const FIXTURES = ['active', 'empty', 'ficha_uid', 'blocked', 'closed', 'lost_ficha', 'ficha_blocked', 'other_group', 'other_company'] as const;

export const Fixture = z.enum(FIXTURES, { error: 'must be one of the demo fixtures.' }).register(partnerSchemas, {
  id: 'Fixture',
  'x-decided-in-contract': true,
  description: "Demo fixtures (made-up data). Each has a fixed ficha link `https://demo-operator.oxiopay.example/?ficha=<token>`:\n\n| fixture | token | chip UID stored | balance | what it answers |\n|---|---|---|---|---|\n| `active` | `demo-ficha-active-0001` | none | 5000 | works |\n| `empty` | `demo-ficha-empty-00001` | none | 0 | balance 0; a load works |\n| `ficha_uid` | `demo-ficha-uid-0000001` | `04A1B2C3D4E5F6` | 5000 | works; another UID → `409 ficha_copy_suspected` |\n| `blocked` | `demo-ficha-blocked-001` | none | 5000 | `409 wallet_blocked` |\n| `closed` | `demo-ficha-closed-0001` | none | 0 | `409 wallet_closed` |\n| `lost_ficha` | `demo-ficha-lost-000001` | none | 5000 | the ficha → `409 ficha_lost`; a live code of its wallet works |\n| `ficha_blocked` | `demo-ficha-fblocked-01` | none | 5000 | the ficha → `409 ficha_blocked`; a live code of its wallet works |\n| `other_group` | `demo-ficha-othergroup1` | none | 5000 | `404 wallet_not_found` (another wallet group) |\n| `other_company` | `demo-ficha-othercomp01` | none | 5000 | `404 wallet_not_found` (same group, another company) |\n\nNo fixture has a contact phone. Every test key is issued for the demo venue \"Local Demo Centro\" (or another\nvenue of its company and wallet group), the only venues that reach these fixtures; they are shared by everyone\ntesting on the demo.\n\nDemo sample texts. The refusal depends only on the text's shape, so these made-up texts give these answers:\n\n| `qr` | answer |\n|---|---|\n| `https://demo-api.oxiopay.example/c/demoGoogleWalletPass00000000000000000000001` | `422 wallet_ref_not_accepted`, `reason: wallet_pass` |\n| `https://demo-api.oxiopay.example/w/demoPrivateLink000000001` | `reason: private_link` |\n| `NPF:K7Q4M2:demoReceptionProof0001` | `reason: reception_qr` |\n| `K7Q4M2` | `reason: short_code` |\n| `https://demo-api.oxiopay.example/pay/demoChargeLink000000000000000001` | `reason: charge_link` |\n| `https://demo-api.oxiopay.example/w/a/demoActivationLink000001` | `reason: other_link` |\n| `https://example.org/carta` | `422 wallet_ref_unrecognized` |\n\nOn request, OxioPay puts the demo connection or venue in the states that answer `method_disabled`,\n`venue_paused`, `partner_api_frozen`, `connection_paused` and `scope_paused`, and back.\n",
});
export type FixtureName = z.infer<typeof Fixture>;

export interface DemoFixtureDef {
  /** El código del enlace grabado: `https://<operator>/?ficha=<token>`. */
  readonly token: string;
  /** El número de serie guardado (como lo guarda OxioPay: hex en mayúsculas, sin separadores). */
  readonly uid: string | null;
  readonly balanceCents: number;
}

/** La tabla del contrato (Fixture): enlace, UID guardado y saldo de partida. */
export const DEMO_FIXTURES: Readonly<Record<FixtureName, DemoFixtureDef>> = {
  active: { token: 'demo-ficha-active-0001', uid: null, balanceCents: 5000 },
  empty: { token: 'demo-ficha-empty-00001', uid: null, balanceCents: 0 },
  ficha_uid: { token: 'demo-ficha-uid-0000001', uid: '04A1B2C3D4E5F6', balanceCents: 5000 },
  blocked: { token: 'demo-ficha-blocked-001', uid: null, balanceCents: 5000 },
  closed: { token: 'demo-ficha-closed-0001', uid: null, balanceCents: 0 },
  lost_ficha: { token: 'demo-ficha-lost-000001', uid: null, balanceCents: 5000 },
  ficha_blocked: { token: 'demo-ficha-fblocked-01', uid: null, balanceCents: 5000 },
  other_group: { token: 'demo-ficha-othergroup1', uid: null, balanceCents: 5000 },
  other_company: { token: 'demo-ficha-othercomp01', uid: null, balanceCents: 5000 },
};

export const TestLiveCodeRequest = z
  .strictObject({ fixture: Fixture })
  .register(partnerSchemas, {
    id: 'TestLiveCodeRequest',
    description: 'In this pilot only `fixture`; `can_pay` and `max` come with paying with balance.',
    'x-decided-in-contract': true,
  });
export type TestLiveCodeRequestBody = z.infer<typeof TestLiveCodeRequest>;

export const TestLiveCode = z
  .object({
    object: z.literal('test_live_code'),
    code: z.string().regex(LIVE_CODE_RE).register(partnerSchemas, { description: "An identify-only live code for the fixture's wallet." }),
    expires_in: z.literal(60).register(partnerSchemas, { description: 'Seconds the code stays valid.' }),
    livemode: z.literal(false),
  })
  .register(partnerSchemas, { id: 'TestLiveCode', 'x-decided-in-contract': true });
export type TestLiveCodeBody = z.infer<typeof TestLiveCode>;

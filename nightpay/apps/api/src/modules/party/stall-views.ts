import {
  ORGANIZER_OWN_BAR_BPS,
  maskIban,
  type CreateStallDto,
  type StallView,
  type UpdateStallDto,
} from '@nightpay/contracts';

/** Lo que se lee de una caseta (y cuántas personas la tienen). */
export const STALL_SELECT = {
  id: true,
  name: true,
  managerName: true,
  managerContact: true,
  organizerBps: true,
  iban: true,
  active: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface StallRow {
  id: string;
  name: string;
  managerName: string;
  managerContact: string | null;
  organizerBps: number;
  iban: string | null;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  _count?: { staff: number };
}

export function stallView(row: StallRow): StallView {
  return {
    id: row.id,
    name: row.name,
    managerName: row.managerName,
    managerContact: row.managerContact,
    organizerBps: row.organizerBps,
    ownBar: row.organizerBps === ORGANIZER_OWN_BAR_BPS,
    iban: row.iban,
    active: row.active,
    sortOrder: row.sortOrder,
    staffCount: row._count?.staff ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Los datos de una caseta nueva (el IBAN ya llega normalizado y comprobado). */
export function stallCreateData(tenantId: string, dto: CreateStallDto) {
  return {
    tenantId,
    name: dto.name,
    managerName: dto.managerName,
    managerContact: dto.managerContact ?? null,
    organizerBps: dto.organizerBps,
    iban: dto.iban ?? null,
    ...(dto.active !== undefined ? { active: dto.active } : {}),
    ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
  };
}

type StallFields = Pick<StallRow, 'name' | 'managerName' | 'managerContact' | 'organizerBps' | 'iban' | 'active' | 'sortOrder'>;
const EDITABLE = ['name', 'managerName', 'managerContact', 'organizerBps', 'iban', 'active', 'sortOrder'] as const;

/** Solo lo que cambia de verdad (lo que llega igual que lo guardado no cuenta). */
export function stallChange(current: StallFields, dto: UpdateStallDto): Partial<StallFields> {
  const change: Partial<StallFields> = {};
  for (const key of EDITABLE) {
    const next = dto[key];
    if (next !== undefined && next !== current[key]) (change as Record<string, unknown>)[key] = next;
  }
  return change;
}

/** Para el registro: el IBAN tapado (ES91 •••• •••• 1332), nunca entero. */
export function stallAudit(fields: Partial<StallFields>): Record<string, unknown> {
  const { iban, ...rest } = fields;
  return iban === undefined ? rest : { ...rest, iban: maskIban(iban) };
}

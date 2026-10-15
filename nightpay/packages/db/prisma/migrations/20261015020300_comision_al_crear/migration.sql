-- Revisión 2026-10-15 (#54): el % de la chica se fija al crear el cobro (su
-- commissionBps o el del local para la categoría), no al pagarse: si el dueño
-- cambia el % mientras el cliente paga, el cobro ya creado no cambia.
-- Nullable: los cobros ya creados se calculan al pagarse, como hasta ahora.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "operatorCommissionBps" INTEGER;

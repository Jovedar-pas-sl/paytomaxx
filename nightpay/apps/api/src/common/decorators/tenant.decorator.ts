import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '@nightpay/contracts';

export const Tenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    throw new Error('Tenant missing from request — AuthGuard must run first');
  }
  return tenantId;
});

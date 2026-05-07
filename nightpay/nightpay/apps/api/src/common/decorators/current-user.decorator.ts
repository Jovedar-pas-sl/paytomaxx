import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '@nightpay/contracts';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    return req.user;
  },
);

import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { JwtPayload } from "../../auth/auth.types";

export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<{ sessionId?: string }>();
    if (!req.sessionId) {
      throw new Error("sessionId missing — JwtAuthGuard must run first");
    }
    return req.sessionId;
  },
);

export function sessionIdFromPayload(payload: JwtPayload): string {
  return payload.sid;
}

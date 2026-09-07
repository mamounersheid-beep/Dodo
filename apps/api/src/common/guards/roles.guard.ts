import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { RoleCode } from "@dodo/shared-types";
import { ROLES_KEY } from "../decorators/roles.decorator";
import type { AuthUser } from "../../auth/auth.types";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RoleCode[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) {
      throw new ForbiddenException({ error: "FORBIDDEN", message: "No authenticated user" });
    }
    const ok = required.some((r) => user.roles.includes(r));
    if (!ok) {
      throw new ForbiddenException({ error: "FORBIDDEN", message: "Insufficient role" });
    }
    return true;
  }
}

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { RoleCode } from "@dodo/shared-types";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser, JwtPayload } from "../../auth/auth.types";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      user?: AuthUser;
      sessionId?: string;
    }>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Bearer token required" });
    }
    const token = header.slice("Bearer ".length).trim();
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Invalid or expired token" });
    }

    const session = await this.prisma.session.findUnique({ where: { id: payload.sid } });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== payload.sub) {
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Session revoked or expired" });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { roles: { include: { role: true } } },
    });
    if (!user || user.deletedAt || user.anonymizedAt) {
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Account unavailable" });
    }

    const roles = user.roles.map((r) => r.role.code as RoleCode);
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      locale: user.locale,
      roles,
      anonymizedAt: user.anonymizedAt,
    };
    req.sessionId = payload.sid;
    return true;
  }
}

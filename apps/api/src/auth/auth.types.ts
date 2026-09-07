import type { RoleCode } from "@dodo/shared-types";

export type JwtPayload = {
  sub: string;
  sid: string;
  roles: RoleCode[];
};

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  locale: string;
  roles: RoleCode[];
  anonymizedAt: Date | null;
};

export const REFRESH_COOKIE = "dodo_refresh";

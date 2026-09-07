import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { CompanySettings, Prisma } from "@dodo/database";
import type { AuthUser } from "../auth/auth.types";
import { verifyPassword } from "../auth/crypto.util";
import { PrismaService } from "../prisma/prisma.service";
import { toPublicObjectUrl } from "../catalog/public-object-url";
import type { PatchCompanySettingsDto } from "./dto/patch-company-settings.dto";

export const COMPANY_SETTINGS_ID = "default";
export const COMPANY_SETTINGS_AUDIT_ACTION = "company.settings.update";

const STORE_SETTINGS_MISSING = "STORE_SETTINGS_MISSING";

type WritablePatch = {
  legalName?: string;
  line1?: string;
  postalCode?: string;
  city?: string;
  countryCode?: string;
  supportEmail?: string | null;
  supportPhone?: string | null;
  logoObjectKey?: string | null;
  steuernummer?: string | null;
  vatId?: string | null;
  kleinunternehmerId?: string | null;
  isKleinunternehmer?: boolean;
  invoiceExemptionText?: string;
  kleinunternehmerSince?: Date | null;
  returnAddressName?: string | null;
  returnAddressLine1?: string | null;
  returnAddressLine2?: string | null;
  returnPostalCode?: string | null;
  returnCity?: string | null;
  returnCountryCode?: string | null;
  returnAddressPhone?: string | null;
  returnInstructionsMarkdown?: string | null;
  returnShipWithinDays?: number | null;
  returnShippingCostWiderrufPolicy?: CompanySettings["returnShippingCostWiderrufPolicy"];
  orderProcessingDaysMin?: number | null;
  orderProcessingDaysMax?: number | null;
  defaultLocale?: string;
  defaultManufacturerDisplayName?: string | null;
  defaultManufacturerAddressLine1?: string | null;
  defaultManufacturerAddressLine2?: string | null;
  defaultManufacturerPostalCode?: string | null;
  defaultManufacturerCity?: string | null;
  defaultManufacturerCountryCode?: string | null;
  defaultManufacturerEstablishedInUnion?: boolean | null;
  defaultManufacturerEmail?: string | null;
  defaultEuResponsiblePersonDisplayName?: string | null;
  defaultEuResponsiblePersonAddressLine1?: string | null;
  defaultEuResponsiblePersonAddressLine2?: string | null;
  defaultEuResponsiblePersonPostalCode?: string | null;
  defaultEuResponsiblePersonCity?: string | null;
  defaultEuResponsiblePersonCountryCode?: string | null;
  defaultEuResponsiblePersonEmail?: string | null;
};

const WRITABLE_KEYS = [
  "legalName",
  "line1",
  "postalCode",
  "city",
  "countryCode",
  "supportEmail",
  "supportPhone",
  "logoObjectKey",
  "steuernummer",
  "vatId",
  "kleinunternehmerId",
  "isKleinunternehmer",
  "invoiceExemptionText",
  "kleinunternehmerSince",
  "returnAddressName",
  "returnAddressLine1",
  "returnAddressLine2",
  "returnPostalCode",
  "returnCity",
  "returnCountryCode",
  "returnAddressPhone",
  "returnInstructionsMarkdown",
  "returnShipWithinDays",
  "returnShippingCostWiderrufPolicy",
  "orderProcessingDaysMin",
  "orderProcessingDaysMax",
  "defaultLocale",
  "defaultManufacturerDisplayName",
  "defaultManufacturerAddressLine1",
  "defaultManufacturerAddressLine2",
  "defaultManufacturerPostalCode",
  "defaultManufacturerCity",
  "defaultManufacturerCountryCode",
  "defaultManufacturerEstablishedInUnion",
  "defaultManufacturerEmail",
  "defaultEuResponsiblePersonDisplayName",
  "defaultEuResponsiblePersonAddressLine1",
  "defaultEuResponsiblePersonAddressLine2",
  "defaultEuResponsiblePersonPostalCode",
  "defaultEuResponsiblePersonCity",
  "defaultEuResponsiblePersonCountryCode",
  "defaultEuResponsiblePersonEmail",
] as const;

function trimOrKeep(value: string): string {
  return value.trim();
}

function trimToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = value.trim();
  return t.length === 0 ? null : t;
}

function jsonStable(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => {
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}

@Injectable()
export class CompanySettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAdmin(): Promise<Record<string, unknown>> {
    const row = await this.prisma.companySettings.findUnique({
      where: { id: COMPANY_SETTINGS_ID },
    });
    if (!row) {
      throw new ConflictException({
        error: STORE_SETTINGS_MISSING,
        message: "CompanySettings not configured",
      });
    }
    return this.serialize(row);
  }

  /** Public GET /v1/store/identity — live singleton, no JWT, MC-1/MC-2. */
  async getPublicIdentity(): Promise<Record<string, unknown>> {
    const row = await this.prisma.companySettings.findUnique({
      where: { id: COMPANY_SETTINGS_ID },
    });
    if (!row) {
      throw new ConflictException({
        error: STORE_SETTINGS_MISSING,
        message: "CompanySettings not configured",
      });
    }
    return this.serializePublicIdentity(row);
  }

  /**
   * OWNER PATCH — re-auth (currentPassword) already verified by caller.
   * Locks CompanySettings FOR UPDATE so invoice/order counters stay serialized.
   * Never writes invoiceNextNumber, orderNextNumber, defaultCurrencyCode, or #7 flags.
   */
  async patchAdmin(actor: AuthUser, dto: PatchCompanySettingsDto): Promise<Record<string, unknown>> {
    await this.assertReauth(actor.id, dto.currentPassword);

    const data = this.toWritablePatch(dto);

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CompanySettings" WHERE "id" = 'default' FOR UPDATE`;
      const current = await tx.companySettings.findUnique({
        where: { id: COMPANY_SETTINGS_ID },
      });
      if (!current) {
        throw new ConflictException({
          error: STORE_SETTINGS_MISSING,
          message: "CompanySettings not configured",
        });
      }

      const before = this.writableProjection(current);
      const next: WritablePatch = { ...data };
      if (Object.keys(next).length === 0) {
        return this.serialize(current);
      }

      const merged = { ...before, ...next };
      if (jsonStable(merged) === jsonStable(before)) {
        return this.serialize(current);
      }

      const updated = await tx.companySettings.update({
        where: { id: COMPANY_SETTINGS_ID },
        data: next as Prisma.CompanySettingsUpdateInput,
      });

      await tx.auditLog.create({
        data: {
          actorType: "ADMIN",
          actorId: actor.id,
          action: COMPANY_SETTINGS_AUDIT_ACTION,
          entityType: "CompanySettings",
          entityId: COMPANY_SETTINGS_ID,
          beforeJson: before as Prisma.InputJsonValue,
          afterJson: this.writableProjection(updated) as Prisma.InputJsonValue,
        },
      });

      return this.serialize(updated);
    });
  }

  private async assertReauth(userId: string, currentPassword: string): Promise<void> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!row.passwordHash || !(await verifyPassword(row.passwordHash, currentPassword))) {
      throw new UnauthorizedException({
        error: "UNAUTHORIZED",
        message: "Password incorrect",
      });
    }
  }

  private toWritablePatch(dto: PatchCompanySettingsDto): WritablePatch {
    const minDefined = dto.orderProcessingDaysMin !== undefined;
    const maxDefined = dto.orderProcessingDaysMax !== undefined;
    if (minDefined !== maxDefined) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "orderProcessingDaysMin and orderProcessingDaysMax must be sent together",
      });
    }

    const patch: WritablePatch = {};

    if (dto.legalName !== undefined) {
      const legalName = trimOrKeep(dto.legalName);
      if (legalName.length === 0) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: "legalName must not be empty",
        });
      }
      patch.legalName = legalName;
    }
    if (dto.line1 !== undefined) patch.line1 = trimOrKeep(dto.line1);
    if (dto.postalCode !== undefined) patch.postalCode = trimOrKeep(dto.postalCode);
    if (dto.city !== undefined) patch.city = trimOrKeep(dto.city);
    if (dto.countryCode !== undefined) patch.countryCode = trimOrKeep(dto.countryCode);
    if (dto.supportEmail !== undefined) patch.supportEmail = trimToNull(dto.supportEmail) ?? null;
    if (dto.supportPhone !== undefined) patch.supportPhone = trimToNull(dto.supportPhone) ?? null;
    if (dto.logoObjectKey !== undefined) patch.logoObjectKey = trimToNull(dto.logoObjectKey) ?? null;
    if (dto.steuernummer !== undefined) patch.steuernummer = trimToNull(dto.steuernummer) ?? null;
    if (dto.vatId !== undefined) patch.vatId = trimToNull(dto.vatId) ?? null;
    if (dto.kleinunternehmerId !== undefined) {
      patch.kleinunternehmerId = trimToNull(dto.kleinunternehmerId) ?? null;
    }
    if (dto.isKleinunternehmer !== undefined) patch.isKleinunternehmer = dto.isKleinunternehmer;
    if (dto.invoiceExemptionText !== undefined) {
      patch.invoiceExemptionText = dto.invoiceExemptionText.trim();
    }
    if (dto.kleinunternehmerSince !== undefined) {
      patch.kleinunternehmerSince =
        dto.kleinunternehmerSince === null ? null : new Date(dto.kleinunternehmerSince);
    }
    if (dto.returnAddressName !== undefined) {
      patch.returnAddressName = trimToNull(dto.returnAddressName) ?? null;
    }
    if (dto.returnAddressLine1 !== undefined) {
      patch.returnAddressLine1 = trimToNull(dto.returnAddressLine1) ?? null;
    }
    if (dto.returnAddressLine2 !== undefined) {
      patch.returnAddressLine2 = trimToNull(dto.returnAddressLine2) ?? null;
    }
    if (dto.returnPostalCode !== undefined) {
      patch.returnPostalCode = trimToNull(dto.returnPostalCode) ?? null;
    }
    if (dto.returnCity !== undefined) patch.returnCity = trimToNull(dto.returnCity) ?? null;
    if (dto.returnCountryCode !== undefined) {
      patch.returnCountryCode = trimToNull(dto.returnCountryCode) ?? null;
    }
    if (dto.returnAddressPhone !== undefined) {
      patch.returnAddressPhone = trimToNull(dto.returnAddressPhone) ?? null;
    }
    if (dto.returnInstructionsMarkdown !== undefined) {
      patch.returnInstructionsMarkdown = trimToNull(dto.returnInstructionsMarkdown) ?? null;
    }
    if (dto.returnShipWithinDays !== undefined) {
      patch.returnShipWithinDays = dto.returnShipWithinDays;
    }
    if (dto.returnShippingCostWiderrufPolicy !== undefined) {
      patch.returnShippingCostWiderrufPolicy = dto.returnShippingCostWiderrufPolicy;
    }
    if (dto.orderProcessingDaysMin !== undefined) {
      patch.orderProcessingDaysMin = dto.orderProcessingDaysMin;
      patch.orderProcessingDaysMax = dto.orderProcessingDaysMax ?? null;
    }
    if (dto.defaultLocale !== undefined) patch.defaultLocale = dto.defaultLocale;
    if (dto.defaultManufacturerDisplayName !== undefined) {
      patch.defaultManufacturerDisplayName = trimToNull(dto.defaultManufacturerDisplayName) ?? null;
    }
    if (dto.defaultManufacturerAddressLine1 !== undefined) {
      patch.defaultManufacturerAddressLine1 = trimToNull(dto.defaultManufacturerAddressLine1) ?? null;
    }
    if (dto.defaultManufacturerAddressLine2 !== undefined) {
      patch.defaultManufacturerAddressLine2 = trimToNull(dto.defaultManufacturerAddressLine2) ?? null;
    }
    if (dto.defaultManufacturerPostalCode !== undefined) {
      patch.defaultManufacturerPostalCode = trimToNull(dto.defaultManufacturerPostalCode) ?? null;
    }
    if (dto.defaultManufacturerCity !== undefined) {
      patch.defaultManufacturerCity = trimToNull(dto.defaultManufacturerCity) ?? null;
    }
    if (dto.defaultManufacturerCountryCode !== undefined) {
      patch.defaultManufacturerCountryCode = trimToNull(dto.defaultManufacturerCountryCode) ?? null;
    }
    if (dto.defaultManufacturerEstablishedInUnion !== undefined) {
      patch.defaultManufacturerEstablishedInUnion = dto.defaultManufacturerEstablishedInUnion;
    }
    if (dto.defaultManufacturerEmail !== undefined) {
      patch.defaultManufacturerEmail = trimToNull(dto.defaultManufacturerEmail) ?? null;
    }
    if (dto.defaultEuResponsiblePersonDisplayName !== undefined) {
      patch.defaultEuResponsiblePersonDisplayName =
        trimToNull(dto.defaultEuResponsiblePersonDisplayName) ?? null;
    }
    if (dto.defaultEuResponsiblePersonAddressLine1 !== undefined) {
      patch.defaultEuResponsiblePersonAddressLine1 =
        trimToNull(dto.defaultEuResponsiblePersonAddressLine1) ?? null;
    }
    if (dto.defaultEuResponsiblePersonAddressLine2 !== undefined) {
      patch.defaultEuResponsiblePersonAddressLine2 =
        trimToNull(dto.defaultEuResponsiblePersonAddressLine2) ?? null;
    }
    if (dto.defaultEuResponsiblePersonPostalCode !== undefined) {
      patch.defaultEuResponsiblePersonPostalCode =
        trimToNull(dto.defaultEuResponsiblePersonPostalCode) ?? null;
    }
    if (dto.defaultEuResponsiblePersonCity !== undefined) {
      patch.defaultEuResponsiblePersonCity = trimToNull(dto.defaultEuResponsiblePersonCity) ?? null;
    }
    if (dto.defaultEuResponsiblePersonCountryCode !== undefined) {
      patch.defaultEuResponsiblePersonCountryCode =
        trimToNull(dto.defaultEuResponsiblePersonCountryCode) ?? null;
    }
    if (dto.defaultEuResponsiblePersonEmail !== undefined) {
      patch.defaultEuResponsiblePersonEmail = trimToNull(dto.defaultEuResponsiblePersonEmail) ?? null;
    }

    return patch;
  }

  private writableProjection(row: CompanySettings): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of WRITABLE_KEYS) {
      const value = row[key];
      out[key] = value instanceof Date ? value.toISOString() : value;
    }
    return out;
  }

  private serializePublicIdentity(row: CompanySettings): Record<string, unknown> {
    const out: Record<string, unknown> = {
      legalName: row.legalName,
      line1: row.line1,
      postalCode: row.postalCode,
      city: row.city,
      countryCode: row.countryCode,
    };
    const present = (value: string | null | undefined): string | undefined => {
      if (value == null) return undefined;
      const t = value.trim();
      return t.length === 0 ? undefined : t;
    };
    const email = present(row.supportEmail);
    const phone = present(row.supportPhone);
    const steuernummer = present(row.steuernummer);
    const vatId = present(row.vatId);
    const kleinunternehmerId = present(row.kleinunternehmerId);
    const logoKey = present(row.logoObjectKey);
    if (email !== undefined) out.supportEmail = email;
    if (phone !== undefined) out.supportPhone = phone;
    if (logoKey !== undefined) out.logoUrl = toPublicObjectUrl(logoKey);
    if (steuernummer !== undefined) out.steuernummer = steuernummer;
    if (vatId !== undefined) out.vatId = vatId;
    if (kleinunternehmerId !== undefined) out.kleinunternehmerId = kleinunternehmerId;
    return out;
  }

  private serialize(row: CompanySettings): Record<string, unknown> {
    return {
      id: row.id,
      legalName: row.legalName,
      line1: row.line1,
      postalCode: row.postalCode,
      city: row.city,
      countryCode: row.countryCode,
      steuernummer: row.steuernummer,
      vatId: row.vatId,
      kleinunternehmerId: row.kleinunternehmerId,
      isKleinunternehmer: row.isKleinunternehmer,
      kleinunternehmerSince: row.kleinunternehmerSince?.toISOString() ?? null,
      invoiceExemptionText: row.invoiceExemptionText,
      defaultCurrencyCode: row.defaultCurrencyCode,
      defaultLocale: row.defaultLocale,
      supportPhone: row.supportPhone,
      supportEmail: row.supportEmail,
      invoiceNextNumber: row.invoiceNextNumber,
      orderNextNumber: row.orderNextNumber,
      logoObjectKey: row.logoObjectKey,
      updatedAt: row.updatedAt.toISOString(),
      returnAddressName: row.returnAddressName,
      returnAddressLine1: row.returnAddressLine1,
      returnAddressLine2: row.returnAddressLine2,
      returnPostalCode: row.returnPostalCode,
      returnCity: row.returnCity,
      returnCountryCode: row.returnCountryCode,
      returnAddressPhone: row.returnAddressPhone,
      returnInstructionsMarkdown: row.returnInstructionsMarkdown,
      returnShipWithinDays: row.returnShipWithinDays,
      returnShippingCostWiderrufPolicy: row.returnShippingCostWiderrufPolicy,
      orderProcessingDaysMin: row.orderProcessingDaysMin,
      orderProcessingDaysMax: row.orderProcessingDaysMax,
      defaultManufacturerDisplayName: row.defaultManufacturerDisplayName,
      defaultManufacturerAddressLine1: row.defaultManufacturerAddressLine1,
      defaultManufacturerAddressLine2: row.defaultManufacturerAddressLine2,
      defaultManufacturerPostalCode: row.defaultManufacturerPostalCode,
      defaultManufacturerCity: row.defaultManufacturerCity,
      defaultManufacturerCountryCode: row.defaultManufacturerCountryCode,
      defaultManufacturerEstablishedInUnion: row.defaultManufacturerEstablishedInUnion,
      defaultManufacturerEmail: row.defaultManufacturerEmail,
      defaultEuResponsiblePersonDisplayName: row.defaultEuResponsiblePersonDisplayName,
      defaultEuResponsiblePersonAddressLine1: row.defaultEuResponsiblePersonAddressLine1,
      defaultEuResponsiblePersonAddressLine2: row.defaultEuResponsiblePersonAddressLine2,
      defaultEuResponsiblePersonPostalCode: row.defaultEuResponsiblePersonPostalCode,
      defaultEuResponsiblePersonCity: row.defaultEuResponsiblePersonCity,
      defaultEuResponsiblePersonCountryCode: row.defaultEuResponsiblePersonCountryCode,
      defaultEuResponsiblePersonEmail: row.defaultEuResponsiblePersonEmail,
      maintenanceMode: row.maintenanceMode,
      maintenanceNoticeMarkdown: row.maintenanceNoticeMarkdown,
      maintenanceNoticeLocale: row.maintenanceNoticeLocale,
      checkoutEnabled: row.checkoutEnabled,
      paymentsEnabled: row.paymentsEnabled,
      couponsEnabled: row.couponsEnabled,
      bonusPlusEnabled: row.bonusPlusEnabled,
      operationalFlagsUpdatedAt: row.operationalFlagsUpdatedAt?.toISOString() ?? null,
    };
  }
}

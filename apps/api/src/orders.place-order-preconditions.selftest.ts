/**
 * Production placeOrder Slice 1 — Preconditions Gate only (test harness).
 *
 * Requires: DATABASE_URL (+ seeded CompanySettings + required DE LegalPages)
 * Run (after build): node dist/orders.place-order-preconditions.selftest.js
 */
import "reflect-metadata";
import { ConflictException, HttpException } from "@nestjs/common";
import { InventoryService } from "./inventory/inventory.service";
import { OrdersService } from "./orders/orders.service";
import {
  PlaceOrderPreconditionError,
  REQUIRED_DE_LEGAL_SLUGS,
} from "./orders/place-order-preconditions";
import { PrismaService } from "./prisma/prisma.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function conflictError(e: unknown): string | undefined {
  if (!(e instanceof ConflictException) && !(e instanceof HttpException)) return undefined;
  if (e instanceof HttpException && e.getStatus() !== 409) return undefined;
  const body = e.getResponse();
  if (typeof body === "object" && body && "error" in body) {
    return String((body as { error: string }).error);
  }
  return undefined;
}

async function sideEffectCounts(prisma: PrismaService) {
  const [orders, reservations, payments] = await Promise.all([
    prisma.order.count(),
    prisma.reservation.count(),
    prisma.payment.count(),
  ]);
  return { orders, reservations, payments };
}

async function main() {
  const results: Result[] = [];
  const scenarioIds = ["PG1", "PG2", "PG3", "PG4", "PG5", "PG6"] as const;

  let prisma: PrismaService | undefined;
  let svc: OrdersService | undefined;

  let companyRestore:
    | { checkoutEnabled: boolean; isKleinunternehmer: boolean }
    | undefined;
  let legalRestore:
    | { id: string; publishedAt: Date | null; supersededAt: Date | null }
    | undefined;

  const run = async (id: (typeof scenarioIds)[number], fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ id, status: "PASS" });
    } catch (e) {
      results.push({
        id,
        status: "FAIL",
        note: e instanceof Error ? e.message : String(e),
      });
    }
  };

  try {
    prisma = new PrismaService();
    await prisma.$connect();
    svc = new OrdersService(prisma, new InventoryService(prisma));

    const company = await prisma.companySettings.findUnique({ where: { id: "default" } });
    if (!company) throw new Error("CompanySettings default missing — seed required");
    companyRestore = {
      checkoutEnabled: company.checkoutEnabled,
      isKleinunternehmer: company.isKleinunternehmer,
    };

    // Ensure baseline allows pass: KU on, checkout on, legal pages published
    await prisma.companySettings.update({
      where: { id: "default" },
      data: { checkoutEnabled: true, isKleinunternehmer: true },
    });

    for (const slug of REQUIRED_DE_LEGAL_SLUGS) {
      const page = await prisma.legalPage.findFirst({
        where: { slug, countryCode: "DE", publishedAt: { not: null }, supersededAt: null },
      });
      if (!page) {
        throw new Error(
          `seed missing PUBLISHED LegalPage ${slug}/DE — run seed before Slice 1 harness`,
        );
      }
    }

    const baseline = await sideEffectCounts(prisma);

    await run("PG1", async () => {
      await prisma!.companySettings.update({
        where: { id: "default" },
        data: { checkoutEnabled: false },
      });
      try {
        await svc!.assertPlaceOrderPreconditions({ shippingCountryCode: "DE" });
        throw new Error("expected reject when checkoutEnabled=false");
      } catch (e) {
        if (conflictError(e) !== PlaceOrderPreconditionError.STORE_CHECKOUT_DISABLED) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      } finally {
        await prisma!.companySettings.update({
          where: { id: "default" },
          data: { checkoutEnabled: true },
        });
      }
    });

    await run("PG2", async () => {
      await prisma!.companySettings.update({
        where: { id: "default" },
        data: { isKleinunternehmer: false },
      });
      try {
        await svc!.assertPlaceOrderPreconditions({ shippingCountryCode: "DE" });
        throw new Error("expected reject when isKleinunternehmer=false");
      } catch (e) {
        if (conflictError(e) !== PlaceOrderPreconditionError.L1_TAX_INCOMPLETE) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      } finally {
        await prisma!.companySettings.update({
          where: { id: "default" },
          data: { isKleinunternehmer: true },
        });
      }
    });

    await run("PG3", async () => {
      const page = await prisma!.legalPage.findFirst({
        where: {
          slug: "datenschutz",
          countryCode: "DE",
          publishedAt: { not: null },
          supersededAt: null,
        },
      });
      if (!page) throw new Error("datenschutz published page missing for PG3 setup");
      legalRestore = {
        id: page.id,
        publishedAt: page.publishedAt,
        supersededAt: page.supersededAt,
      };
      await prisma!.legalPage.update({
        where: { id: page.id },
        data: { supersededAt: new Date() },
      });
      try {
        await svc!.assertPlaceOrderPreconditions({ shippingCountryCode: "DE" });
        throw new Error("expected reject when required legal page missing");
      } catch (e) {
        if (conflictError(e) !== PlaceOrderPreconditionError.REQUIRED_LEGAL_PAGES_MISSING) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      } finally {
        if (legalRestore) {
          await prisma!.legalPage.update({
            where: { id: legalRestore.id },
            data: {
              publishedAt: legalRestore.publishedAt,
              supersededAt: legalRestore.supersededAt,
            },
          });
          legalRestore = undefined;
        }
      }
    });

    await run("PG4", async () => {
      try {
        await svc!.assertPlaceOrderPreconditions({ shippingCountryCode: "AT" });
        throw new Error("expected reject when shippingCountryCode != DE");
      } catch (e) {
        if (conflictError(e) !== PlaceOrderPreconditionError.SHIPPING_COUNTRY_NOT_DE) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
    });

    await run("PG5", async () => {
      const ok = await svc!.assertPlaceOrderPreconditions({ shippingCountryCode: "DE" });
      if (!ok?.ok) throw new Error("expected Gate pass");
    });

    await run("PG6", async () => {
      // Re-run all gate paths once more and assert no commerce side effects
      await prisma!.companySettings.update({
        where: { id: "default" },
        data: { checkoutEnabled: false },
      });
      try {
        await svc!.assertPlaceOrderPreconditions({ shippingCountryCode: "DE" });
      } catch {
        /* expected */
      }
      await prisma!.companySettings.update({
        where: { id: "default" },
        data: { checkoutEnabled: true, isKleinunternehmer: false },
      });
      try {
        await svc!.assertPlaceOrderPreconditions({ shippingCountryCode: "DE" });
      } catch {
        /* expected */
      }
      await prisma!.companySettings.update({
        where: { id: "default" },
        data: { isKleinunternehmer: true },
      });
      try {
        await svc!.assertPlaceOrderPreconditions({ shippingCountryCode: "FR" });
      } catch {
        /* expected */
      }
      await svc!.assertPlaceOrderPreconditions({ shippingCountryCode: "DE" });

      const after = await sideEffectCounts(prisma!);
      if (
        after.orders !== baseline.orders ||
        after.reservations !== baseline.reservations ||
        after.payments !== baseline.payments
      ) {
        throw new Error(
          `side effects detected: before=${JSON.stringify(baseline)} after=${JSON.stringify(after)}`,
        );
      }
      // Gate never enqueues email — no EMAIL_INTEGRATION / Queue usage in OrdersService path
    });
  } catch (e) {
    for (const id of scenarioIds) {
      if (!results.some((r) => r.id === id)) {
        results.push({
          id,
          status: "BLOCKED",
          note: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    try {
      if (prisma && legalRestore) {
        await prisma.legalPage.update({
          where: { id: legalRestore.id },
          data: {
            publishedAt: legalRestore.publishedAt,
            supersededAt: legalRestore.supersededAt,
          },
        });
      }
      if (prisma && companyRestore) {
        await prisma.companySettings.update({
          where: { id: "default" },
          data: companyRestore,
        });
      }
    } catch (restoreErr) {
      console.error("restore failed", restoreErr);
    }
    await prisma?.$disconnect();
  }

  printSummary(results);
  const failed = results.some((r) => r.status !== "PASS");
  if (failed || results.length !== scenarioIds.length) {
    process.exit(1);
  }
  console.log("\nSlice 1 Preconditions Gate: ALL PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

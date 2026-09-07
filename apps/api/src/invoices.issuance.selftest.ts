/**
 * Invoice issuance persistence — 10.11 §7b I-TID.
 * Internal InvoicesService.issueForOrder only. No PDF / email / webhook.
 *
 * Requires: DATABASE_URL (+ seed CompanySettings id=default)
 * Run (after build): node --env-file="<dodo>/.env" dist/invoices.issuance.selftest.js
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { ConflictException, HttpException } from "@nestjs/common";
import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  TaxMode,
} from "@dodo/database";
import { RoleCode } from "@dodo/shared-types";
import { InvoiceError } from "./invoices/invoice.errors";
import { InvoicesService } from "./invoices/invoices.service";
import { PrismaService } from "./prisma/prisma.service";
import type { AuthUser } from "./auth/auth.types";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

const IDS = [
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
  "I6",
  "I7",
  "I8",
  "I9",
  "I10",
  "I11",
  "I12",
  "I13",
  "I14",
  "I15",
] as const;

const SELLER_7 = {
  legalName: "Issuance Test UG",
  line1: "Rechnungsweg 1",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE",
  supportEmail: "support@issue.test",
  supportPhone: "+49 30 111111",
} as const;

const BILLING = {
  name: "Buyer Name",
  line1: "Buyerstr. 9",
  line2: "EG",
  postalCode: "80331",
  city: "München",
  countryCode: "DE",
  phone: "+49 89 000",
} as const;

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function errCode(e: unknown): string | undefined {
  if (!(e instanceof HttpException)) return undefined;
  const body = e.getResponse();
  if (typeof body === "object" && body && "error" in body) {
    return String((body as { error: string }).error);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`expected object got ${typeof value}`);
}

function assertRejected(
  e: unknown,
  code: string,
): void {
  if (errCode(e) !== code) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`expected ${code} got ${errCode(e) ?? msg}`);
  }
  if (!(e instanceof ConflictException) && code !== InvoiceError.ORDER_NOT_FOUND) {
    throw new Error(`expected ConflictException for ${code}`);
  }
}

async function expectReject(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ${code}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("expected ")) throw e;
    assertRejected(e, code);
  }
}

async function main() {
  const results: Result[] = [];
  const stamp = Date.now().toString(36);
  const createdOrderIds: string[] = [];
  const createdUserIds: string[] = [];
  let prisma: PrismaService | undefined;
  let svc: InvoicesService | undefined;
  let taxBefore: {
    steuernummer: string | null;
    vatId: string | null;
    kleinunternehmerId: string | null;
    invoiceNextNumber: number;
  } | undefined;
  let paymentsBefore = 0;
  let webhookBefore = 0;

  const run = async (id: (typeof IDS)[number], fn: () => Promise<void>) => {
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

  const nextNumber = async (): Promise<number> => {
    const row = await prisma!.companySettings.findUniqueOrThrow({
      where: { id: "default" },
      select: { invoiceNextNumber: true },
    });
    return row.invoiceNextNumber;
  };

  const setTaxIds = async (data: {
    steuernummer: string | null;
    vatId: string | null;
    kleinunternehmerId: string | null;
  }) => {
    await prisma!.companySettings.update({
      where: { id: "default" },
      data,
    });
  };

  const createUser = async (): Promise<string> => {
    const user = await prisma!.user.create({
      data: {
        email: `inv_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
        passwordHash: `hash_${randomBytes(8).toString("hex")}`,
        locale: "de",
        emailVerifiedAt: new Date(),
        vatId: "DE-USER-MUST-NOT-COPY",
        companyName: "User Co MUST NOT COPY",
      },
    });
    createdUserIds.push(user.id);
    return user.id;
  };

  const createOrder = async (opts: {
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    sellerExtra?: Record<string, unknown>;
    billing?: Prisma.InputJsonValue;
  }): Promise<string> => {
    const userId = await createUser();
    const order = await prisma!.order.create({
      data: {
        orderNumber: `INV-${stamp}-${randomBytes(3).toString("hex")}`,
        userId,
        status: opts.status,
        paymentStatus: opts.paymentStatus,
        currencyCode: "EUR",
        locale: "de",
        shippingCountryCode: "DE",
        taxMode: TaxMode.KLEINUNTERNEHMER,
        companyIsKleinunternehmer: true,
        invoiceExemptionTextSnapshot: "§19 snapshot",
        itemsSubtotal: "10.00",
        shippingTotal: "0.00",
        grandTotal: "10.00",
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0.00",
        shippingAddressJson: { name: "Ship", line1: "SHIP MUST NOT COPY", postalCode: "00000", city: "Hamburg", countryCode: "DE" },
        billingAddressJson: opts.billing ?? BILLING,
        sellerIdentitySnapshotJson: { ...SELLER_7, ...(opts.sellerExtra ?? {}) },
        guestEmail: "guest-must-not-copy@test.local",
      },
    });
    createdOrderIds.push(order.id);
    return order.id;
  };

  const customerAuth = async (orderId: string): Promise<AuthUser> => {
    const order = await prisma!.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { userId: true, user: { select: { email: true, name: true, locale: true, anonymizedAt: true } } },
    });
    if (!order.userId || !order.user) throw new Error("order has no user");
    return {
      id: order.userId,
      email: order.user.email,
      name: order.user.name,
      locale: order.user.locale,
      roles: [RoleCode.CUSTOMER],
      anonymizedAt: order.user.anonymizedAt,
    };
  };

  try {
    prisma = new PrismaService();
    await prisma.$connect();
    svc = new InvoicesService(prisma);

    const settings = await prisma.companySettings.findUnique({ where: { id: "default" } });
    if (!settings) throw new Error("CompanySettings id=default missing — seed required");
    taxBefore = {
      steuernummer: settings.steuernummer,
      vatId: settings.vatId,
      kleinunternehmerId: settings.kleinunternehmerId,
      invoiceNextNumber: settings.invoiceNextNumber,
    };
    paymentsBefore = await prisma.payment.count();
    webhookBefore = await prisma.webhookEvent.count();

    await setTaxIds({
      steuernummer: "SN-ISSUE-1",
      vatId: null,
      kleinunternehmerId: null,
    });

    await run("I1", async () => {
      const before = await nextNumber();
      const orderId = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      const inv = await svc!.issueForOrder(orderId);
      const year = inv.issuedAt.getUTCFullYear();
      const expected = `RE-${year}-${String(before).padStart(6, "0")}`;
      if (inv.invoiceNumber !== expected) {
        throw new Error(`number ${inv.invoiceNumber} expected ${expected}`);
      }
      if (inv.status !== "issued") throw new Error(`status ${inv.status}`);
      if (Number(inv.grandTotalSnapshot.toString()) !== 10) {
        throw new Error(`grandTotal ${inv.grandTotalSnapshot.toString()}`);
      }
      if (inv.exemptionTextSnapshot !== "§19 snapshot") {
        throw new Error("exemptionTextSnapshot mismatch");
      }
      if ((await nextNumber()) !== before + 1) throw new Error("invoiceNextNumber not incremented");
    });

    await run("I2", async () => {
      const before = await nextNumber();
      const orderId = await createOrder({
        status: OrderStatus.PLACED,
        paymentStatus: PaymentStatus.PENDING,
      });
      await expectReject(() => svc!.issueForOrder(orderId), InvoiceError.INVOICE_NOT_ELIGIBLE);
      if ((await prisma!.invoice.count({ where: { orderId } })) !== 0) {
        throw new Error("Invoice row created for PLACED");
      }
      if ((await nextNumber()) !== before) throw new Error("number consumed for PLACED");
    });

    await run("I3", async () => {
      const before = await nextNumber();
      const orderId = await createOrder({
        status: OrderStatus.CANCELLED,
        paymentStatus: PaymentStatus.PAID,
      });
      await expectReject(() => svc!.issueForOrder(orderId), InvoiceError.ORDER_CANCELLED);
      if ((await prisma!.invoice.count({ where: { orderId } })) !== 0) {
        throw new Error("Invoice row created for CANCELLED");
      }
      if ((await nextNumber()) !== before) throw new Error("number consumed for CANCELLED");
    });

    await run("I4", async () => {
      const before = await nextNumber();
      await setTaxIds({
        steuernummer: "   ",
        vatId: null,
        kleinunternehmerId: "",
      });
      const orderId = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      await expectReject(() => svc!.issueForOrder(orderId), InvoiceError.TAX_ID_INCOMPLETE);
      if ((await prisma!.invoice.count({ where: { orderId } })) !== 0) {
        throw new Error("Invoice row created without tax IDs");
      }
      if ((await nextNumber()) !== before) throw new Error("number consumed on I-TID-5");
      await setTaxIds({
        steuernummer: "SN-ISSUE-1",
        vatId: null,
        kleinunternehmerId: null,
      });
    });

    await run("I5", async () => {
      await setTaxIds({
        steuernummer: "  SN-FROZEN  ",
        vatId: "VAT-FROZEN",
        kleinunternehmerId: null,
      });
      const orderId = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      const inv = await svc!.issueForOrder(orderId);
      const seller = asRecord(inv.sellerSnapshotJson);
      if (seller.steuernummer !== "SN-FROZEN") throw new Error(`steuernummer ${String(seller.steuernummer)}`);
      if (seller.vatId !== "VAT-FROZEN") throw new Error(`vatId ${String(seller.vatId)}`);
      if (seller.kleinunternehmerId !== null) throw new Error("kleinunternehmerId should be null");
      await setTaxIds({
        steuernummer: "SN-ISSUE-1",
        vatId: null,
        kleinunternehmerId: null,
      });
    });

    await run("I6", async () => {
      const orderId = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        sellerExtra: { extraMustNotCopy: "nope" },
      });
      const inv = await svc!.issueForOrder(orderId);
      const seller = asRecord(inv.sellerSnapshotJson);
      for (const [k, v] of Object.entries(SELLER_7)) {
        if (seller[k] !== v) throw new Error(`seller ${k} ${String(seller[k])}`);
      }
      if ("extraMustNotCopy" in seller) throw new Error("extra Order seller key copied");
      const keys = Object.keys(seller).sort();
      const expected = [
        "city",
        "countryCode",
        "kleinunternehmerId",
        "legalName",
        "line1",
        "postalCode",
        "steuernummer",
        "supportEmail",
        "supportPhone",
        "vatId",
      ];
      if (keys.join(",") !== expected.join(",")) {
        throw new Error(`seller keys ${keys.join(",")}`);
      }
    });

    await run("I7", async () => {
      const orderId = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      const order = await prisma!.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { billingAddressJson: true },
      });
      const inv = await svc!.issueForOrder(orderId);
      if (JSON.stringify(inv.buyerSnapshotJson) !== JSON.stringify(order.billingAddressJson)) {
        throw new Error(
          `buyer ${JSON.stringify(inv.buyerSnapshotJson)} vs order ${JSON.stringify(order.billingAddressJson)}`,
        );
      }
      const buyer = asRecord(inv.buyerSnapshotJson);
      if ("email" in buyer || "guestEmail" in buyer || "companyName" in buyer || "vatId" in buyer) {
        throw new Error("forbidden buyer fields present");
      }
      for (const [k, v] of Object.entries(BILLING)) {
        if (buyer[k] !== v) throw new Error(`buyer ${k} ${String(buyer[k])}`);
      }
    });

    await run("I8", async () => {
      const before = await nextNumber();
      const orderId = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      await svc!.issueForOrder(orderId);
      const afterFirst = await nextNumber();
      await expectReject(() => svc!.issueForOrder(orderId), InvoiceError.INVOICE_ALREADY_EXISTS);
      if ((await prisma!.invoice.count({ where: { orderId } })) !== 1) {
        throw new Error("second Invoice created");
      }
      if ((await nextNumber()) !== afterFirst) throw new Error("duplicate consumed a number");
      if (afterFirst !== before + 1) throw new Error("first issue should consume one number");
    });

    await run("I9", async () => {
      const orderId = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      const settled = await Promise.allSettled([
        svc!.issueForOrder(orderId),
        svc!.issueForOrder(orderId),
      ]);
      const ok = settled.filter((s) => s.status === "fulfilled");
      const bad = settled.filter((s) => s.status === "rejected");
      if (ok.length !== 1) throw new Error(`successes ${ok.length}`);
      if (bad.length !== 1) throw new Error(`rejects ${bad.length}`);
      const rejected = bad[0] as PromiseRejectedResult;
      if (errCode(rejected.reason) !== InvoiceError.INVOICE_ALREADY_EXISTS) {
        throw new Error(`concurrent reject ${errCode(rejected.reason)}`);
      }
      if ((await prisma!.invoice.count({ where: { orderId } })) !== 1) {
        throw new Error("concurrent same-order produced extra Invoice");
      }
    });

    await run("I10", async () => {
      const a = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      const b = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      const [ia, ib] = await Promise.all([svc!.issueForOrder(a), svc!.issueForOrder(b)]);
      if (ia.invoiceNumber === ib.invoiceNumber) {
        throw new Error(`duplicate numbers ${ia.invoiceNumber}`);
      }
      const nums = [ia.invoiceNumber, ib.invoiceNumber].sort();
      const n1 = Number(nums[0].slice(-6));
      const n2 = Number(nums[1].slice(-6));
      if (n2 !== n1 + 1) throw new Error(`expected consecutive got ${nums.join(",")}`);
    });

    await run("I11", async () => {
      await setTaxIds({
        steuernummer: "SN-ORIGINAL",
        vatId: "VAT-ORIGINAL",
        kleinunternehmerId: "KU-ORIGINAL",
      });
      const orderId = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      const created = await svc!.issueForOrder(orderId);
      await setTaxIds({
        steuernummer: "SN-CHANGED",
        vatId: "VAT-CHANGED",
        kleinunternehmerId: "KU-CHANGED",
      });
      const got = await svc!.getByNumber(created.invoiceNumber, await customerAuth(orderId));
      const seller = asRecord(got.sellerSnapshotJson);
      if (seller.steuernummer !== "SN-ORIGINAL") throw new Error("GET re-read live steuernummer");
      if (seller.vatId !== "VAT-ORIGINAL") throw new Error("GET re-read live vatId");
      if (seller.kleinunternehmerId !== "KU-ORIGINAL") throw new Error("GET re-read live kleinunternehmerId");
      await setTaxIds({
        steuernummer: "SN-ISSUE-1",
        vatId: null,
        kleinunternehmerId: null,
      });
    });

    await run("I12", async () => {
      const orderId = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      const inv = await svc!.issueForOrder(orderId);
      if (inv.pdfObjectKey !== null) throw new Error(`pdfObjectKey ${String(inv.pdfObjectKey)}`);
    });

    await run("I13", async () => {
      const orderId = await createOrder({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      });
      const inv = await svc!.issueForOrder(orderId);
      if (inv.pdfObjectKey !== null) throw new Error("PDF object was generated");
      const keys = Object.keys(inv);
      if (keys.some((k) => k.toLowerCase().includes("pdf") && k !== "pdfObjectKey")) {
        throw new Error(`unexpected pdf field ${keys.join(",")}`);
      }
    });

    await run("I14", async () => {
      const ctorParams = InvoicesService.length;
      if (ctorParams !== 1) throw new Error(`InvoicesService arity ${ctorParams} — email/payments injected?`);
    });

    await run("I15", async () => {
      const paymentsNow = await prisma!.payment.count();
      const webhookNow = await prisma!.webhookEvent.count();
      if (paymentsNow !== paymentsBefore) {
        throw new Error(`Payment rows changed ${paymentsBefore} → ${paymentsNow}`);
      }
      if (webhookNow !== webhookBefore) {
        throw new Error(`WebhookEvent rows changed ${webhookBefore} → ${webhookNow}`);
      }
    });
  } catch (e) {
    console.error(e);
    for (const id of IDS) {
      if (!results.some((r) => r.id === id)) {
        results.push({
          id,
          status: "FAIL",
          note: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    try {
      if (prisma) {
        for (const orderId of createdOrderIds) {
          await prisma.invoice.deleteMany({ where: { orderId } });
          await prisma.order.delete({ where: { id: orderId } }).catch(() => undefined);
        }
        for (const userId of createdUserIds) {
          await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
        }
        if (taxBefore) {
          await prisma.companySettings.update({
            where: { id: "default" },
            data: {
              steuernummer: taxBefore.steuernummer,
              vatId: taxBefore.vatId,
              kleinunternehmerId: taxBefore.kleinunternehmerId,
              invoiceNextNumber: taxBefore.invoiceNextNumber,
            },
          });
        }
      }
    } catch (restoreErr) {
      console.error("restore failed", restoreErr);
    }
    await prisma?.$disconnect();
  }

  printSummary(results);
  const failed = results.some((r) => r.status !== "PASS");
  if (failed || results.length !== IDS.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

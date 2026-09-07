import { OrderStatus, PaymentStatus, type CartRecalcResponse } from "@dodo/shared-types";

/** Step 9 self-test: shared contracts compile — does not boot Nest (needs DATABASE_URL). */
const smoke: Pick<CartRecalcResponse, "currencyCode" | "companyIsKleinunternehmer"> = {
  currencyCode: "EUR",
  companyIsKleinunternehmer: true,
};

if (OrderStatus.PLACED !== "PLACED" || PaymentStatus.PENDING !== "PENDING") {
  console.error("shared-types smoke failed");
  process.exit(1);
}

console.log("test ok @dodo/api step9", { order: OrderStatus.PLACED, smoke });

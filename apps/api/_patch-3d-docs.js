const fs = require("fs");
const p = "C:/Cursor/book/my Projekt/docs/00-paper-path.md";
let c = fs.readFileSync(p, "utf8");

const old =
  "Production placeOrder Slice 3d B1 Coupon Input: Paper Closed** (2026-09-03 · SoT `10.5` §Slice 3d B1 · `couponCode?: string` optional on recalculate · request-scoped · trim only · case-sensitive vs `Coupon.code` · absent/empty-after-trim = 3c behavior · no Cart schema · no apply prerequisite) · **Production placeOrder Slice 3d B2 Invalid Coupon Handling: Paper Closed** (2026-09-03 · SoT `10.5` §Slice 3d B2 · full recalculate reject · HTTP 400 `INVALID_COUPON` umbrella · `#7` remains 409 `STORE_COUPONS_DISABLED` · no soft-skip · no CouponUsage/Cart persist · minOrder outcome under umbrella · minOrder formula = B4 OPEN) · **Production placeOrder Slice 3d B3 FREE_SHIPPING: Paper Closed** (2026-09-03 · SoT `10.5` §Slice 3d B3 · valid FREE_SHIPPING → shippingTotal=\"0.00\" · no discountCoupon from shipping · value ignored · threshold override · in 3d Execute scope) · **Production placeOrder Slice 3d B4 FIXED/PERCENT Formula: Paper Closed** (2026-09-03 · SoT `10.5` §Slice 3d B4 · R1/R2 · PERCENT × value/100 · HALF_UP 2dp · minOrder vs pre-discount itemsSubtotal before discount · FIXED cap at itemsSubtotal · FIXED normal = value · 3d Execute / 3e–3g / F5 / placeOrder OPEN)";

const neu =
  "Production placeOrder Slice 3d Coupon Preview: Executed / Verified / Closed** (2026-09-03 · SoT `10.5` §Slice 3d · B1–B4 runtime · `couponCode?: string` · trim/case-sensitive · 400 `INVALID_COUPON` · 409 `STORE_COUPONS_DISABLED` · FREE_SHIPPING · FIXED/PERCENT HALF_UP + cap · threshold = goods-after-coupon · no CouponUsage · D1–D11 11/11 PASS · 3c/3b/3a regression PASS · typecheck/build/dist PASS · no schema · 3e–3g / F5 / placeOrder OPEN)";

if (!c.includes(old)) {
  console.error("OLD NOT FOUND");
  process.exit(1);
}
c = c.replace(old, neu);

const old3c =
  "no schema · 3d–3g / F5 / placeOrder OPEN) · **Production placeOrder Slice 3d Coupon Preview:";
const neu3c =
  "no schema · 3e–3g / F5 / placeOrder OPEN) · **Production placeOrder Slice 3d Coupon Preview:";
if (c.includes(old3c)) {
  c = c.replace(old3c, neu3c);
}

fs.writeFileSync(p, c);
console.log("OK");

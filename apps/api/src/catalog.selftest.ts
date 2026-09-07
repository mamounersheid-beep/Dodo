import {
  assertAspectRatio,
  isProductSellable,
  MAX_CATEGORY_DEPTH,
  slugify,
} from "./catalog/catalog.rules";

function main() {
  if (slugify("Hallo Welt!") !== "hallo-welt") throw new Error("slugify");
  if (MAX_CATEGORY_DEPTH !== 2) throw new Error("depth");
  if (isProductSellable(true, 0)) throw new Error("not sellable without variant");
  if (!isProductSellable(true, 1)) throw new Error("sellable with variant");
  if (isProductSellable(false, 1)) throw new Error("inactive product not sellable");
  try {
    assertAspectRatio("16:9");
    throw new Error("should reject non 4:5");
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "IMAGE_ASPECT_MUST_BE_4_5") throw e;
  }
  assertAspectRatio("4:5");
  console.log("test ok @dodo/api step10.2 catalog rules");
}

main();

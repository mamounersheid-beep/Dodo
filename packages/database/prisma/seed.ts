import { PrismaClient, RoleCode, CouponType } from "@prisma/client";

const prisma = new PrismaClient();

const EXEMPTION_TEXT =
  "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet. Es gilt die Steuerbefreiung für Kleinunternehmer.";

async function main() {
  for (const code of Object.values(RoleCode)) {
    await prisma.role.upsert({
      where: { code },
      create: { code },
      update: {},
    });
  }

  await prisma.currency.upsert({
    where: { code: "EUR" },
    create: { code: "EUR", symbol: "€", decimals: 2 },
    update: {},
  });

  const existingTax = await prisma.taxRate.findFirst({
    where: { countryCode: "DE", category: "standard" },
  });
  if (!existingTax) {
    await prisma.taxRate.createMany({
      data: [
        {
          countryCode: "DE",
          category: "standard",
          ratePercent: 19,
          validFrom: new Date("2021-01-01"),
          invoiceLabel: "MwSt. 19%",
          ossRelevant: true,
        },
        {
          countryCode: "DE",
          category: "reduced",
          ratePercent: 7,
          validFrom: new Date("2021-01-01"),
          invoiceLabel: "MwSt. 7%",
          ossRelevant: true,
        },
      ],
    });
  }

  let zone = await prisma.shippingZone.findFirst({ where: { countryCode: "DE" } });
  if (!zone) {
    zone = await prisma.shippingZone.create({
      data: { countryCode: "DE", name: "Deutschland" },
    });
  }

  const method = await prisma.shippingMethod.upsert({
    where: { code: "standard" },
    create: { code: "standard", name: "Standardversand", isActive: true },
    update: {},
  });

  const rateExists = await prisma.shippingRate.findFirst({
    where: { zoneId: zone.id, methodId: method.id },
  });
  if (!rateExists) {
    await prisma.shippingRate.create({
      data: {
        zoneId: zone.id,
        methodId: method.id,
        price: 4.9,
        estimatedTransitDaysMin: 2,
        estimatedTransitDaysMax: 4,
        validFrom: new Date("2020-01-01"),
      },
    });
  } else {
    await prisma.shippingRate.update({
      where: { id: rateExists.id },
      data: {
        price: 4.9,
        estimatedTransitDaysMin: 2,
        estimatedTransitDaysMax: 4,
      },
    });
  }

  await prisma.freeShippingThreshold.deleteMany({ where: { countryCode: "DE" } });
  await prisma.freeShippingThreshold.create({
    data: { countryCode: "DE", minOrderAmount: 70, currencyCode: "EUR" },
  });

  const location = await prisma.location.upsert({
    where: { code: "MAIN" },
    create: { code: "MAIN", name: "Hauptlager", isActive: true },
    update: { isActive: true },
  });

  const settings = await prisma.companySettings.findUnique({ where: { id: "default" } });
  /** #7 contractual defaults only — never invent Owner-required #3/#8/#9 values. #15 processing 1/3 = F5 Owner policy. */
  const operationalFlagDefaults = {
    maintenanceMode: false,
    maintenanceNoticeLocale: "de",
    checkoutEnabled: true,
    paymentsEnabled: { stripe: true, paypal: true },
    couponsEnabled: true,
    bonusPlusEnabled: true,
  } as const;

  if (!settings) {
    await prisma.companySettings.create({
      data: {
        id: "default",
        legalName: "Dodo Beispiel UG (haftungsbeschränkt)",
        line1: "Musterstraße 1",
        postalCode: "10115",
        city: "Berlin",
        countryCode: "DE",
        isKleinunternehmer: true,
        kleinunternehmerSince: new Date(),
        invoiceExemptionText: EXEMPTION_TEXT,
        defaultCurrencyCode: "EUR",
        defaultLocale: "de",
        supportPhone: "+49 30 000000",
        supportEmail: "support@example.com",
        invoiceNextNumber: 1,
        orderNextNumber: 1,
        orderProcessingDaysMin: 1,
        orderProcessingDaysMax: 3,
        ...operationalFlagDefaults,
        operationalFlagsUpdatedAt: new Date(),
      },
    });
  } else {
    await prisma.companySettings.update({
      where: { id: "default" },
      data: {
        defaultLocale: "de",
        orderProcessingDaysMin: 1,
        orderProcessingDaysMax: 3,
        ...operationalFlagDefaults,
        ...(settings.operationalFlagsUpdatedAt == null
          ? { operationalFlagsUpdatedAt: new Date() }
          : {}),
      },
    });
  }

  const legalSlugs = [
    ["impressum", "Impressum"],
    ["datenschutz", "Datenschutz"],
    ["agb", "AGB"],
    ["widerruf", "Widerrufsbelehrung"],
    ["versand", "Versand"],
    ["kontakt", "Kontakt"],
  ] as const;

  for (const [slug, title] of legalSlugs) {
    await prisma.legalPage.upsert({
      where: {
        slug_countryCode_version: { slug, countryCode: "DE", version: "v1" },
      },
      create: {
        slug,
        countryCode: "DE",
        version: "v1",
        title,
        body: `${title} — Platzhalter. Vor Produktion von Anwalt prüfen.`,
        publishedAt: new Date(),
      },
      update: {},
    });
  }

  const bonusRules = await prisma.bonusRules.findFirst();
  if (!bonusRules) {
    await prisma.bonusRules.create({
      data: {
        enabled: true,
        earnPointsPerEuro: 1,
        redeemPointsPerEuro: 100,
        maxRedeemPercentOfItems: 50,
        expiryMonths: 24,
      },
    });
  }

  for (const [code, provider, sortOrder] of [
    ["stripe_card", "stripe", 1],
    ["paypal", "paypal", 2],
    ["apple_pay", "stripe", 3],
    ["google_pay", "stripe", 4],
  ] as const) {
    await prisma.paymentMethod.upsert({
      where: { code },
      create: { code, provider, isEnabled: true, sortOrder },
      update: { isEnabled: true },
    });
  }

  // Gutschein sample (paper scenario SAVE5)
  await prisma.coupon.upsert({
    where: { code: "SAVE5" },
    create: {
      code: "SAVE5",
      type: CouponType.FIXED,
      value: 5,
      validFrom: new Date("2020-01-01"),
      isActive: true,
    },
    update: { isActive: true, value: 5, type: CouponType.FIXED },
  });

  // Paper catalog SKU-TEE-M
  let category = await prisma.category.findUnique({ where: { slug: "tees" } });
  if (!category) {
    category = await prisma.category.create({
      data: {
        slug: "tees",
        name: "T-Shirts",
        path: "/tees",
        depth: 0,
        sortOrder: 0,
      },
    });
  }

  let product = await prisma.product.findUnique({ where: { slug: "classic-tee" } });
  if (!product) {
    product = await prisma.product.create({
      data: {
        categoryId: category.id,
        slug: "classic-tee",
        name: "Klassisches T-Shirt",
        description: "Beispielprodukt für Papiertest.",
        isActive: true,
        translations: {
          create: [
            {
              locale: "de",
              name: "Klassisches T-Shirt",
              description: "Beispielprodukt für Papiertest.",
            },
            {
              locale: "en",
              name: "Classic T-Shirt",
              description: "Sample product for the paper test.",
            },
            {
              locale: "ar",
              name: "تيشيرت كلاسيك",
              description: "منتج تجريبي لاختبار الورق.",
            },
          ],
        },
      },
    });
  }

  const variant = await prisma.productVariant.upsert({
    where: { sku: "SKU-TEE-M" },
    create: {
      productId: product.id,
      sku: "SKU-TEE-M",
      name: "M",
      price: 29.9,
      weightGrams: 200,
      isActive: true,
    },
    update: { price: 29.9, weightGrams: 200, isActive: true },
  });

  await prisma.inventory.upsert({
    where: {
      locationId_variantId: { locationId: location.id, variantId: variant.id },
    },
    create: {
      locationId: location.id,
      variantId: variant.id,
      quantityOnHand: 3,
    },
    update: { quantityOnHand: 3 },
  });

  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { code: "OWNER" } });
  const ownerEmail = "owner@example.com";
  const owner = await prisma.user.upsert({
    where: { email: ownerEmail },
    create: {
      email: ownerEmail,
      name: "Owner",
      locale: "de",
      passwordHash: "CHANGE_ME_ARGON2_ON_FIRST_BOOT",
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: ownerRole.id } },
    },
    update: { locale: "de" },
  });

  await prisma.bonusAccount.upsert({
    where: { userId: owner.id },
    create: { userId: owner.id, balanceCached: 0 },
    update: {},
  });

  /** Homepage Sections V1 B′ — fixed system keys only (11 §1b / 12 §12.4a). */
  const homeSectionDefaults = [
    {
      key: "new_arrivals",
      type: "rule",
      sortOrder: 0,
      names: {
        de: "Neu eingetroffen",
        en: "New arrivals",
        ar: "وصل حديثاً",
      },
    },
    {
      key: "store_picks",
      type: "manual",
      sortOrder: 1,
      names: {
        de: "Unsere Auswahl",
        en: "Store picks",
        ar: "مختارات المتجر",
      },
    },
  ] as const;

  for (const def of homeSectionDefaults) {
    const existing = await prisma.homeSection.findUnique({ where: { key: def.key } });
    if (!existing) {
      await prisma.homeSection.create({
        data: {
          key: def.key,
          type: def.type,
          enabled: true,
          sortOrder: def.sortOrder,
          itemLimit: 8,
          translations: {
            create: [
              { locale: "de", name: def.names.de },
              { locale: "en", name: def.names.en },
              { locale: "ar", name: def.names.ar },
            ],
          },
        },
      });
    } else {
      for (const locale of ["de", "en", "ar"] as const) {
        await prisma.homeSectionTranslation.upsert({
          where: {
            sectionId_locale: { sectionId: existing.id, locale },
          },
          create: {
            sectionId: existing.id,
            locale,
            name: def.names[locale],
          },
          update: {},
        });
      }
    }
  }

  console.log(
    "Seed OK: KU, DE tax/shipping, free ship 70, SAVE5, SKU-TEE-M×3, ProductTranslation de/en/ar, Homepage Sections, owner@example.com",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

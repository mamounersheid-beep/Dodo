-- Homepage Sections V1 B′ — Paper Promoted 2026-09-06
-- SoT: docs/11 §1b · docs/12 §12.4a · DATABASE_ERD §10
-- HomeSection + HomeSectionTranslation + HomeSectionProduct only

CREATE TABLE "HomeSection" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "itemLimit" INTEGER NOT NULL DEFAULT 8,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeSection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HomeSection_key_key" ON "HomeSection"("key");

CREATE TABLE "HomeSectionTranslation" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "HomeSectionTranslation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HomeSectionTranslation_locale_idx" ON "HomeSectionTranslation"("locale");

CREATE UNIQUE INDEX "HomeSectionTranslation_sectionId_locale_key"
  ON "HomeSectionTranslation"("sectionId", "locale");

CREATE TABLE "HomeSectionProduct" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "HomeSectionProduct_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HomeSectionProduct_sectionId_sortOrder_idx"
  ON "HomeSectionProduct"("sectionId", "sortOrder");

CREATE UNIQUE INDEX "HomeSectionProduct_sectionId_productId_key"
  ON "HomeSectionProduct"("sectionId", "productId");

ALTER TABLE "HomeSectionTranslation"
  ADD CONSTRAINT "HomeSectionTranslation_sectionId_fkey"
  FOREIGN KEY ("sectionId") REFERENCES "HomeSection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HomeSectionProduct"
  ADD CONSTRAINT "HomeSectionProduct_sectionId_fkey"
  FOREIGN KEY ("sectionId") REFERENCES "HomeSection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HomeSectionProduct"
  ADD CONSTRAINT "HomeSectionProduct_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

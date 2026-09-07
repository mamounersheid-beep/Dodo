-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "gpsrCatalogTier" "GpsrCatalogTier" NOT NULL DEFAULT 'standard',
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "requiresGrundpreis" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "euResponsiblePersonAddressLine1" TEXT,
ADD COLUMN     "euResponsiblePersonAddressLine2" TEXT,
ADD COLUMN     "euResponsiblePersonCity" TEXT,
ADD COLUMN     "euResponsiblePersonCountryCode" TEXT,
ADD COLUMN     "euResponsiblePersonDisplayName" TEXT,
ADD COLUMN     "euResponsiblePersonEmail" TEXT,
ADD COLUMN     "euResponsiblePersonPostalCode" TEXT,
ADD COLUMN     "grundpreisRequirement" "GrundpreisRequirement" NOT NULL DEFAULT 'inherit',
ADD COLUMN     "manufacturerAddressLine1" TEXT,
ADD COLUMN     "manufacturerAddressLine2" TEXT,
ADD COLUMN     "manufacturerCity" TEXT,
ADD COLUMN     "manufacturerCountryCode" TEXT,
ADD COLUMN     "manufacturerDisplayName" TEXT,
ADD COLUMN     "manufacturerEmail" TEXT,
ADD COLUMN     "manufacturerEstablishedInUnion" BOOLEAN,
ADD COLUMN     "manufacturerPostalCode" TEXT,
ADD COLUMN     "manufacturerSource" "ManufacturerSource" NOT NULL DEFAULT 'store_default',
ADD COLUMN     "safetyInformationRequired" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ProductTranslation" ADD COLUMN     "safetyInformationMarkdown" TEXT;

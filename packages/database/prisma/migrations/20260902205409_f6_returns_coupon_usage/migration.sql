/*
  Warnings:

  - Added the required column `shippingMethodCodeSnapshot` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `shippingStandardAmountSnapshot` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `orderPriorStatus` to the `ReturnRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `returnAddressSnapshotJson` to the `ReturnRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `returnInstructionsSnapshot` to the `ReturnRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `returnLocale` to the `ReturnRequest` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `status` on the `ReturnRequest` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "ReturnRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'RECEIVED', 'CLOSED', 'REJECTED');

-- AlterTable
ALTER TABLE "CouponUsage" ADD COLUMN     "releasedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "shippingMethodCodeSnapshot" TEXT NOT NULL,
ADD COLUMN     "shippingRateId" TEXT,
ADD COLUMN     "shippingRateNameSnapshot" TEXT,
ADD COLUMN     "shippingStandardAmountSnapshot" DECIMAL(12,2) NOT NULL,
ADD COLUMN     "shippingZoneId" TEXT;

-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "estimatedItemsRefund" DECIMAL(12,2),
ADD COLUMN     "estimatedOriginalShippingRefund" DECIMAL(12,2),
ADD COLUMN     "estimatedRefundTotal" DECIMAL(12,2),
ADD COLUMN     "estimatedReturnShippingCost" DECIMAL(12,2),
ADD COLUMN     "internalNote" TEXT,
ADD COLUMN     "orderPriorStatus" "OrderStatus" NOT NULL,
ADD COLUMN     "rejectionReasonCode" TEXT,
ADD COLUMN     "rejectionReasonCustomer" TEXT,
ADD COLUMN     "returnAddressSnapshotJson" JSONB NOT NULL,
ADD COLUMN     "returnInstructionsSnapshot" TEXT NOT NULL,
ADD COLUMN     "returnLocale" TEXT NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "ReturnRequestStatus" NOT NULL;

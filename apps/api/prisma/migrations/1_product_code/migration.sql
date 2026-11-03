-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Product_companyId_code_key" ON "Product"("companyId", "code");


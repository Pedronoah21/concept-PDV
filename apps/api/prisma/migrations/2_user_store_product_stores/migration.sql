-- AlterTable
ALTER TABLE "User" ADD COLUMN     "registerId" TEXT,
ADD COLUMN     "storeId" TEXT;

-- CreateTable
CREATE TABLE "ProductStore" (
    "productId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,

    CONSTRAINT "ProductStore_pkey" PRIMARY KEY ("productId","storeId")
);

-- CreateIndex
CREATE INDEX "ProductStore_storeId_idx" ON "ProductStore"("storeId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStore" ADD CONSTRAINT "ProductStore_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStore" ADD CONSTRAINT "ProductStore_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


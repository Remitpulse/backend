-- CreateIndex
CREATE INDEX "remittance_transactions_status_updated_at_idx" ON "remittance_transactions"("status", "updated_at");
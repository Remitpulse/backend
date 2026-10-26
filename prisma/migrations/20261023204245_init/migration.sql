-- CreateEnum
CREATE TYPE "challenge_purpose" AS ENUM ('registration', 'authentication');

-- CreateEnum
CREATE TYPE "session_key_status" AS ENUM ('pending', 'active', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "invocation_kind" AS ENUM ('wallet_deploy', 'contract_call', 'session_key_register', 'session_key_revoke', 'payment');

-- CreateEnum
CREATE TYPE "invocation_status" AS ENUM ('awaiting_signature', 'submitted', 'succeeded', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "sponsorship_status" AS ENUM ('submitted', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "remittance_kind" AS ENUM ('deposit', 'withdrawal');

-- CreateEnum
CREATE TYPE "remittance_status" AS ENUM ('incomplete', 'pending_user_transfer', 'pending_anchor', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "remittance_event_source" AS ENUM ('initiation', 'webhook', 'poll');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "contract_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passkeys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "credential_public_key" BYTEA NOT NULL,
    "hex_public_key" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT,
    "device_type" TEXT NOT NULL,
    "backed_up" BOOLEAN NOT NULL,
    "label" TEXT,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webauthn_challenges" (
    "id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "purpose" "challenge_purpose" NOT NULL,
    "challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "public_key" TEXT NOT NULL,
    "token_contract" TEXT NOT NULL,
    "per_tx_limit" DECIMAL(39,0) NOT NULL,
    "total_limit" DECIMAL(39,0) NOT NULL,
    "spent" DECIMAL(39,0) NOT NULL DEFAULT 0,
    "expires_at_ledger" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" "session_key_status" NOT NULL DEFAULT 'pending',
    "register_tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_invocations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "invocation_kind" NOT NULL,
    "contract_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "tx_xdr" TEXT NOT NULL,
    "auth_entry_xdr" TEXT,
    "valid_until_ledger" INTEGER,
    "auth_payload" TEXT,
    "signer" TEXT NOT NULL,
    "session_key_id" UUID,
    "metadata" JSONB,
    "status" "invocation_status" NOT NULL DEFAULT 'awaiting_signature',
    "tx_hash" TEXT,
    "error" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsored_transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "inner_hash" TEXT NOT NULL,
    "fee_bump_hash" TEXT NOT NULL,
    "max_fee" BIGINT NOT NULL,
    "fee_charged" BIGINT,
    "contract_id" TEXT,
    "method" TEXT,
    "status" "sponsorship_status" NOT NULL DEFAULT 'submitted',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sponsored_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corridors" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "asset_code" TEXT NOT NULL,
    "asset_issuer" TEXT NOT NULL,
    "fiat_currency" TEXT NOT NULL,
    "anchor_domain" TEXT NOT NULL,
    "markup_bps" INTEGER NOT NULL DEFAULT 0,
    "fixed_fee" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "min_amount" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "max_amount" DECIMAL(20,7),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "corridors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anchor_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "corridor_id" UUID NOT NULL,
    "account" TEXT NOT NULL,
    "encrypted_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anchor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remittance_transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "corridor_id" UUID NOT NULL,
    "kind" "remittance_kind" NOT NULL,
    "account" TEXT NOT NULL,
    "anchor_tx_id" TEXT NOT NULL,
    "status" "remittance_status" NOT NULL DEFAULT 'incomplete',
    "anchor_status" TEXT NOT NULL,
    "amount_in" DECIMAL(20,7),
    "amount_out" DECIMAL(20,7),
    "amount_fee" DECIMAL(20,7),
    "platform_fee" DECIMAL(20,7),
    "quoted_rate" DECIMAL(30,12),
    "interactive_url" TEXT,
    "more_info_url" TEXT,
    "stellar_transaction_id" TEXT,
    "withdraw_anchor_account" TEXT,
    "withdraw_memo" TEXT,
    "withdraw_memo_type" TEXT,
    "status_message" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remittance_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remittance_events" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "source" "remittance_event_source" NOT NULL,
    "from_status" "remittance_status",
    "to_status" "remittance_status" NOT NULL,
    "anchor_status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remittance_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_contract_address_key" ON "users"("contract_address");

-- CreateIndex
CREATE UNIQUE INDEX "passkeys_credential_id_key" ON "passkeys"("credential_id");

-- CreateIndex
CREATE INDEX "passkeys_user_id_idx" ON "passkeys"("user_id");

-- CreateIndex
CREATE INDEX "webauthn_challenges_subject_purpose_idx" ON "webauthn_challenges"("subject", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "session_keys_public_key_key" ON "session_keys"("public_key");

-- CreateIndex
CREATE INDEX "session_keys_user_id_status_idx" ON "session_keys"("user_id", "status");

-- CreateIndex
CREATE INDEX "pending_invocations_user_id_status_idx" ON "pending_invocations"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sponsored_transactions_inner_hash_key" ON "sponsored_transactions"("inner_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sponsored_transactions_fee_bump_hash_key" ON "sponsored_transactions"("fee_bump_hash");

-- CreateIndex
CREATE INDEX "sponsored_transactions_user_id_created_at_idx" ON "sponsored_transactions"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "corridors_code_key" ON "corridors"("code");

-- CreateIndex
CREATE UNIQUE INDEX "anchor_sessions_user_id_corridor_id_account_key" ON "anchor_sessions"("user_id", "corridor_id", "account");

-- CreateIndex
CREATE INDEX "remittance_transactions_user_id_created_at_idx" ON "remittance_transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "remittance_transactions_status_idx" ON "remittance_transactions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "remittance_transactions_corridor_id_anchor_tx_id_key" ON "remittance_transactions"("corridor_id", "anchor_tx_id");

-- CreateIndex
CREATE INDEX "remittance_events_transaction_id_created_at_idx" ON "remittance_events"("transaction_id", "created_at");

-- AddForeignKey
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_keys" ADD CONSTRAINT "session_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_invocations" ADD CONSTRAINT "pending_invocations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsored_transactions" ADD CONSTRAINT "sponsored_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchor_sessions" ADD CONSTRAINT "anchor_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchor_sessions" ADD CONSTRAINT "anchor_sessions_corridor_id_fkey" FOREIGN KEY ("corridor_id") REFERENCES "corridors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittance_transactions" ADD CONSTRAINT "remittance_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittance_transactions" ADD CONSTRAINT "remittance_transactions_corridor_id_fkey" FOREIGN KEY ("corridor_id") REFERENCES "corridors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittance_events" ADD CONSTRAINT "remittance_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "remittance_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "remittance_transactions_status_updated_at_idx" ON "remittance_transactions"("status", "updated_at");

-- Session 4 — inbox completion + Meta upgrades.
-- Adds: whatsapp_threads, whatsapp_thread_tags, whatsapp_notes,
-- canned_responses, whatsapp_templates. Extends whatsapp_messages with
-- thread_id + media_asset_id.

CREATE TYPE "WhatsAppThreadStatus" AS ENUM ('open', 'pending', 'resolved', 'escalated');

CREATE TABLE "whatsapp_threads" (
    "id"                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"        UUID NOT NULL,
    "customer_phone"         TEXT NOT NULL,
    "customer_name"          TEXT,
    "status"                 "WhatsAppThreadStatus" NOT NULL DEFAULT 'open',
    "assigned_to_user_id"    UUID,
    "last_message_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_preview"   TEXT,
    "inbound_count"          INT NOT NULL DEFAULT 0,
    "outbound_count"         INT NOT NULL DEFAULT 0,
    "search_text"            TEXT NOT NULL DEFAULT '',
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_threads_org_fk"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "whatsapp_threads_assignee_fk"
        FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "whatsapp_threads_org_phone_uniq"
    ON "whatsapp_threads" ("organization_id", "customer_phone");

CREATE INDEX "whatsapp_threads_org_last_idx"
    ON "whatsapp_threads" ("organization_id", "last_message_at" DESC);

CREATE INDEX "whatsapp_threads_org_status_last_idx"
    ON "whatsapp_threads" ("organization_id", "status", "last_message_at" DESC);

-- pg_trgm full-text search on the thread's rolling search_text. Used by
-- the inbox search bar.
CREATE INDEX "whatsapp_threads_search_trgm_idx"
    ON "whatsapp_threads" USING gin ("search_text" gin_trgm_ops);

CREATE TABLE "whatsapp_thread_tags" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"  UUID NOT NULL,
    "thread_id"        UUID NOT NULL,
    "tag"              TEXT NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_thread_tags_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "whatsapp_threads"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "whatsapp_thread_tags_thread_tag_uniq"
    ON "whatsapp_thread_tags" ("thread_id", "tag");
CREATE INDEX "whatsapp_thread_tags_org_tag_idx"
    ON "whatsapp_thread_tags" ("organization_id", "tag");

CREATE TABLE "whatsapp_notes" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"  UUID NOT NULL,
    "thread_id"        UUID NOT NULL,
    "author_user_id"   UUID,
    "body"             TEXT NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_notes_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "whatsapp_threads"("id") ON DELETE CASCADE
);

CREATE INDEX "whatsapp_notes_thread_created_idx"
    ON "whatsapp_notes" ("thread_id", "created_at" ASC);

CREATE TABLE "canned_responses" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"  UUID NOT NULL,
    "shortcut"         TEXT NOT NULL,
    "body"             TEXT NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "canned_responses_org_shortcut_uniq"
    ON "canned_responses" ("organization_id", "shortcut");
CREATE INDEX "canned_responses_org_idx"
    ON "canned_responses" ("organization_id");

CREATE TABLE "whatsapp_templates" (
    "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"    UUID NOT NULL,
    "name"               TEXT NOT NULL,
    "language"           TEXT NOT NULL DEFAULT 'en_US',
    "category"           TEXT NOT NULL,
    "body_text"          TEXT NOT NULL,
    "status"             TEXT NOT NULL DEFAULT 'draft',
    "rejection_reason"   TEXT,
    "meta_template_id"   TEXT,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "whatsapp_templates_org_name_lang_uniq"
    ON "whatsapp_templates" ("organization_id", "name", "language");
CREATE INDEX "whatsapp_templates_org_idx"
    ON "whatsapp_templates" ("organization_id");

-- Extend whatsapp_messages with thread + media linkage.
ALTER TABLE "whatsapp_messages"
    ADD COLUMN IF NOT EXISTS "thread_id" UUID,
    ADD COLUMN IF NOT EXISTS "media_asset_id" UUID;

ALTER TABLE "whatsapp_messages"
    ADD CONSTRAINT "whatsapp_messages_thread_fk"
        FOREIGN KEY ("thread_id") REFERENCES "whatsapp_threads"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "whatsapp_messages_thread_received_idx"
    ON "whatsapp_messages" ("thread_id", "received_at" ASC);

-- Backfill: every existing message becomes its own thread row (one per
-- distinct customer phone within an org). Cheap because today the volume
-- is tiny — this would be batched in a real migration.
INSERT INTO "whatsapp_threads" (
    "id", "organization_id", "customer_phone", "status",
    "last_message_at", "last_message_preview",
    "inbound_count", "outbound_count", "search_text", "created_at", "updated_at"
)
SELECT
    gen_random_uuid(),
    m.organization_id,
    COALESCE(m.from_number, m.to_number) AS phone,
    'open',
    MAX(m.received_at),
    -- Last body across all messages with the customer.
    (
      SELECT m2.body FROM "whatsapp_messages" m2
      WHERE m2.organization_id = m.organization_id
        AND COALESCE(m2.from_number, m2.to_number) = COALESCE(m.from_number, m.to_number)
      ORDER BY m2.received_at DESC LIMIT 1
    ),
    SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END),
    SUM(CASE WHEN m.direction = 'outbound' THEN 1 ELSE 0 END),
    COALESCE(STRING_AGG(m.body, ' ' ORDER BY m.received_at DESC), ''),
    MIN(m.received_at),
    MAX(m.received_at)
FROM "whatsapp_messages" m
WHERE COALESCE(m.from_number, m.to_number) IS NOT NULL
GROUP BY m.organization_id, COALESCE(m.from_number, m.to_number)
ON CONFLICT ("organization_id", "customer_phone") DO NOTHING;

-- Wire each existing message to its newly-created thread.
UPDATE "whatsapp_messages" msg
SET "thread_id" = t.id
FROM "whatsapp_threads" t
WHERE t.organization_id = msg.organization_id
  AND t.customer_phone = COALESCE(msg.from_number, msg.to_number)
  AND msg.thread_id IS NULL;

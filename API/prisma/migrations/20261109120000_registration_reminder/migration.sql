SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- HUGO-2424: one reminder per unconfirmed registration. All nullable: rows created before this
-- migration have no locale (sent as English) and no theme (sent in the default theme).
ALTER TABLE "pending_registrations"
  ADD COLUMN "locale" TEXT,
  ADD COLUMN "email_theme" JSONB,
  ADD COLUMN "reminder_sent_at" TIMESTAMP(3),
  ADD COLUMN "reminder_link_hash" TEXT;
CREATE UNIQUE INDEX "pending_registrations_reminder_link_hash_key" ON "pending_registrations" ("reminder_link_hash");

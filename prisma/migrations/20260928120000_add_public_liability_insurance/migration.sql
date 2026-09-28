-- Public liability / activity insurance as a first-class document type so the
-- supplier dashboard and admin review panel can track it per application, the
-- same way every other licence is tracked. The value is appended (Postgres
-- enums cannot be removed), and existing rows are unaffected.

ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'PUBLIC_LIABILITY_INSURANCE';
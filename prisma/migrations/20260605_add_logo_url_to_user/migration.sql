-- Add logoUrl column to User table for company logo uploads
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'User' AND column_name = 'logoUrl'
  ) THEN
    ALTER TABLE "User" ADD COLUMN "logoUrl" TEXT;
  END IF;
END $$;

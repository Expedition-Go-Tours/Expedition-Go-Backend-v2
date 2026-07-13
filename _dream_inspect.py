import sqlite3, json, datetime

db = sqlite3.connect('C:\\Users\\itope\\.local\\share\\mimocode\\mimocode.db')
cur = db.cursor()

# === K6 SESSION ===
print("=== K6 SESSION (ses_0ba03366dffe9mWGeD9dh0sp3r) ===")
cur.execute("SELECT id, title, time_created FROM session WHERE id = 'ses_0ba03366dffe9mWGeD9dh0sp3r'")
r = cur.fetchone()
dt = datetime.datetime.fromtimestamp(r[2]/1000)
print(f"  Title: {r[1]}")
print(f"  Time: {dt.strftime('%Y-%m-%d %H:%M')}")

cur.execute("SELECT COUNT(*) FROM message WHERE session_id = 'ses_0ba03366dffe9mWGeD9dh0sp3r'")
print(f"  Messages: {cur.fetchone()[0]}")

# Get user messages
cur.execute("""
    SELECT m.id, json_extract(m.data, '$.role') as role,
    (SELECT GROUP_CONCAT(json_extract(p.data, '$.text'), ' ') 
     FROM part p WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'text')
    FROM message m WHERE m.session_id = 'ses_0ba03366dffe9mWGeD9dh0sp3r'
    AND json_extract(m.data, '$.role') = 'user'
""")
print("\n  User messages:")
for row in cur.fetchall():
    text = str(row[2])[:400] if row[2] else "(empty)"
    print(f"    [{row[0]}] {text}")

# Get assistant text summaries
cur.execute("""
    SELECT m.id,
    (SELECT GROUP_CONCAT(json_extract(p.data, '$.text'), ' ')
     FROM part p WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'text')
    FROM message m WHERE m.session_id = 'ses_0ba03366dffe9mWGeD9dh0sp3r'
    AND json_extract(m.data, '$.role') = 'assistant'
""")
print("\n  Assistant text:")
for row in cur.fetchall():
    text = str(row[1])[:500] if row[1] else "(empty)"
    print(f"    [{row[0]}] {text}")

# === CI FIX SESSION - Files modified ===
print("\n\n=== CI FIX SESSION (ses_0c7cd2f96ffe8Or122Veu8kiop) - Files Modified ===")
cur.execute("""
    SELECT m.id,
    json_extract(p.data, '$.tool') as tool,
    json_extract(p.data, '$.state.input') as input_data
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE m.session_id = 'ses_0c7cd2f96ffe8Or122Veu8kiop'
    AND json_extract(m.data, '$.role') = 'assistant'
    AND json_extract(p.data, '$.type') = 'tool'
    AND json_extract(p.data, '$.tool') IN ('write', 'edit')
""")
print("  Files modified:")
for row in cur.fetchall():
    inp = json.loads(row[2]) if row[2] else {}
    fp = inp.get('file_path', inp.get('path', 'unknown'))
    print(f"    {row[1]}: {fp}")

# === CANCELLATION SESSION - Files modified ===
print("\n\n=== CANCELLATION SESSION (ses_0dda58c03ffeNftPogFCEjA1AA) - Files Modified ===")
cur.execute("""
    SELECT m.id,
    json_extract(p.data, '$.tool') as tool,
    json_extract(p.data, '$.state.input') as input_data
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE m.session_id = 'ses_0dda58c03ffeNftPogFCEjA1AA'
    AND json_extract(m.data, '$.role') = 'assistant'
    AND json_extract(p.data, '$.type') = 'tool'
    AND json_extract(p.data, '$.tool') IN ('write', 'edit')
""")
print("  Files modified:")
for row in cur.fetchall():
    inp = json.loads(row[2]) if row[2] else {}
    fp = inp.get('file_path', inp.get('path', 'unknown'))
    print(f"    {row[1]}: {fp}")

# === Check for user decisions/rules since 2026-07-02 ===
print("\n\n=== USER STATEMENTS WITH KEYWORDS (since 2026-07-02) ===")
cur.execute("""
    SELECT m.id, m.session_id, m.time_created,
    (SELECT GROUP_CONCAT(json_extract(p.data, '$.text'), ' ')
     FROM part p WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'text')
    FROM message m
    WHERE m.project_id = '478f135a-8ff6-4d24-8370-a98dac42ecbe'
    AND json_extract(m.data, '$.role') = 'user'
    AND m.time_created > 1782950400000
""")
for row in cur.fetchall():
    text = str(row[3])[:500] if row[3] else "(empty)"
    lower = text.lower()
    if any(kw in lower for kw in ['always', 'never', 'remember', 'rule', 'decision', 'decided', 'must', 'should', 'want']):
        dt2 = datetime.datetime.fromtimestamp(row[2]/1000)
        sid = row[1][:20] if row[1] else "unknown"
        print(f"  [{dt2.strftime('%Y-%m-%d %H:%M')}] {sid}: {text[:300]}")

db.close()

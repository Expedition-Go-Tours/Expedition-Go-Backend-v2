import sqlite3, json, datetime

db = sqlite3.connect('C:\\Users\\itope\\.local\\share\\mimocode\\mimocode.db')
cur = db.cursor()

# Get user statements from recent sessions (joined via session)
cur.execute("""
    SELECT m.id, m.session_id, m.time_created, s.title,
    (SELECT GROUP_CONCAT(json_extract(p.data, '$.text'), ' ')
     FROM part p WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'text')
    FROM message m
    JOIN session s ON s.id = m.session_id
    WHERE s.project_id = '478f135a-8ff6-4d24-8370-a98dac42ecbe'
    AND json_extract(m.data, '$.role') = 'user'
    AND m.time_created > 1782950400000
""")
print("=== ALL USER MESSAGES (since 2026-07-02) ===")
for row in cur.fetchall():
    text = str(row[4])[:400] if row[4] else "(empty)"
    dt = datetime.datetime.fromtimestamp(row[2]/1000)
    stitle = str(row[3])[:40]
    print(f"\n  [{dt.strftime('%Y-%m-%d %H:%M')}] {stitle}")
    print(f"    {text}")

db.close()

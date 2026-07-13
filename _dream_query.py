import sqlite3, datetime

db = sqlite3.connect('C:\\Users\\itope\\.local\\share\\mimocode\\mimocode.db')
cur = db.cursor()

# List non-writer sessions for this project, most recent first
cur.execute("""
    SELECT id, title, time_created 
    FROM session 
    WHERE project_id = '478f135a-8ff6-4d24-8370-a98dac42ecbe' 
    AND title NOT LIKE 'checkpoint-writer:%'
    ORDER BY time_created DESC LIMIT 20
""")
rows = cur.fetchall()
print("=== RECENT SESSIONS (non-writer) ===")
for r in rows:
    dt = datetime.datetime.fromtimestamp(r[2]/1000)
    print(f"  {r[0]}  {dt.strftime('%Y-%m-%d %H:%M')}  {r[1][:80]}")

# Check last 7 days: 2026-07-02 to 2026-07-09
seven_days_ago = int((datetime.datetime(2026, 7, 2, 0, 0, 0).timestamp()) * 1000)
print(f"\n=== SESSIONS SINCE 2026-07-02 (epoch ms > {seven_days_ago}) ===")
cur.execute("""
    SELECT id, title, time_created 
    FROM session 
    WHERE project_id = '478f135a-8ff6-4d24-8370-a98dac42ecbe' 
    AND time_created > ?
    ORDER BY time_created DESC
""", (seven_days_ago,))
rows2 = cur.fetchall()
for r in rows2:
    dt = datetime.datetime.fromtimestamp(r[2]/1000)
    print(f"  {r[0]}  {dt.strftime('%Y-%m-%d %H:%M')}  {r[1][:100]}")

db.close()

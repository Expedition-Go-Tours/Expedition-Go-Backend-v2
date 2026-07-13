import sqlite3, json, datetime

db = sqlite3.connect('C:\\Users\\itope\\.local\\share\\mimocode\\mimocode.db')
cur = db.cursor()

# Check message table schema
cur.execute("PRAGMA table_info(message)")
print("=== MESSAGE TABLE SCHEMA ===")
for col in cur.fetchall():
    print(f"  {col}")

# Check session table schema
cur.execute("PRAGMA table_info(session)")
print("\n=== SESSION TABLE SCHEMA ===")
for col in cur.fetchall():
    print(f"  {col}")

# Check part table schema
cur.execute("PRAGMA table_info(part)")
print("\n=== PART TABLE SCHEMA ===")
for col in cur.fetchall():
    print(f"  {col}")

db.close()

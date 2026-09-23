"""
db_view.py — quick read-only look at the crowd-safety Postgres DB.
Connects using DATABASE_URL from .env (same as the backend).
"""
import os
import sys
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

load_dotenv()
url = os.environ.get("DATABASE_URL")
if not url:
    print("DATABASE_URL not set in .env")
    sys.exit(1)

# SQLAlchemy needs the +psycopg scheme; raw psql doesn't.
if url.startswith("postgresql://"):
    url = url.replace("postgresql://", "postgresql+psycopg://", 1)

engine = create_engine(url)

QUERIES = {
    "1": ("Table row counts", """
        SELECT 'detections' AS table_name, COUNT(*) AS rows FROM detections
        UNION ALL
        SELECT 'alerts', COUNT(*) FROM alerts
    """),
    "2": ("Latest 10 detections", """
        SELECT id, stream_id, frame_id, timestamp, person_count, directional_surge
        FROM detections ORDER BY timestamp DESC LIMIT 10
    """),
    "3": ("Latest 10 alerts", """
        SELECT id, stream_id, location, timestamp, alert_level, alert_type,
               duration, user_acknowledged, false_positive_flag
        FROM alerts ORDER BY timestamp DESC LIMIT 10
    """),
    "4": ("Detections per stream", """
        SELECT stream_id, COUNT(*) AS frames,
               MIN(timestamp) AS first_seen,
               MAX(timestamp) AS last_seen,
               MAX(person_count) AS peak_people
        FROM detections GROUP BY stream_id ORDER BY last_seen DESC
    """),
    "5": ("Alerts per (stream, zone)", """
        SELECT stream_id, location, COUNT(*) AS alerts,
               MAX(alert_level) AS max_severity
        FROM alerts GROUP BY stream_id, location ORDER BY alerts DESC
    """),
    "6": ("Full JSON for one detection (latest)", """
        SELECT id, stream_id, frame_id, zones, clusters
        FROM detections ORDER BY timestamp DESC LIMIT 1
    """),
}

def print_menu():
    print("\n=== DB viewer ===")
    for k, (title, _) in QUERIES.items():
        print(f"  {k}. {title}")
    print("  q. quit")

def run_query(conn, sql):
    result = conn.execute(text(sql))
    cols = list(result.keys())
    rows = result.fetchall()
    if not rows:
        print("(no rows)")
        return
    widths = [len(c) for c in cols]
    for r in rows:
        for i, v in enumerate(r):
            widths[i] = max(widths[i], len(str(v)))
    print(" | ".join(c.ljust(widths[i]) for i, c in enumerate(cols)))
    print("-+-".join("-" * w for w in widths))
    for r in rows:
        print(" | ".join(str(v).ljust(widths[i]) for i, v in enumerate(r)))

def main():
    print_menu()
    with engine.connect() as conn:
        while True:
            choice = input("\nchoice> ").strip().lower()
            if choice in ("q", "quit", "exit"):
                break
            if choice not in QUERIES:
                print("unknown choice")
                continue
            title, sql = QUERIES[choice]
            print(f"\n--- {title} ---")
            try:
                run_query(conn, sql)
            except Exception as e:
                print(f"query failed: {e}")

if __name__ == "__main__":
    main()
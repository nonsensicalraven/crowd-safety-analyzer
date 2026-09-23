"""
database.py

Owns the SQLAlchemy engine/session setup, plus a small bounded
in-memory fallback buffer used when Postgres is temporarily
unreachable. This is a DB-failure safety net, not a normal part of
request handling -- see main.py, where it's only ever reached from an
except block.

Nothing here is Neon-specific -- switching to local Postgres is just
changing DATABASE_URL in .env. See README.md "Switching to local
Postgres" for exact steps.
"""

import os
from collections import deque
from typing import Callable

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base, Session

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. Create a .env file (see .env.example) "
        "with your Postgres connection string."
    )

engine = create_engine(DATABASE_URL)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """
    FastAPI dependency that yields a DB session and guarantees it is
    closed even if the request raises an exception.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------
# Fallback buffer for detections that failed to persist
# ---------------------------------------------------------------------
#
# PROTOTYPE-LEVEL FALLBACK ONLY. This is deliberately reached from
# exactly one place in main.py -- the except branch around a failed
# DB write. It is not a queue the normal request path goes through.
#
#   - In-memory, bounded size (oldest entry dropped once full).
#   - NOT durable: a process restart loses whatever is still buffered.
#   - Flushed automatically once the database is reachable again.

FALLBACK_BUFFER_MAXSIZE = 200

_fallback_buffer: deque = deque(maxlen=FALLBACK_BUFFER_MAXSIZE)


def buffer_failed_detection(record: dict) -> None:
    """Queue a detection dict (matching Detection model kwargs) that
    could not be written to Postgres."""
    was_full = len(_fallback_buffer) == _fallback_buffer.maxlen
    _fallback_buffer.append(record)
    if was_full:
        print(
            "WARNING: fallback buffer was full -- oldest buffered "
            "detection was dropped to make room."
        )
    print(
        f"WARNING: database unavailable, buffered detection "
        f"stream_id={record.get('stream_id')} frame_id={record.get('frame_id')} "
        f"(buffer size: {len(_fallback_buffer)}/{FALLBACK_BUFFER_MAXSIZE})"
    )


def fallback_buffer_size() -> int:
    return len(_fallback_buffer)


def try_flush_fallback_buffer(session_factory: Callable[[], Session]) -> int:
    """
    Attempt to write every buffered detection to Postgres, oldest
    first. Stops at the first failure (database presumably still
    down) and leaves the remainder queued for the next attempt.
    Returns the number of records successfully flushed.
    """
    from models import Detection  # local import avoids a circular import

    flushed = 0
    while _fallback_buffer:
        record = _fallback_buffer[0]
        db = session_factory()
        try:
            db.add(Detection(**record))
            db.commit()
        except Exception:
            db.rollback()
            db.close()
            break
        else:
            db.close()
            _fallback_buffer.popleft()
            flushed += 1
    return flushed
"""
models.py

SQLAlchemy ORM models. This schema changed shape from the previous
version, not just additively -- see migration.sql, which drops and
recreates both tables rather than trying to ALTER the old columns
into the new ones. There's no production data at stake yet, so a
clean recreate is simpler and less error-prone than a patch migration.

Detection: one row per processed frame (per stream). zones and
clusters are stored as JSON, matching the AI subsystem's own output
shape 1:1 -- see analytics.build_payload(). This project deliberately
does not normalize zones/clusters into their own tables: they're only
ever read back as "what did this frame look like," never queried by
individual cluster, so JSON keeps the schema simple without losing
anything actually needed.

Alert: one row per ongoing danger EVENT, keyed by (stream_id,
location). Multiple simultaneous alerts across different streams
and/or different grid cells are independent rows -- see
alert_logic.EventTrackerRegistry, which is what enforces that at the
application level. A single row's alert_level/alert_type/duration can
change over time as the same event continues or escalates (see
alert_logic.py) -- it is not rewritten into a new row each frame.
"""

from sqlalchemy import Column, Integer, Float, String, DateTime, Boolean, JSON
from database import Base


class Detection(Base):
    __tablename__ = "detections"

    id = Column(Integer, primary_key=True)
    stream_id = Column(String(64), nullable=False, index=True)
    frame_id = Column(Integer, nullable=False)
    timestamp = Column(DateTime, nullable=False)  # UTC

    person_count = Column(Integer, nullable=False, default=0)

    # Informational only -- NOT used by alert_logic.py. See
    # ARCHITECTURE.md for why directional_surge is excluded from
    # danger classification.
    directional_surge = Column(Boolean, nullable=False, default=False)

    # Raw per-zone and per-cluster data for this frame, same shape as
    # the AI subsystem's own payload (see analytics.build_payload).
    # zones: list of {name, cluster_count, person_count, individuals}
    # clusters: list of {cluster_id, person_count, density, location, surge}
    zones = Column(JSON, nullable=False, default=list)
    clusters = Column(JSON, nullable=False, default=list)


class Alert(Base):
    __tablename__ = "alerts"

    id = Column(Integer, primary_key=True)
    stream_id = Column(String(64), nullable=False, index=True)
    location = Column(String(32), nullable=False, index=True)  # one of the six zone names

    timestamp = Column(DateTime, nullable=False)  # when this event was first detected
    alert_level = Column(Integer, nullable=False)   # severity score, see alert_logic.py
    alert_type = Column(String(20), nullable=False)  # "LOW" / "MEDIUM" / "HIGH" / "CRITICAL"
    duration = Column(Integer, nullable=True, default=0)  # seconds the ongoing event has lasted

    user_acknowledged = Column(Boolean, default=False)
    false_positive_flag = Column(Boolean, default=False)
    response_team_arrived_at = Column(DateTime, nullable=True)
    cleared_at = Column(DateTime, nullable=True)

    # Not a formal FK on purpose -- keeps the schema loose for a
    # college project timeline. May be NULL if the triggering
    # detection itself only made it into the in-memory fallback buffer.
    source_detection_id = Column(Integer, nullable=True)
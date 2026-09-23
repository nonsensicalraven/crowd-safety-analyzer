"""
schemas.py

Pydantic models -- the API contract for whoever calls this backend
(the AI-facing frame endpoint) and for the frontend (REST responses +
WebSocket envelope).
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict


# ---------------------------------------------------------------------
# AI subsystem output shapes (mirrors analytics.build_payload exactly)
# ---------------------------------------------------------------------

class ZoneStats(BaseModel):
    name: str
    cluster_count: int
    person_count: int
    individuals: int


class ClusterInfo(BaseModel):
    cluster_id: int
    person_count: int
    density: float
    location: str
    surge: bool


# ---------------------------------------------------------------------
# Frame processing response (backend -> whatever called /streams/.../frames)
# ---------------------------------------------------------------------

class ZoneResult(ZoneStats):
    """A zone's stats plus this frame's computed severity for it."""
    severity: int        # 0 if no cluster present in this zone (see alert_logic.py)
    severity_name: str   # "LOW" / "MEDIUM" / "HIGH" / "CRITICAL"


class TriggeredAlert(BaseModel):
    """One zone's alert action as a result of this frame, if any."""
    alert_id: int
    stream_id: str
    location: str
    alert_level: int
    alert_type: str
    event: str  # "new" | "continue" | "escalate"


class FrameProcessResult(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: Optional[int] = None  # null if this frame's write hit the fallback buffer
    stream_id: str
    frame_id: int
    timestamp: datetime
    person_count: int
    directional_surge: bool  # informational only, see alert_logic.py
    zones: list[ZoneResult]
    clusters: list[ClusterInfo]
    alerts_triggered: list[TriggeredAlert]


# ---------------------------------------------------------------------
# Detection history (REST read-back)
# ---------------------------------------------------------------------

class DetectionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: Optional[int] = None
    stream_id: str
    frame_id: int
    timestamp: datetime
    person_count: int
    directional_surge: bool
    zones: list[ZoneStats]
    clusters: list[ClusterInfo]


# ---------------------------------------------------------------------
# Alerts / events (backend -> Rema's dashboard, and post-event actions)
# ---------------------------------------------------------------------

class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    stream_id: str
    location: str
    timestamp: datetime
    alert_level: int
    alert_type: str
    duration: Optional[int] = None
    user_acknowledged: bool
    false_positive_flag: bool
    response_team_arrived_at: Optional[datetime] = None
    cleared_at: Optional[datetime] = None
    source_detection_id: Optional[int] = None


class AlertAcknowledge(BaseModel):
    """Body for PATCH /alerts/{id}/acknowledge."""
    false_positive: bool = False


# ---------------------------------------------------------------------
# WebSocket broadcast envelope
# ---------------------------------------------------------------------

class WSMessage(BaseModel):
    """
    Every WebSocket broadcast on /ws/dashboard is wrapped in this
    envelope. `stream_id` lets a multi-camera dashboard route a
    message to the right panel without inspecting `data`.

    type: "frame_update" | "alert"
    For type == "alert", `data` additionally carries an "event" key:
    "new" | "continue" | "escalate".
    """
    type: str
    stream_id: str
    data: dict
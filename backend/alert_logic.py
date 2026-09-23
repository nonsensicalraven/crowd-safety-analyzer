"""
alert_logic.py

The decision layer. Danger is classified PER GRID CELL, per stream --
not globally, and not per cluster_id (cluster_id is not a stable
identity; see analytics.ClusterIdTracker's own docstring, which
already says as much).

FIELDS USED FROM THE AI PAYLOAD:
  - clusters[].density (people/m^2) -- the only signal danger
    classification is based on.
  - clusters[].location -- which of the six zones a cluster belongs to.
NOT used for danger classification (informational only, per explicit
instruction): directional_surge, clusters[].surge, person_count,
cluster_count, individuals. These are still stored and still shown to
the frontend -- they're just not inputs to the severity decision.

Severity scale carried over from the previous single-stream design:

    LOW = 10, MEDIUM = 40, HIGH = 75, CRITICAL = 90

Rules, PREVIOUSLY:
    density > 7                       -> CRITICAL
    density > 6                       -> HIGH
    density > 5                       -> MEDIUM
    otherwise                         -> LOW

Both non-LOW/non-CRITICAL rules depended on directional_surge. With
surge excluded from danger classification, those two rules had no
replacement -- HIGH was defined but unreachable for a while (see git
history / prior README). RESOLVED: HIGH now sits at density > 6,
the midpoint of the existing MEDIUM(>5)/CRITICAL(>7) gap. This is a
judgment call (not independently spec'd), consistent with common
crowd-safety guidance that ~5 people/m^2 is where crush risk begins
and ~6+ is clearly dangerous. Change DENSITY_HIGH below if you or
Kushal want a different cutoff -- it's the one constant that encodes
this decision.

EFFECTIVE RULES (density-only, all four tiers reachable):
    density > DENSITY_CRITICAL   -> CRITICAL
    density > DENSITY_HIGH       -> HIGH
    density > DENSITY_MEDIUM     -> MEDIUM
    otherwise                    -> LOW

A zone's severity is driven by its most dangerous cluster (max density
among clusters located in that zone this frame). A zone with clusters
= 0 for this frame (empty, or only unclustered individuals) is always
LOW -- there is no per-zone density number without a cluster, and
inventing one from raw person_count would be exactly the kind of
threshold nobody has defined. See ARCHITECTURE.md.
"""

import time
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Optional

# ---------------------------------------------------------------------
# Severity scale
# ---------------------------------------------------------------------

SEVERITY_LOW = 10
SEVERITY_MEDIUM = 40
SEVERITY_HIGH = 75
SEVERITY_CRITICAL = 90

SEVERITY_NAMES = {
    SEVERITY_LOW: "LOW",
    SEVERITY_MEDIUM: "MEDIUM",
    SEVERITY_HIGH: "HIGH",
    SEVERITY_CRITICAL: "CRITICAL",
}

# Only zones at or above this severity generate/continue an Alert row.
ALERT_CREATION_THRESHOLD = SEVERITY_MEDIUM

# ---------------------------------------------------------------------
# Decision thresholds -- density is people/m^2, from clusters[].density.
# ---------------------------------------------------------------------

DENSITY_CRITICAL = 7
DENSITY_HIGH = 6      # NEW -- see module docstring for rationale
DENSITY_MEDIUM = 5


@dataclass
class AlertDecision:
    severity: int
    severity_name: str


def evaluate_zone(max_cluster_density: float) -> AlertDecision:
    """
    Pure function: this zone's most-dangerous cluster density in, a
    severity decision out. max_cluster_density is 0.0 for a zone with
    no clusters this frame (always LOW).
    """
    if max_cluster_density > DENSITY_CRITICAL:
        severity = SEVERITY_CRITICAL
    elif max_cluster_density > DENSITY_HIGH:
        severity = SEVERITY_HIGH
    elif max_cluster_density > DENSITY_MEDIUM:
        severity = SEVERITY_MEDIUM
    else:
        severity = SEVERITY_LOW

    return AlertDecision(severity=severity, severity_name=SEVERITY_NAMES[severity])


# ---------------------------------------------------------------------
# Event continuity / deduplication -- PER (stream_id, location)
# ---------------------------------------------------------------------
#
# Repeated alert-worthy readings for the SAME zone of the SAME stream,
# arriving within CONTINUITY_WINDOW_SECONDS of each other, are one
# ongoing event:
#   - First alert-worthy reading            -> new Alert row.
#   - Next one, same/lower severity          -> continue: extend duration.
#   - Next one, higher severity              -> escalate: update in place.
#   - Gap too long, or alert acknowledged    -> event over; next
#                                                alert-worthy reading
#                                                starts a fresh row.
#
# Each (stream_id, location) pair gets its OWN EventTracker instance
# (see EventTrackerRegistry) so a HIGH reading in top-center on cam-1
# can never merge with, or be confused for, a HIGH reading in
# bottom-right on cam-1 or top-center on cam-2. This directly
# implements "events must be tracked per grid cell, not globally."

CONTINUITY_WINDOW_SECONDS = 20


class EventTracker:
    """State for ONE (stream_id, location) pair. Do not share instances
    across zones or streams -- use EventTrackerRegistry."""

    def __init__(self) -> None:
        self.active_alert_id: Optional[int] = None
        self.active_severity: Optional[int] = None
        self.started_at: Optional[datetime] = None
        self._last_seen_monotonic: Optional[float] = None

    def resolve(self, severity: int, acknowledged_lookup: Callable[[int], bool]) -> str:
        """Returns one of: "new", "continue", "escalate" """
        now = time.monotonic()

        is_ongoing = (
            self.active_alert_id is not None
            and self._last_seen_monotonic is not None
            and (now - self._last_seen_monotonic) <= CONTINUITY_WINDOW_SECONDS
            and not acknowledged_lookup(self.active_alert_id)
        )

        if is_ongoing:
            self._last_seen_monotonic = now
            if severity > (self.active_severity or 0):
                self.active_severity = severity
                return "escalate"
            return "continue"

        self.active_severity = severity
        self._last_seen_monotonic = now
        self.started_at = datetime.utcnow()
        return "new"

    def set_active(self, alert_id: int) -> None:
        self.active_alert_id = alert_id

    def elapsed_seconds(self) -> int:
        if self.started_at is None:
            return 0
        return int((datetime.utcnow() - self.started_at).total_seconds())

    def clear(self) -> None:
        self.active_alert_id = None
        self.active_severity = None
        self.started_at = None
        self._last_seen_monotonic = None


class EventTrackerRegistry:
    """
    One EventTracker per (stream_id, location). Created lazily.
    This is the mechanism that keeps multi-stream, multi-zone state
    from mixing -- see the "Avoid global state" project requirement.
    """

    def __init__(self) -> None:
        self._trackers: dict[tuple[str, str], EventTracker] = {}

    def get(self, stream_id: str, location: str) -> EventTracker:
        key = (stream_id, location)
        if key not in self._trackers:
            self._trackers[key] = EventTracker()
        return self._trackers[key]

    def clear_if_active(self, stream_id: str, location: str, alert_id: int) -> None:
        """Called when an alert is acknowledged, so the next
        alert-worthy reading for this zone starts a fresh event
        instead of being folded into the just-acknowledged one."""
        key = (stream_id, location)
        tracker = self._trackers.get(key)
        if tracker is not None and tracker.active_alert_id == alert_id:
            tracker.clear()
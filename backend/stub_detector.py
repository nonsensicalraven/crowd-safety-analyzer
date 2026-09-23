"""
stub_detector.py — OPT-IN development/testing stand-in for the real
YOLO head detector.

This exists so the backend, alert logic, database, and WebSocket layer
can be developed and tested by Sahithi (or CI) without a GPU, without
the ~6MB best.pt weights file, and without network access to Hugging
Face. It does NOT run any detection algorithm -- it returns a fixed,
deterministic set of fake head bounding boxes so the rest of the
pipeline (tracking, clustering, zoning, alerting) has something to
chew on.

This must NEVER be used for an actual demo or anything resembling a
real result -- it does not look at the uploaded image at all. It is
selected explicitly via the AI_ENGINE=stub environment variable (see
.env.example) and main.py logs loudly on startup when it's active so
nobody mistakes stub output for a real detection.

Do not extend this to "approximate" YOLO behavior -- if it starts
trying to be smart about what it returns, it stops being a safe,
obviously-fake stand-in.
"""

from __future__ import annotations

import random

from detection import Detection


class StubDetector:
    """Same call shape as detection.YoloHeadWrapper, fake output."""

    def __init__(self, cfg) -> None:
        self.cfg = cfg
        self._rng = random.Random(42)  # deterministic across runs

    def infer(self, frames: list, conf: float | None = None) -> list[list[Detection]]:
        out: list[list[Detection]] = []
        for frame in frames:
            h, w = frame.shape[:2] if hasattr(frame, "shape") else (480, 640)
            n = self._rng.randint(3, 12)
            dets = []
            for _ in range(n):
                cx = self._rng.uniform(0, w)
                cy = self._rng.uniform(0, h)
                size = self._rng.uniform(15, 35)
                dets.append(Detection(
                    bbox=(cx - size, cy - size, cx + size, cy + size),
                    confidence=self._rng.uniform(0.4, 0.95),
                ))
            out.append(dets)
        return out
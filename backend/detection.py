"""
detection.py — YOLOv8n head detector (RPEE-Heads fine-tune) and a greedy IoU
tracker. All bounding boxes are in ORIGINAL frame pixel coordinates.
"""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from loguru import logger

from config import Settings


# --------------------------------------------------------------------------- data types


@dataclass
class Detection:
    """A single head detection in original-resolution pixel coordinates."""

    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2
    confidence: float

    @property
    def centroid(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


@dataclass
class Track:
    """A confirmed tracked head."""

    id: int
    bbox: tuple[float, float, float, float]
    centroid: tuple[float, float]
    confidence: float


# --------------------------------------------------------------------------- tracker


def _iou(a: tuple[float, float, float, float],
         b: tuple[float, float, float, float]) -> float:
    """Intersection-over-union of two xyxy boxes."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


@dataclass
class _TrackState:
    id: int
    bbox: tuple[float, float, float, float]
    conf: float
    hits: int = 0
    misses: int = 0


class IouTracker:
    """
    Greedy IoU tracker with per-frame updates. One instance PER STREAM.

    Tracks are confirmed after ``track_min_hits`` consecutive hits and dropped
    after ``track_max_age`` consecutive misses.
    """

    def __init__(self, cfg: Settings) -> None:
        self._max_age: int = cfg.track_max_age
        self._min_hits: int = cfg.track_min_hits
        self._iou_thresh: float = cfg.track_iou_thresh
        self._next_id: int = 1
        self._tracks: list[_TrackState] = []

    def update(self, detections: list[Detection]) -> list[Track]:
        """Match one frame's detections to tracks; return confirmed tracks."""
        unmatched = list(self._tracks)
        for det in sorted(detections, key=lambda d: d.confidence, reverse=True):
            best: _TrackState | None = None
            best_iou: float = self._iou_thresh
            for st in unmatched:
                i = _iou(st.bbox, det.bbox)
                if i > best_iou:
                    best, best_iou = st, i
            if best is not None:
                best.bbox, best.conf = det.bbox, det.confidence
                best.hits += 1
                best.misses = 0
                unmatched.remove(best)
            else:
                self._tracks.append(
                    _TrackState(id=self._next_id, bbox=det.bbox, conf=det.confidence, hits=1)
                )
                self._next_id += 1

        for st in unmatched:
            st.misses += 1
        self._tracks = [st for st in self._tracks if st.misses <= self._max_age]

        confirmed: list[Track] = []
        for st in self._tracks:
            if st.hits >= self._min_hits:
                x1, y1, x2, y2 = st.bbox
                confirmed.append(Track(id=st.id, bbox=st.bbox,
                                       centroid=((x1 + x2) / 2.0, (y1 + y2) / 2.0),
                                       confidence=st.conf))
        return confirmed


# --------------------------------------------------------------------------- YOLO detector


def _resolve_yolo_weights(cfg: Settings) -> Path:
    """Locate the head-detector weights, downloading from Hugging Face if needed."""
    candidates = [Path(cfg.yolo_head_weights), Path("weights") / "yolo_head.pt"]
    for p in candidates:
        if p.exists():
            return p
    if not cfg.auto_download_from_hf:
        raise FileNotFoundError(
            f"Weights not found (looked at: {[str(c) for c in candidates]})."
        )
    from huggingface_hub import hf_hub_download

    logger.info(f"Downloading '{cfg.hf_weights_file}' from '{cfg.hf_model_id}' ...")
    downloaded = hf_hub_download(repo_id=cfg.hf_model_id, filename=cfg.hf_weights_file)
    shutil.copyfile(downloaded, candidates[0])
    logger.info(f"Cached weights to '{candidates[0]}'")
    return candidates[0]


class YoloHeadWrapper:
    """
    YOLOv8n head detector via ultralytics. Single class: 'head'.

    Runs the model card's counting baseline settings (imgsz=832, conf=0.25,
    iou=0.75, max_det=300). Ultralytics returns boxes already scaled to the
    original image resolution, so no manual rescaling is needed.
    """

    def __init__(self, cfg: Settings) -> None:
        self.cfg = cfg
        from ultralytics import YOLO

        # ultralytics resets its logger on import, so this must come after it
        logging.getLogger("ultralytics").setLevel(logging.ERROR)

        weights = _resolve_yolo_weights(cfg)
        self.device: str = cfg.device if (cfg.device == "cpu" or torch.cuda.is_available()) else "cpu"
        if self.device != cfg.device:
            logger.warning("CUDA unavailable — running on CPU. "
                           "Set YOLO_IMGSZ=640 to compensate.")
        self.half: bool = cfg.half_precision and self.device.startswith("cuda")
        self.model = YOLO(str(weights))
        self.model.predict(  # warm-up so the first real frame isn't slow
            np.zeros((cfg.input_height, cfg.input_width, 3), dtype=np.uint8),
            imgsz=cfg.yolo_imgsz, device=self.device, verbose=False,
        )
        logger.info(f"YOLO head detector ready (weights={weights}, "
                    f"device={self.device}, half={self.half})")

    @torch.no_grad()
    def infer(self, frames: list[np.ndarray],
              conf: float | None = None) -> list[list[Detection]]:
        """
        Batched detection: one GPU call for N frames of any size.

        ``conf`` overrides the configured threshold for this call only. With
        multiple streams sharing a batch, the caller passes the lowest conf any
        participating stream wants and filters per stream afterwards; None uses
        the configured default.
        """
        if not frames:
            return []
        results = self.model.predict(
            source=frames, imgsz=self.cfg.yolo_imgsz,
            conf=self.cfg.yolo_conf if conf is None else conf,
            iou=self.cfg.yolo_iou, max_det=self.cfg.yolo_max_det,
            device=self.device, half=self.half, verbose=False,
        )
        out: list[list[Detection]] = []
        for r in results:
            dets: list[Detection] = []
            boxes = getattr(r, "boxes", None)
            if boxes is not None and boxes.xyxy is not None and len(boxes.xyxy) > 0:
                xyxy = boxes.xyxy.cpu().numpy()
                confs = boxes.conf.cpu().numpy()
                clss = boxes.cls.cpu().numpy().astype(int)
                for (x1, y1, x2, y2), c, k in zip(xyxy, confs, clss):
                    if k != 0:  # single-class model: class 0 is 'head'
                        continue
                    dets.append(Detection(bbox=(float(x1), float(y1), float(x2), float(y2)),
                                          confidence=float(c)))
            out.append(dets)
        return out
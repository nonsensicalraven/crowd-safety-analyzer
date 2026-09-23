"""
analytics.py — clustering, density, zone-grid assignment, semi-stable cluster
IDs, surge detection, heatmap, annotated-frame rendering, and the metrics
payload. Pure logic; no I/O.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone

import cv2
import numpy as np
from sklearn.cluster import DBSCAN

from config import Settings
from detection import Track


# --------------------------------------------------------------------------- zone grid

_ROW_NAMES = {1: ["top"], 2: ["top", "bottom"],
              3: ["top", "middle", "bottom"],
              4: ["top", "upper-mid", "lower-mid", "bottom"]}
_COL_NAMES = {1: ["left"], 2: ["left", "right"],
              3: ["left", "center", "right"],
              4: ["left", "center-left", "center-right", "right"]}


def zone_names(cols: int, rows: int) -> list[str]:
    """Stable names for a cols x rows grid, row-major from top-left."""
    rn = _ROW_NAMES.get(rows, [f"r{i}" for i in range(rows)])
    cn = _COL_NAMES.get(cols, [f"c{i}" for i in range(cols)])
    if rows == 1 and cols == 1:
        return ["center"]
    if rows == 1:
        return list(cn)
    if cols == 1:
        return list(rn)
    return [f"{r}-{c}" for r in rn for c in cn]


def zone_index(point: tuple[float, float], frame_w: int, frame_h: int,
               cols: int, rows: int) -> int:
    """Cell index (row-major) containing the point."""
    col = min(max(int(point[0] / max(frame_w, 1) * cols), 0), cols - 1)
    row = min(max(int(point[1] / max(frame_h, 1) * rows), 0), rows - 1)
    return row * cols + col


def assign_zones(clusters: list["Cluster"], noise: list[Track], cfg: Settings,
                 frame_w: int, frame_h: int) -> list[dict[str, object]]:
    """
    Assign every cluster to exactly ONE cell — the cell holding the majority of
    its member centroids (ties break to the first cell in reading order), so a
    cluster is never split across cells. Individuals (unclustered tracks) are
    counted in the cell containing them.

    Returns stats for ALL cells in reading order:
        {"name", "cluster_count", "person_count", "individuals"}
    where person_count = cluster members (majority-assigned) + individuals.
    Mutates each cluster's zone_id and location.
    """
    cols, rows = cfg.grid_cols, cfg.grid_rows
    names = zone_names(cols, rows)
    n = cols * rows
    stats: list[dict[str, object]] = [
        {"name": nm, "cluster_count": 0, "person_count": 0, "individuals": 0}
        for nm in names
    ]

    for c in clusters:
        pts = c.member_centroids if c.member_centroids else [c.centroid]
        counts = np.bincount(
            np.array([zone_index(p, frame_w, frame_h, cols, rows) for p in pts]),
            minlength=n,
        )
        zi = int(counts.argmax())
        c.zone_id = zi
        c.location = names[zi]
        stats[zi]["cluster_count"] = int(stats[zi]["cluster_count"]) + 1
        stats[zi]["person_count"] = int(stats[zi]["person_count"]) + c.size

    for t in noise:
        zi = zone_index(t.centroid, frame_w, frame_h, cols, rows)
        stats[zi]["individuals"] = int(stats[zi]["individuals"]) + 1
        stats[zi]["person_count"] = int(stats[zi]["person_count"]) + 1

    return stats


# --------------------------------------------------------------------------- calibration


class Calibrator:
    """Pixels -> meters for one camera."""

    def __init__(self, px_per_meter: float) -> None:
        self._ppm: float = max(px_per_meter, 1e-6)

    def pixel_length_to_m(self, px: float) -> float:
        return px / self._ppm


# --------------------------------------------------------------------------- cluster


@dataclass
class Cluster:
    """A group of people detected as one crowd."""

    id: int
    bbox_px: tuple[float, float, float, float]
    centroid: tuple[float, float]
    size: int
    confidence: float = 0.0
    density: float = 0.0
    area_m2: float = field(default=0.0)
    velocity: tuple[float, float] = (0.0, 0.0)
    surge: bool = False
    member_centroids: list[tuple[float, float]] = field(default_factory=list)
    zone_id: int = -1
    location: str = ""


def cluster_tracks(tracks: list[Track], cfg: Settings) -> tuple[list[Cluster], list[Track]]:
    """
    DBSCAN over track centroids. Returns (clusters sorted by size desc, noise)
    where noise is the tracks belonging to no cluster. Cluster IDs are
    placeholders here; ClusterIdTracker assigns semi-stable ones.
    """
    if not tracks:
        return [], []
    pts = np.array([t.centroid for t in tracks], dtype=np.float64)
    labels = DBSCAN(eps=cfg.dbscan_eps_px, min_samples=cfg.dbscan_min_samples).fit_predict(pts)

    clusters: list[Cluster] = []
    noise: list[Track] = []
    for lab in sorted(set(labels)):
        idx = np.where(labels == lab)[0]
        if lab == -1:
            noise.extend(tracks[i] for i in idx)
            continue
        cx = pts[idx]
        x1, y1 = cx.min(axis=0)
        x2, y2 = cx.max(axis=0)
        pad = cfg.dbscan_eps_px / 2.0
        clusters.append(Cluster(
            id=-1,
            bbox_px=(float(x1 - pad), float(y1 - pad), float(x2 + pad), float(y2 + pad)),
            centroid=(float(cx[:, 0].mean()), float(cx[:, 1].mean())),
            size=int(idx.size),
            confidence=float(np.mean([tracks[i].confidence for i in idx])),
            member_centroids=[(float(p[0]), float(p[1])) for p in cx],
        ))
    clusters.sort(key=lambda c: c.size, reverse=True)
    return clusters, noise


def compute_density(cluster: Cluster, calibrator: Calibrator, cfg: Settings) -> float:
    """people / m^2 from the cluster's bbox in meters, with an area floor."""
    x1, y1, x2, y2 = cluster.bbox_px
    w_m = calibrator.pixel_length_to_m(max(x2 - x1, 1.0))
    h_m = calibrator.pixel_length_to_m(max(y2 - y1, 1.0))
    cluster.area_m2 = max(w_m * h_m, cfg.min_cluster_area_m2)
    cluster.density = cluster.size / cluster.area_m2
    return cluster.density


# --------------------------------------------------------------------------- stable ids + surge


class ClusterIdTracker:
    """
    Gives DBSCAN clusters semi-stable IDs across frames by greedy
    nearest-centroid matching (within dbscan_eps_px), and derives per-cluster
    velocity and surge from a short centroid history. One instance PER STREAM.

    IDs are a hint for display and short-term correlation, not a guarantee —
    splits and merges renumber clusters. Downstream event tracking should join
    on zone location.
    """

    def __init__(self, cfg: Settings) -> None:
        self._cfg = cfg
        self._history: dict[int, deque[tuple[float, float]]] = {}
        self._prev_centroids: dict[int, tuple[float, float]] = {}
        self._next_id: int = 1

    def update(self, clusters: list[Cluster]) -> list[Cluster]:
        """Assign IDs, velocity and surge. Mutates clusters in place."""
        available_old = set(self._prev_centroids.keys())
        matched: dict[int, Cluster] = {}
        for cl in clusters:  # largest first
            best_id: int | None = None
            best_d: float = self._cfg.dbscan_eps_px
            for old_id in available_old:
                px, py = self._prev_centroids[old_id]
                d = math.hypot(cl.centroid[0] - px, cl.centroid[1] - py)
                if d <= best_d:
                    best_id, best_d = old_id, d
            if best_id is None:
                best_id = self._next_id
                self._next_id += 1
                self._history[best_id] = deque(maxlen=self._cfg.surge_history_len)
            else:
                available_old.discard(best_id)
            cl.id = best_id
            matched[best_id] = cl
            hist = self._history[best_id]
            hist.append(cl.centroid)
            if len(hist) >= 2:
                vx = hist[-1][0] - hist[0][0]
                vy = hist[-1][1] - hist[0][1]
                cl.velocity = (vx, vy)
                cl.surge = math.hypot(vx, vy) >= self._cfg.surge_magnitude_threshold_px
            else:
                cl.velocity = (0.0, 0.0)
                cl.surge = False
        self._prev_centroids = {cid: cl.centroid for cid, cl in matched.items()}
        return clusters

    def reset(self) -> None:
        self._history.clear()
        self._prev_centroids.clear()


# --------------------------------------------------------------------------- heatmap


class Heatmap:
    """Per-stream decaying occupancy grid, rendered as a translucent JET overlay."""

    def __init__(self, cfg: Settings) -> None:
        self.cfg = cfg
        self.grid: np.ndarray = np.zeros((cfg.heatmap_rows, cfg.heatmap_cols), dtype=np.float32)

    def add_points(self, points_px: list[tuple[float, float]],
                   frame_w: int, frame_h: int) -> None:
        """Decay the grid, then add 1.0 at each point's cell."""
        self.grid *= self.cfg.heatmap_decay
        rows, cols = self.grid.shape
        for x, y in points_px:
            col = min(int(x / max(frame_w, 1) * cols), cols - 1)
            row = min(int(y / max(frame_h, 1) * rows), rows - 1)
            if 0 <= col < cols and 0 <= row < rows:
                self.grid[row, col] += 1.0

    def reset(self) -> None:
        self.grid[:] = 0.0

    def overlay(self, frame_bgr: np.ndarray) -> np.ndarray:
        """Alpha-blend the heatmap onto the frame where heat exists. In place."""
        h, w = frame_bgr.shape[:2]
        hm = cv2.resize(self.grid, (w, h), interpolation=cv2.INTER_LINEAR)
        hm = cv2.GaussianBlur(hm, (0, 0), self.cfg.heatmap_blur_sigma)
        peak = float(hm.max())
        if peak <= 1e-6:
            return frame_bgr
        hm_norm = (hm / peak * 255.0).astype(np.uint8)
        color = cv2.applyColorMap(hm_norm, cv2.COLORMAP_JET)
        mask = hm_norm > 12
        blended = cv2.addWeighted(color, self.cfg.heatmap_alpha, frame_bgr,
                                  1.0 - self.cfg.heatmap_alpha, 0.0)
        frame_bgr[mask] = blended[mask]
        return frame_bgr


# --------------------------------------------------------------------------- rendering


def render_frame(
    frame_bgr: np.ndarray,
    tracks: list[Track],
    clusters: list[Cluster] | None,
    zone_stats: list[dict[str, object]] | None,
    heatmap: Heatmap,
    cfg: Settings,
    hud_lines: list[str],
) -> np.ndarray:
    """
    Annotate a frame for display, in draw order: heatmap, zone grid lines and
    per-cell counts, green head boxes, cluster circles/labels/motion arrows
    (red arrow = surge), HUD text at bottom-left. Mutates and returns frame_bgr.
    """
    h, w = frame_bgr.shape[:2]

    if cfg.render_heatmap:
        heatmap.overlay(frame_bgr)

    cols, rows = cfg.grid_cols, cfg.grid_rows
    grid_color = (220, 220, 220)
    for i in range(1, cols):
        cv2.line(frame_bgr, (int(w * i / cols), 0), (int(w * i / cols), h), grid_color, 1)
    for j in range(1, rows):
        cv2.line(frame_bgr, (0, int(h * j / rows)), (w, int(h * j / rows)), grid_color, 1)

    if zone_stats:
        names = zone_names(cols, rows)
        for zi, zs in enumerate(zone_stats):
            r, c = divmod(zi, cols)
            x0, y0 = int(w * c / cols), int(h * r / rows)
            label = f"{names[zi]}  C:{zs['cluster_count']} P:{zs['person_count']}"
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
            cv2.rectangle(frame_bgr, (x0 + 4, y0 + 4), (x0 + tw + 12, y0 + th + 10),
                          (20, 20, 20), -1)
            cv2.putText(frame_bgr, label, (x0 + 8, y0 + th + 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (120, 255, 255), 1, cv2.LINE_AA)

    if cfg.render_boxes:
        for t in tracks:
            x1, y1, x2, y2 = (int(v) for v in t.bbox)
            cv2.rectangle(frame_bgr, (x1, y1), (x2, y2), (0, 255, 0), 1)

    if cfg.render_cluster_labels and clusters:
        for c in clusters:
            cx, cy = int(c.centroid[0]), int(c.centroid[1])
            r = max(24, int(cfg.dbscan_eps_px / 2))
            cv2.circle(frame_bgr, (cx, cy), r, (80, 80, 255), 2)
            label = f"#{c.id} {c.size}p {c.density:.1f}/m2"
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
            ty = max(th + 4, cy + r + th + 6)
            cv2.rectangle(frame_bgr, (cx - tw // 2 - 3, ty - th - 4),
                          (cx + tw // 2 + 3, ty + 2), (30, 30, 30), -1)
            cv2.putText(frame_bgr, label, (cx - tw // 2, ty),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)

            vx, vy = c.velocity
            if math.hypot(vx, vy) >= 4.0:
                ex, ey = int(cx + vx * 2), int(cy + vy * 2)
                color = (0, 0, 255) if c.surge else (180, 180, 180)
                cv2.arrowedLine(frame_bgr, (cx, cy), (ex, ey), color,
                                2 if c.surge else 1, tipLength=0.35)
                if c.surge:
                    cv2.putText(frame_bgr, "SURGE", (cx + 8, cy - 8),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2, cv2.LINE_AA)

    y = h - 8 - (len(hud_lines) - 1) * 20
    for line in hud_lines:
        cv2.putText(frame_bgr, line, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (0, 255, 120), 1, cv2.LINE_AA)
        y += 20
    return frame_bgr


def encode_jpeg(frame_bgr: np.ndarray, quality: int) -> bytes:
    """Encode a BGR frame to JPEG bytes."""
    ok, buf = cv2.imencode(".jpg", frame_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return buf.tobytes()


# --------------------------------------------------------------------------- metrics payload


def build_payload(
    stream_id: str,
    frame_id: int,
    clusters: list[Cluster],
    tracks: list[Track],
    frame_w: int,
    frame_h: int,
    zone_stats: list[dict[str, object]],
) -> dict[str, object]:
    """
    Build the per-batch metrics payload for the /detect endpoint.

    Core contract: frame_id, timestamp, and per-cluster cluster_id,
    person_count, density, location. Additional fields: stream_id (multi-stream
    routing), person_count (total incl. individuals), directional_surge,
    zones (per-cell counts), and per-cluster surge.
    """
    return {
        "stream_id": stream_id,
        "frame_id": frame_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "person_count": len(tracks),
        "directional_surge": any(c.surge for c in clusters),
        "zones": zone_stats,
        "clusters": [
            {
                "cluster_id": c.id,
                "person_count": c.size,
                "density": round(c.density, 3),
                "location": c.location,
                "surge": c.surge,
            }
            for c in clusters
        ],
    }
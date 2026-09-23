"""
config.py — AI pipeline configuration, merged backend.
Extended with the rendering + heatmap + per-stream display settings that
the original Crowd_ai v3 pipeline.py had, so the annotated-frame
endpoints in main.py can use them. The detection/clustering/tracking
ALGORITHMS in detection.py and analytics.py are untouched.
"""
from __future__ import annotations
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    """AI pipeline settings, overridable via environment / .env."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # ------------------------------------------------------------- frame handling
    input_width: int = 640
    input_height: int = 480

    # ------------------------------------------------------------- detector (YOLOv8n-head)
    yolo_head_weights: str = "best.pt"
    hf_model_id: str = "AmineSam/irail-crowd-counting-yolov8n"
    hf_weights_file: str = "best.pt"
    auto_download_from_hf: bool = True
    device: str = "cuda"
    half_precision: bool = True
    yolo_imgsz: int = 832
    yolo_conf: float = 0.25
    yolo_iou: float = 0.75
    yolo_max_det: int = 2000

    # ------------------------------------------------------------- tracking
    track_max_age: int = 5
    # 1 = confirm a track on its first hit. This is what you want for
    # still-image uploads and short batches — a single frame or the
    # first of a batch produces a count immediately.
    # Set to 3 (or higher) if you want the flicker suppression that
    # continuous-video tracking benefits from.
    track_min_hits: int = 1
    track_iou_thresh: float = 0.3

    # ------------------------------------------------------------- clustering / density
    dbscan_eps_px: float = 80.0
    dbscan_min_samples: int = 3
    px_per_meter: float = 100.0
    min_cluster_area_m2: float = 0.5

    # ------------------------------------------------------------- surge (informational only)
    surge_history_len: int = 3
    surge_magnitude_threshold_px: float = 15.0

    # ------------------------------------------------------------- zone grid
    # MUST stay 3 cols x 2 rows: main.py asserts this at startup.
    grid_cols: int = 3
    grid_rows: int = 2

    # ------------------------------------------------------------- heatmap + rendering
    heatmap_cols: int = 32
    heatmap_rows: int = 24
    heatmap_decay: float = 0.92
    heatmap_blur_sigma: float = 3.0
    heatmap_alpha: float = 0.45
    render_heatmap: bool = True
    render_boxes: bool = True
    render_cluster_labels: bool = True
    display_jpeg_quality: int = 80
    # WS ingest sends one annotated frame every this many received frames.
    display_every_n: int = 3

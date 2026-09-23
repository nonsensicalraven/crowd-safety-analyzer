"""
main.py
The merged FastAPI application: AI frame processing, decision layer,
persistence, WebSocket broadcast, and annotated-frame rendering — all
in one process.

Endpoints
---------
Frame processing (JSON response):
    POST /streams/{stream_id}/frames

Frame processing (annotated JPEG):
    POST /streams/{stream_id}/frames/annotated
    POST /streams/{stream_id}/frames/batch/annotated

WebSocket ingest with live per-stream config:
    WS   /ws/ingest/{stream_id}

Development simulator UI:
    GET  /simulator

Health / status:
    GET  /                       (JSON health)
    GET  /healthz                (richer status)
"""
import asyncio
import base64
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional

import cv2
import numpy as np
from fastapi import (
    FastAPI, Depends, HTTPException, Query, UploadFile, File,
    WebSocket, WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, HTMLResponse
from sqlalchemy.orm import Session
from sqlalchemy import desc
from loguru import logger

import database
from database import Base, engine as db_engine, get_db, SessionLocal
from models import Detection, Alert
from schemas import (
    DetectionOut, AlertOut, AlertAcknowledge, WSMessage,
    FrameProcessResult, ZoneResult, ClusterInfo, TriggeredAlert,
)
import alert_logic
from config import Settings
from detection import IouTracker, Detection as AiDetection
from analytics import (
    Calibrator, ClusterIdTracker, Heatmap, cluster_tracks, compute_density,
    assign_zones, build_payload, zone_names, render_frame, encode_jpeg,
)
from simulator import FRONTEND_HTML

cfg = Settings()

# The six contract-required zone names only come out of a 3x2 grid.
EXPECTED_ZONES = [
    "top-left", "top-center", "top-right",
    "bottom-left", "bottom-center", "bottom-right",
]
_actual_zones = zone_names(cfg.grid_cols, cfg.grid_rows)
if _actual_zones != EXPECTED_ZONES:
    raise RuntimeError(
        f"Zone grid config (grid_cols={cfg.grid_cols}, grid_rows={cfg.grid_rows}) "
        f"produces zones {_actual_zones}, not the six contract-required names "
        f"{EXPECTED_ZONES}. Do not change grid_cols/grid_rows without updating "
        f"the frontend and database accordingly."
    )

FALLBACK_FLUSH_INTERVAL_SECONDS = 5

# ---------------------------------------------------------------------
# AI engine selection -- real YOLO by default, explicit opt-in stub
# ---------------------------------------------------------------------
AI_ENGINE = os.environ.get("AI_ENGINE", "real").lower()
if AI_ENGINE == "stub":
    from stub_detector import StubDetector
    logger.warning(
        "AI_ENGINE=stub -- using StubDetector. Detections are FAKE random "
        "boxes, not real head detection. Never use this for a demo. "
        "Unset AI_ENGINE or set AI_ENGINE=real to use the actual model."
    )
    engine = StubDetector(cfg)
else:
    from detection import YoloHeadWrapper
    engine = YoloHeadWrapper(cfg)

# ---------------------------------------------------------------------
# Per-stream AI state
# ---------------------------------------------------------------------
class StreamAiState:
    """
    All per-stream state. Includes a per-stream Settings override, a
    Heatmap, and the display cadence used by the annotated endpoints
    and the WS ingest handler.
    """

    def __init__(self, app_cfg: Settings, stream_id: str) -> None:
        self.stream_id: str = stream_id
        self.cfg: Settings = app_cfg
        self.tracker = IouTracker(app_cfg)
        self.cluster_ids = ClusterIdTracker(app_cfg)
        self.calibrator = Calibrator(app_cfg.px_per_meter)
        self.heatmap = Heatmap(app_cfg)
        self.display_every_n: int = app_cfg.display_every_n
        self._frame_seq: int = 0
        self._frames_since_display: int = 0

    def next_frame_id(self) -> int:
        self._frame_seq += 1
        return self._frame_seq

    def configure(
        self,
        px_per_meter: Optional[float] = None,
        dbscan_eps_px: Optional[float] = None,
        conf: Optional[float] = None,
        display_every_n: Optional[int] = None,
    ) -> None:
        """
        Apply per-stream overrides. Rebuilds the calibrator and cluster
        ID tracker when their inputs change. The IoU tracker is
        intentionally not rebuilt -- it does not depend on any of these.
        """
        update: dict = {}
        if px_per_meter is not None:
            update["px_per_meter"] = max(float(px_per_meter), 1e-3)
        if dbscan_eps_px is not None:
            update["dbscan_eps_px"] = max(float(dbscan_eps_px), 10.0)
        if conf is not None:
            update["yolo_conf"] = min(max(float(conf), 0.05), 0.9)
        if display_every_n is not None:
            self.display_every_n = max(1, int(display_every_n))
        if update:
            self.cfg = self.cfg.model_copy(update=update)
            self.calibrator = Calibrator(self.cfg.px_per_meter)
            self.cluster_ids = ClusterIdTracker(self.cfg)
            logger.info(
                f"[{self.stream_id}] reconfigured: "
                f"px_per_meter={self.cfg.px_per_meter} "
                f"dbscan_eps_px={self.cfg.dbscan_eps_px} "
                f"yolo_conf={self.cfg.yolo_conf} "
                f"display_every_n={self.display_every_n}"
            )

_stream_states: dict[str, StreamAiState] = {}

def get_stream_state(stream_id: str) -> StreamAiState:
    if stream_id not in _stream_states:
        _stream_states[stream_id] = StreamAiState(cfg, stream_id)
    return _stream_states[stream_id]

# ---------------------------------------------------------------------
# Background task: fallback buffer flush
# ---------------------------------------------------------------------
async def fallback_flush_loop():
    while True:
        await asyncio.sleep(FALLBACK_FLUSH_INTERVAL_SECONDS)
        flushed = database.try_flush_fallback_buffer(SessionLocal)
        if flushed:
            logger.info(f"flushed {flushed} buffered detection(s) to the database")

@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=db_engine)
    flush_task = asyncio.create_task(fallback_flush_loop())
    try:
        yield
    finally:
        flush_task.cancel()

app = FastAPI(
    title="Crowd Safety Analyzer -- Backend",
    description=(
        "Receives individual frames from the frontend, runs the "
        "integrated AI pipeline (YOLO head detection, IoU tracking, "
        "DBSCAN clustering, zone assignment), applies per-zone "
        "danger classification, persists to Postgres, broadcasts "
        "live updates over WebSocket, and renders annotated frames."
    ),
    version="0.4.1",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------
# WebSocket connection manager (dashboard broadcast)
# ---------------------------------------------------------------------
class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: WSMessage) -> None:
        payload = message.model_dump(mode="json")
        dead_connections = []
        for connection in self.active_connections:
            try:
                await connection.send_json(payload)
            except Exception:
                dead_connections.append(connection)
        for connection in dead_connections:
            self.disconnect(connection)

manager = ConnectionManager()
event_trackers = alert_logic.EventTrackerRegistry()

# ---------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------
def _decode_frame(raw: bytes) -> Optional[np.ndarray]:
    arr = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return frame

def _is_alert_acknowledged(alert_id: int, db: Session) -> bool:
    alert = db.query(Alert).filter(Alert.id == alert_id).first()
    return bool(alert and (alert.user_acknowledged or alert.false_positive_flag))

async def _broadcast_alert(alert: Alert, event: str) -> None:
    payload = AlertOut.model_validate(alert).model_dump(mode="json")
    payload["event"] = event  # "new" | "continue" | "escalate"
    await manager.broadcast(WSMessage(type="alert", stream_id=alert.stream_id, data=payload))

def _persist_detection(record: dict, db: Session) -> Optional[int]:
    """Write a detection row; on DB failure, buffer it and return None."""
    try:
        detection = Detection(**record)
        db.add(detection)
        db.commit()
        db.refresh(detection)
        return detection.id
    except Exception:
        db.rollback()
        database.buffer_failed_detection(record)
        return None

def _detection_record(stream_id: str, result: dict, now: datetime) -> dict:
    """Build the kwargs for a Detection row from a pipeline result."""
    payload = result["payload"]
    return dict(
        stream_id=stream_id,
        frame_id=result["frame_id"],
        timestamp=now,
        person_count=payload["person_count"],
        directional_surge=payload["directional_surge"],
        zones=payload["zones"],
        clusters=payload["clusters"],
    )

def _run_pipeline_on_frame(state: StreamAiState, frame: np.ndarray) -> dict:
    """
    Runs detect -> track -> heatmap -> cluster -> zone on one frame.
    Returns frame_id, tracks, clusters, noise, zones, payload, w, h.
    Mutates per-stream state (tracker, cluster_ids, heatmap).
    """
    frame_id = state.next_frame_id()
    h, w = frame.shape[:2]
    dets = engine.infer([frame], conf=state.cfg.yolo_conf)[0]
    tracks = state.tracker.update(dets)
    state.heatmap.add_points([t.centroid for t in tracks], w, h)
    clusters, noise = cluster_tracks(tracks, state.cfg)
    clusters = state.cluster_ids.update(clusters)
    for c in clusters:
        compute_density(c, state.calibrator, state.cfg)
    zones = assign_zones(clusters, noise, state.cfg, w, h)
    payload = build_payload(state.stream_id, frame_id, clusters, tracks, w, h, zones)
    return {
        "frame_id": frame_id,
        "tracks": tracks,
        "clusters": clusters,
        "noise": noise,
        "zones": zones,
        "payload": payload,
        "w": w,
        "h": h,
    }

async def _fire_alerts_for_payload(
    stream_id: str,
    payload: dict,
    detection_id: Optional[int],
    db: Session,
) -> list[TriggeredAlert]:
    """
    Per-zone danger decision + event continuity for one frame's payload.
    Persists new/updated Alert rows, broadcasts them on /ws/dashboard,
    and returns the list of TriggeredAlert entries.

    Called by every frame-ingestion endpoint so alerts fire no matter
    which endpoint a frame came in through.
    """
    now = datetime.now(timezone.utc)
    triggered: list[TriggeredAlert] = []
    for zone in payload["zones"]:
        zone_clusters = [c for c in payload["clusters"] if c["location"] == zone["name"]]
        max_density = max((c["density"] for c in zone_clusters), default=0.0)
        decision = alert_logic.evaluate_zone(max_density)
        if decision.severity < alert_logic.ALERT_CREATION_THRESHOLD:
            continue

        tracker = event_trackers.get(stream_id, zone["name"])
        action = tracker.resolve(
            decision.severity,
            acknowledged_lookup=lambda aid: _is_alert_acknowledged(aid, db),
        )

        if action == "new":
            alert = Alert(
                stream_id=stream_id,
                location=zone["name"],
                timestamp=now,
                alert_level=decision.severity,
                alert_type=decision.severity_name,
                duration=0,
                user_acknowledged=False,
                false_positive_flag=False,
                source_detection_id=detection_id,
            )
            try:
                db.add(alert)
                db.commit()
                db.refresh(alert)
                tracker.set_active(alert.id)
                await _broadcast_alert(alert, event="new")
                triggered.append(TriggeredAlert(
                    alert_id=alert.id, stream_id=stream_id, location=zone["name"],
                    alert_level=alert.alert_level, alert_type=alert.alert_type,
                    event="new",
                ))
            except Exception:
                db.rollback()
                logger.warning(f"failed to persist new alert ({stream_id}/{zone['name']})")
        else:  # "continue" or "escalate"
            alert = db.query(Alert).filter(Alert.id == tracker.active_alert_id).first()
            if alert is None:
                continue
            alert.duration = tracker.elapsed_seconds()
            if action == "escalate":
                alert.alert_level = decision.severity
                alert.alert_type = decision.severity_name
            try:
                db.commit()
                db.refresh(alert)
                await _broadcast_alert(alert, event=action)
                triggered.append(TriggeredAlert(
                    alert_id=alert.id, stream_id=stream_id, location=zone["name"],
                    alert_level=alert.alert_level, alert_type=alert.alert_type,
                    event=action,
                ))
            except Exception:
                db.rollback()
                logger.warning(f"failed to update ongoing alert ({stream_id}/{zone['name']})")

    return triggered

def _render_annotated_jpeg(state: StreamAiState, frame: np.ndarray, result: dict) -> bytes:
    """Render one annotated frame (heatmap + grid + clusters + boxes + HUD)."""
    hud = [
        f"{state.stream_id}  frame={result['frame_id']}  people={len(result['tracks'])}",
        f"clusters={len(result['clusters'])}  indiv={len(result['noise'])}  "
        f"surge={sum(1 for c in result['clusters'] if c.surge)}",
    ]
    annotated = render_frame(
        frame.copy(),
        result["tracks"],
        result["clusters"],
        result["zones"],
        state.heatmap,
        state.cfg,
        hud,
    )
    return encode_jpeg(annotated, state.cfg.display_jpeg_quality)

def _apply_query_overrides(
    state: StreamAiState,
    conf: Optional[float],
    px_per_meter: Optional[float],
    dbscan_eps_px: Optional[float],
) -> None:
    """Apply ?conf= / ?px_per_meter= / ?dbscan_eps_px= overrides if present."""
    if conf is None and px_per_meter is None and dbscan_eps_px is None:
        return
    state.configure(px_per_meter=px_per_meter, dbscan_eps_px=dbscan_eps_px, conf=conf)

# ---------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------
@app.get("/")
def home():
    return {"message": "Crowd Safety Analyzer backend is running", "ai_engine": AI_ENGINE}

@app.get("/healthz")
def healthz():
    """Richer status: lists active streams and the selected AI engine."""
    return {
        "status": "ok",
        "ai_engine": AI_ENGINE,
        "streams": list(_stream_states.keys()),
    }

# ---------------------------------------------------------------------
# Frame ingestion -- JSON response
# ---------------------------------------------------------------------
@app.post("/streams/{stream_id}/frames", response_model=FrameProcessResult)
async def ingest_frame(
    stream_id: str,
    file: UploadFile = File(...),
    conf: Optional[float] = Query(None, ge=0.05, le=0.9),
    px_per_meter: Optional[float] = Query(None, gt=0),
    dbscan_eps_px: Optional[float] = Query(None, ge=10),
    db: Session = Depends(get_db),
):
    """
    Frame in, JSON metrics out. Accepts the same ?conf= / ?px_per_meter= /
    ?dbscan_eps_px= per-stream overrides as the annotated endpoints.
    """
    raw = await file.read()
    frame = _decode_frame(raw)
    if frame is None:
        raise HTTPException(status_code=422, detail="Could not decode uploaded image")

    state = get_stream_state(stream_id)
    _apply_query_overrides(state, conf, px_per_meter, dbscan_eps_px)

    result = _run_pipeline_on_frame(state, frame)
    payload = result["payload"]
    now = datetime.now(timezone.utc)
    detection_id = _persist_detection(_detection_record(stream_id, result, now), db)

    triggered = await _fire_alerts_for_payload(stream_id, payload, detection_id, db)

    zone_results: list[ZoneResult] = []
    for zone in payload["zones"]:
        zone_clusters = [c for c in payload["clusters"] if c["location"] == zone["name"]]
        max_density = max((c["density"] for c in zone_clusters), default=0.0)
        decision = alert_logic.evaluate_zone(max_density)
        zone_results.append(ZoneResult(
            **zone, severity=decision.severity, severity_name=decision.severity_name,
        ))

    response = FrameProcessResult(
        id=detection_id,
        stream_id=stream_id,
        frame_id=result["frame_id"],
        timestamp=now,
        person_count=payload["person_count"],
        directional_surge=payload["directional_surge"],
        zones=zone_results,
        clusters=[ClusterInfo(**c) for c in payload["clusters"]],
        alerts_triggered=triggered,
    )
    await manager.broadcast(WSMessage(
        type="frame_update", stream_id=stream_id,
        data=response.model_dump(mode="json"),
    ))
    return response

# ---------------------------------------------------------------------
# Annotated frame ingestion (single frame -> annotated JPEG)
# ---------------------------------------------------------------------
@app.post("/streams/{stream_id}/frames/annotated")
async def ingest_frame_annotated(
    stream_id: str,
    file: UploadFile = File(...),
    conf: Optional[float] = Query(None, ge=0.05, le=0.9, description="YOLO confidence override"),
    px_per_meter: Optional[float] = Query(None, gt=0, description="Pixels-per-meter override"),
    dbscan_eps_px: Optional[float] = Query(None, ge=10, description="DBSCAN eps (px) override"),
    db: Session = Depends(get_db),
):
    """
    Same pipeline as POST /streams/{stream_id}/frames, but returns the
    annotated frame (heatmap + 2x3 grid + cluster circles/labels +
    head boxes + HUD) as image/jpeg instead of JSON.

    Also persists the Detection row and fires per-zone alerts — same
    as the JSON endpoint, so both routes feed the alert system.
    """
    raw = await file.read()
    frame = _decode_frame(raw)
    if frame is None:
        raise HTTPException(status_code=422, detail="Could not decode uploaded image")

    state = get_stream_state(stream_id)
    _apply_query_overrides(state, conf, px_per_meter, dbscan_eps_px)

    result = _run_pipeline_on_frame(state, frame)
    now = datetime.now(timezone.utc)
    detection_id = _persist_detection(_detection_record(stream_id, result, now), db)
    await _fire_alerts_for_payload(stream_id, result["payload"], detection_id, db)

    jpeg = _render_annotated_jpeg(state, frame, result)
    return Response(content=jpeg, media_type="image/jpeg")

# ---------------------------------------------------------------------
# Annotated batch ingestion (N frames -> ONE annotated JPEG of the last frame)
# ---------------------------------------------------------------------
@app.post("/streams/{stream_id}/frames/batch/annotated")
async def ingest_frames_batch_annotated(
    stream_id: str,
    files: List[UploadFile] = File(..., description="One or more JPEG/PNG frames, processed in order"),
    conf: Optional[float] = Query(None, ge=0.05, le=0.9),
    px_per_meter: Optional[float] = Query(None, gt=0),
    dbscan_eps_px: Optional[float] = Query(None, ge=10),
    db: Session = Depends(get_db),
):
    """
    Accepts an ordered batch of frames (multipart, repeated `files`
    field). Feeds them through the per-stream pipeline in order so the
    tracker can confirm tracks (track_min_hits), then returns the
    annotated JPEG of the LAST frame in the batch.

    Every frame is persisted. Alerts are fired once, after the batch
    completes, using the last frame's result — so a 30-frame batch of
    the same scene doesn't produce 30 DB updates.

    Example (3 frames, one annotated image back):
        curl -X POST ".../streams/cam-1/frames/batch/annotated" \\
          -F "files=@f1.jpg" -F "files=@f2.jpg" -F "files=@f3.jpg" \\
          -o out.jpg
    """
    if not files:
        raise HTTPException(status_code=422, detail="No frames supplied")

    state = get_stream_state(stream_id)
    _apply_query_overrides(state, conf, px_per_meter, dbscan_eps_px)

    last_frame: Optional[np.ndarray] = None
    last_result: Optional[dict] = None
    last_detection_id: Optional[int] = None

    for upload in files:
        raw = await upload.read()
        frame = _decode_frame(raw)
        if frame is None:
            continue
        result = _run_pipeline_on_frame(state, frame)
        now = datetime.now(timezone.utc)
        detection_id = _persist_detection(_detection_record(stream_id, result, now), db)
        last_frame = frame
        last_result = result
        last_detection_id = detection_id

    if last_frame is None or last_result is None:
        raise HTTPException(status_code=422, detail="No decodable frames in batch")

    # Fire alerts once, using the last frame's payload.
    await _fire_alerts_for_payload(
        stream_id, last_result["payload"], last_detection_id, db,
    )

    jpeg = _render_annotated_jpeg(state, last_frame, last_result)
    return Response(content=jpeg, media_type="image/jpeg")

# ---------------------------------------------------------------------
# WebSocket ingest with live per-stream config
# ---------------------------------------------------------------------
@app.websocket("/ws/ingest/{stream_id}")
async def ws_ingest(
    websocket: WebSocket,
    stream_id: str,
    db: Session = Depends(get_db),
):
    """
    Bidirectional WS:
      client -> server : raw JPEG bytes, OR a JSON text message
                         {"type":"config", "px_per_meter":..., "dbscan_eps_px":...,
                          "conf":..., "display_every_n":...}
      server -> client : annotated JPEG bytes, one every display_every_n
                         received frames (default 3).

    Detection rows and alerts are persisted on the display cadence
    (not every frame), so a 15 fps stream doesn't hammer the DB.

    Independent from /ws/dashboard (which is a read-only broadcast of
    frame/alert updates for the React dashboard).
    """
    await websocket.accept()
    state = get_stream_state(stream_id)
    logger.info(f"WS ingest connected: {stream_id} from {websocket.client}")
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            raw = msg.get("bytes") or msg.get("text")
            if raw is None:
                continue

            jpeg_bytes: Optional[bytes] = None
            if isinstance(raw, str):
                try:
                    obj = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(obj, dict):
                    continue
                if obj.get("type") == "config":
                    state.configure(
                        px_per_meter=obj.get("px_per_meter"),
                        dbscan_eps_px=obj.get("dbscan_eps_px"),
                        conf=obj.get("conf"),
                        display_every_n=obj.get("display_every_n"),
                    )
                    continue
                if "image" in obj:
                    try:
                        jpeg_bytes = base64.b64decode(obj["image"])
                    except Exception:
                        continue
            else:
                jpeg_bytes = raw[4:] if not raw.startswith(b"\xff\xd8") else raw

            if jpeg_bytes is None:
                continue
            arr = np.frombuffer(jpeg_bytes, dtype=np.uint8)
            frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if frame is None:
                continue

            result = _run_pipeline_on_frame(state, frame)
            state._frames_since_display += 1
            if state._frames_since_display >= state.display_every_n:
                state._frames_since_display = 0

                now = datetime.now(timezone.utc)
                detection_id = _persist_detection(
                    _detection_record(stream_id, result, now), db,
                )
                await _fire_alerts_for_payload(
                    stream_id, result["payload"], detection_id, db,
                )

                jpeg = _render_annotated_jpeg(state, frame, result)
                await websocket.send_bytes(jpeg)

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception(f"WS ingest error on {stream_id}")
    finally:
        logger.info(f"WS ingest disconnected: {stream_id}")

# ---------------------------------------------------------------------
# Development simulator UI
# ---------------------------------------------------------------------
@app.get("/simulator")
def simulator():
    """Embedded multi-video simulator UI. Ported from Crowd_ai v3/pipeline.py."""
    return HTMLResponse(FRONTEND_HTML)

# ---------------------------------------------------------------------
# Detection retrieval
# ---------------------------------------------------------------------
@app.get("/detections/latest", response_model=DetectionOut)
def get_latest_detection(
    stream_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Detection)
    if stream_id:
        q = q.filter(Detection.stream_id == stream_id)
    detection = q.order_by(desc(Detection.timestamp)).first()
    if detection is None:
        raise HTTPException(status_code=404, detail="No detections recorded yet")
    return detection

@app.get("/detections", response_model=List[DetectionOut])
def get_detection_history(
    stream_id: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    q = db.query(Detection)
    if stream_id:
        q = q.filter(Detection.stream_id == stream_id)
    return q.order_by(desc(Detection.timestamp)).limit(limit).all()

# ---------------------------------------------------------------------
# Alert / event management
# ---------------------------------------------------------------------
@app.get("/alerts", response_model=List[AlertOut])
def get_alerts(
    stream_id: Optional[str] = None,
    location: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    q = db.query(Alert)
    if stream_id:
        q = q.filter(Alert.stream_id == stream_id)
    if location:
        q = q.filter(Alert.location == location)
    return q.order_by(desc(Alert.timestamp)).limit(limit).all()

@app.get("/alerts/active", response_model=List[AlertOut])
def get_active_alerts(
    stream_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = (
        db.query(Alert)
        .filter(Alert.user_acknowledged.is_(False))
        .filter(Alert.false_positive_flag.is_(False))
    )
    if stream_id:
        q = q.filter(Alert.stream_id == stream_id)
    return q.order_by(desc(Alert.timestamp)).all()

@app.patch("/alerts/{alert_id}/acknowledge", response_model=AlertOut)
def acknowledge_alert(
    alert_id: int,
    body: AlertAcknowledge = AlertAcknowledge(),
    db: Session = Depends(get_db),
):
    alert = db.query(Alert).filter(Alert.id == alert_id).first()
    if alert is None:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} not found")
    alert.user_acknowledged = True
    alert.false_positive_flag = body.false_positive
    try:
        db.commit()
        db.refresh(alert)
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to update alert")
    event_trackers.clear_if_active(alert.stream_id, alert.location, alert_id)
    return alert

@app.patch("/alerts/{alert_id}/response-team-arrived", response_model=AlertOut)
def mark_response_team_arrived(alert_id: int, db: Session = Depends(get_db)):
    alert = db.query(Alert).filter(Alert.id == alert_id).first()
    if alert is None:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} not found")
    alert.response_team_arrived_at = datetime.now(timezone.utc)
    try:
        db.commit()
        db.refresh(alert)
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to update alert")
    return alert

@app.patch("/alerts/{alert_id}/cleared", response_model=AlertOut)
def mark_cleared(alert_id: int, db: Session = Depends(get_db)):
    alert = db.query(Alert).filter(Alert.id == alert_id).first()
    if alert is None:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} not found")
    alert.cleared_at = datetime.now(timezone.utc)
    try:
        db.commit()
        db.refresh(alert)
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to update alert")
    event_trackers.clear_if_active(alert.stream_id, alert.location, alert_id)
    return alert

# ---------------------------------------------------------------------
# WebSocket -- live dashboard feed (read-only broadcast)
# ---------------------------------------------------------------------
@app.websocket("/ws/dashboard")
async def dashboard_socket(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

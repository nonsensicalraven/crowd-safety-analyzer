# Crowd Safety Analyzer

Real-time crowd-density monitoring for stampede-risk detection at large venues.

A video feed is processed by a YOLO-based head detector, tracks are grouped into crowds, crowds are assigned to a 2×3 grid of venue zones, and each zone receives a live density-based danger level (`LOW` / `MEDIUM` / `HIGH` / `CRITICAL`). Alerts persist to Postgres and stream to a React dashboard over WebSocket.

College GPP project. Working prototype, not production.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Endpoints](#endpoints)
- [How severity is decided](#how-severity-is-decided)
- [Configuration](#configuration)
- [Tech stack](#tech-stack)
- [Testing](#testing)
- [Development notes](#development-notes)
- [Known limitations](#known-limitations)

---

## What it does

Given frames (uploaded images, video playback, or WebSocket chunks) tagged with a `stream_id` identifying a physical camera, the system:

1. Decodes the frame and runs YOLOv8n head detection.
2. Matches detections to prior frames with a per-stream IoU tracker.
3. Groups nearby heads into crowds using DBSCAN.
4. Assigns each crowd to one of six zones: `top-left`, `top-center`, `top-right`, `bottom-left`, `bottom-center`, `bottom-right`.
5. Computes people-per-m² per cluster from its bounding box and a per-camera pixels-per-meter calibration.
6. Applies a density-only severity decision per zone.
7. Creates, continues, or escalates a single `Alert` row per ongoing `(stream_id, zone)` event — never one row per frame.
8. Persists every processed frame as a `Detection` row and any alert change to Postgres.
9. Broadcasts frame updates and alert changes on a WebSocket channel the dashboard subscribes to.
10. Optionally renders an annotated JPEG (heatmap + grid + cluster circles + head boxes + HUD) on demand.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend (React + Vite + TypeScript)                            │
│   Dashboard | Alert History | Replay | Settings | Local Video   │
└────────────────┬────────────────────────────────────────────────┘
                 │  POST /streams/{stream_id}/frames      (multipart)
                 │  WS   /ws/dashboard                    (read-only)
                 │  GET  /alerts, /alerts/active, /detections
                 │  PATCH /alerts/{id}/{acknowledge|response-team-arrived|cleared}
                 │
┌────────────────▼────────────────────────────────────────────────┐
│ Backend (FastAPI, single process)                               │
│                                                                 │
│   decode → YOLO → IoU track → DBSCAN cluster →                  │
│   zone assign → per-zone decision → event continuity →          │
│   persist Detection + Alert → broadcast /ws/dashboard           │
│                                                                 │
│   Per-stream state (in-memory): _stream_states[stream_id]       │
│   Per-(stream, zone) event trackers: EventTrackerRegistry       │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
        ┌────────────────────┐
        │ PostgreSQL (Neon)  │
        │  detections        │  one row per processed frame
        │  alerts            │  one row per ongoing event
        └────────────────────┘
```

The backend is intentionally single-process, single-worker. Per-stream AI state (trackers, heatmaps, event trackers) lives in memory; running uvicorn with more than one worker splits that state and breaks correctness.

---

## Repository layout

```
crowd-safety-analyzer/
├── backend/
│   ├── main.py           # all endpoints
│   ├── detection.py      # YOLO wrapper + IoU tracker
│   ├── analytics.py      # DBSCAN, zones, density, heatmap, rendering
│   ├── alert_logic.py    # per-zone severity + event continuity
│   ├── models.py         # SQLAlchemy ORM models
│   ├── schemas.py        # Pydantic request/response shapes
│   ├── database.py       # engine + session + fallback buffer
│   ├── config.py         # all tunables
│   ├── simulator.py      # embedded /simulator UI
│   ├── db_view.py        # read-only DB inspection menu
│   ├── load_test.py      # synthetic load test
│   ├── migration.sql     # drop + recreate tables (one-time)
│   ├── requirements.txt
│   ├── README.md         # detailed backend README
│   ├── SETUP.md          # full install instructions
│   ├── API.md            # endpoint reference with curl examples
│   ├── TESTING.md        # end-to-end test scenarios
│   └── FIXES.md          # integration bug changelog
│
└── frontend/
    ├── src/
    │   ├── components/   # HeatmapCanvas
    │   ├── context/      # CameraFeedContext
    │   ├── hooks/        # frameSender, useFrameSender, useDensityPoints
    │   ├── pages/        # Dashboard, AlertsPage, PostIncidentReplay,
    │   │                 # Settings, LocalVideoPage
    │   ├── schemas/      # zod schemas for backend payloads
    │   ├── types/        # shared TypeScript types
    │   ├── websocket/    # DensityFeedClient
    │   ├── router.tsx
    │   └── main.tsx
    ├── package.json
    └── vite.config.ts
```

---

## Quick start

### Prerequisites

- Python 3.10–3.13
- Node.js 18+
- PostgreSQL — a free [Neon](https://neon.tech) project works, or local
- Optional: NVIDIA GPU for real-time inference (CPU works, ~10× slower)

### Backend

```bash
cd backend
python -m venv venv
venv\Scripts\Activate.ps1        # Windows
# source venv/bin/activate       # Linux / macOS

pip install -r requirements.txt
# PyTorch — pick ONE:
#   pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124   # CUDA
#   pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu     # CPU
pip install ultralytics
```

Create `backend/.env`:

```env
DATABASE_URL=postgresql+psycopg://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require
AI_ENGINE=real
```

> `+psycopg` is required — this project uses psycopg v3, not psycopg2.

Run:

```bash
uvicorn main:app
```

> Do **not** use `--reload` on Windows. Uvicorn's file watcher spawns a child process that can crash PyTorch's CUDA init silently.

On first run, YOLO weights (`best.pt`, ~6 MB) are downloaded from Hugging Face and cached locally. Tables are auto-created on startup via `Base.metadata.create_all()` if they don't exist. If you have an older schema, run `migration.sql` once (destroys all rows).

Verify:

```bash
curl http://127.0.0.1:8000/healthz
# {"status":"ok","ai_engine":"real","streams":[]}
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173/`.

1. Click **Local Video** in the sidebar → pick a short `.mp4`.
2. Click **View on dashboard**.
3. Press play.

The dashboard uploads frames to the backend at ~2 fps; the live zone grid and alert board populate within a second or two.

---

## Endpoints

| Method | Path | Response | Purpose |
|---|---|---|---|
| GET   | `/` | JSON | Health check |
| GET   | `/healthz` | JSON | Status + active streams |
| POST  | `/streams/{stream_id}/frames` | JSON | Frame in, metrics out |
| POST  | `/streams/{stream_id}/frames/annotated` | JPEG | Frame in, annotated image out |
| POST  | `/streams/{stream_id}/frames/batch/annotated` | JPEG | N frames in, 1 annotated image out |
| WS    | `/ws/ingest/{stream_id}` | bidir | Streaming frames in, annotated images out |
| WS    | `/ws/dashboard` | out only | Live frame + alert broadcast |
| GET   | `/simulator` | HTML | Browser-based dev simulator |
| GET   | `/detections/latest` | JSON | Latest detection |
| GET   | `/detections` | JSON | Detection history |
| GET   | `/alerts` | JSON | Alert history |
| GET   | `/alerts/active` | JSON | Unacknowledged, non-false-positive alerts |
| PATCH | `/alerts/{id}/acknowledge` | JSON | Mark as seen (optional false-positive flag) |
| PATCH | `/alerts/{id}/response-team-arrived` | JSON | Set arrival timestamp |
| PATCH | `/alerts/{id}/cleared` | JSON | Set cleared timestamp, close event |

Per-stream query overrides accepted by all three frame endpoints (apply on first call, persist for that `stream_id`): `?conf=`, `?px_per_meter=`, `?dbscan_eps_px=`.

Full reference with curl examples: `backend/API.md`.

---

## How severity is decided

Danger is classified **per grid cell, per stream** — never globally, never per cluster ID.

| Condition (max cluster density in the zone) | Severity | Score |
|---|---|---|
| density > 7 people/m² | `CRITICAL` | 90 |
| density > 6 | `HIGH` | 75 |
| density > 5 | `MEDIUM` | 40 |
| otherwise | `LOW` | 10 |

Only `MEDIUM` and above generate or continue an `Alert` row.

Two signals — `directional_surge` and per-cluster `surge` — are stored and displayed, but are **not** inputs to the severity decision.

**Event continuity.** Repeated alert-worthy readings for the same `(stream_id, zone)` within a 20-second window are treated as one ongoing event. The first reading creates a row; subsequent readings either extend `duration` (`continue`) or raise severity (`escalate`). Acknowledging or clearing an alert closes the event so the next alert-worthy reading starts fresh.

---

## Configuration

All tunables live in `backend/config.py`, overridable via `.env` or per-stream via query parameters.

```python
yolo_conf: float = 0.25        # lower = more sensitive, more false positives
yolo_max_det: int = 2000       # raise if you hit the ceiling on dense images
yolo_imgsz: int = 832          # 640 on CPU or if VRAM is tight
track_min_hits: int = 1        # 1 = confirm on first frame (still-image friendly)
track_max_age: int = 5         # frames a track survives without a match
dbscan_eps_px: float = 80.0    # 30–40 for close-up crowds, 80+ for wide shots
px_per_meter: float = 100.0    # per-camera; placeholder for arbitrary images
display_every_n: int = 3       # 1 annotated frame sent per N received (WS ingest)
```

`px_per_meter` is a per-camera calibration constant. For a real camera, measure a known object's pixel width once and divide. For arbitrary uploaded images there is no correct value, so density numbers are relative, not absolute.

---

## Tech stack

**Backend**
- FastAPI + Uvicorn (single worker)
- SQLAlchemy 2 + psycopg 3 → PostgreSQL (Neon)
- Ultralytics YOLOv8n (`AmineSam/irail-crowd-counting-yolov8n`)
- OpenCV, scikit-learn (DBSCAN), NumPy
- Pydantic v2 + pydantic-settings
- loguru

**Frontend**
- React 18 + TypeScript
- Vite
- react-router-dom v7
- zod (runtime validation of every backend payload)
- reconnecting-websocket
- @deck.gl (heatmap rendering primitives)

---

## Testing

End-to-end test scenarios with expected outputs: `backend/TESTING.md`.

Quick sanity check after a fresh install, with the server running:

```bash
# Health
curl http://127.0.0.1:8000/

# JSON — sparse image (~198 people)
curl -X POST http://127.0.0.1:8000/streams/cam-1/frames \
  -F "file=@test/istockphoto.jpeg"

# Annotated JPEG — dense image (~1022 people)
curl -X POST http://127.0.0.1:8000/streams/cam-2/frames/annotated \
  -F "file=@test/images.jpeg" -o annotated.jpg

# Batch of 3 frames → 1 annotated image
curl -X POST http://127.0.0.1:8000/streams/cam-3/frames/batch/annotated \
  -F "files=@test/images.jpeg" \
  -F "files=@test/images.jpeg" \
  -F "files=@test/images.jpeg" \
  -o burst.jpg

# Alert list for one stream
curl "http://127.0.0.1:8000/alerts?stream_id=cam-1&limit=10"
```

Synthetic load test:

```bash
cd backend
python load_test.py --url http://127.0.0.1:8000 --requests 30 --concurrency 3
```

With `AI_ENGINE=stub` on the server, requests complete in ~30–60 ms. With `AI_ENGINE=real` on an RTX 2050, expect ~150–250 ms per request.

---

## Development notes

### Timestamps

The database stores naive UTC. Response serializers in `backend/schemas.py` attach an explicit UTC zone before serialization, so browsers parse them correctly and render in the user's local time. If you add a new response model with a datetime field, add a `@field_serializer` that calls the same `_as_utc_iso` helper.

### Rebuilding per-stream state

There's no endpoint to reset in-memory state. Restart uvicorn — one command, ~3 seconds.

### Resetting the database

```sql
-- Neon SQL Editor, or any Postgres client
DELETE FROM alerts;
DELETE FROM detections;
```

Clears history, keeps the schema. To recreate the tables from scratch, run `backend/migration.sql` instead (destroys all rows).

### CORS

Wide open (`allow_origins=["*"]`) for local development. Tighten before any real deployment.

---

## Known limitations

- **Single process, single worker.** Per-stream state is in-memory. `uvicorn --workers > 1` breaks correctness.
- **Single in-flight frame per process.** Every frame is processed synchronously in the request handler. Inference is ~150 ms on an RTX 2050 at `yolo_imgsz=832`, so effective throughput is ~6–7 fps total across all streams. Demo comfortably with 1–3 streams at 1–3 fps each.
- **One `stream_id` = one physical camera.** The tracker assumes consecutive frames are the same scene. Sending a different scene on the same `stream_id` produces mixed-tracker output for ~5 frames. Use a fresh `stream_id` per scene.
- **`px_per_meter` is a per-camera placeholder.** Default of `100` is a guess. Density numbers are internally consistent but not physically absolute unless each camera is calibrated.
- **Annotated rendering is diagnostic, not production art.** Draws every head box, cluster circle, heatmap blob, and grid line — visually noisy on dense crowds.
- **No authentication, CORS `allow_origins=["*"]`.** Fine for local demo, not for deployment.
- **Neon free tier auto-suspends** after ~5 minutes idle. First request after a pause takes ~1 second to wake up.
- **Timestamps** stored as naive UTC in Postgres. Response serializer attaches explicit UTC so browsers render correctly; without it, JS interprets them as local and shifts by the user's offset.

---

## License

College project. Not licensed for redistribution. Contact the authors before reuse.
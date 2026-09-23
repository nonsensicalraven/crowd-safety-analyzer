# Crowd Safety Analyzer — Merged Backend + AI Pipeline

One FastAPI application that ingests frames, runs the full AI pipeline
(YOLO head detection → IoU tracking → DBSCAN clustering → 2×3 zone
assignment), applies per-zone danger classification, persists to
Postgres, broadcasts live updates over WebSocket, and renders
annotated frames on demand.

No separate AI service. No network hop between AI processing and the
backend logic that consumes it. Everything runs in one process.

---

## What it does

Given a stream of frames (uploaded images, multipart batches, or
WebSocket chunks) tagged with a `stream_id` that identifies a
physical camera, the backend:

1. Decodes the JPEG/PNG bytes to a BGR frame
2. Runs YOLOv8n head detection (`detection.py`, tuned for crowded scenes)
3. Matches detections to prior frames with a greedy IoU tracker (per stream, in memory)
4. Groups nearby heads into crowds with DBSCAN (`analytics.py`)
5. Assigns each crowd to one of six grid cells — `top-left`, `top-center`, `top-right`, `bottom-left`, `bottom-center`, `bottom-right`
6. Computes people-per-square-meter per cluster from the cluster bounding box and a pixels-per-meter calibration constant
7. Applies a density-only severity decision per zone (`LOW` / `MEDIUM` / `HIGH` / `CRITICAL` — see `alert_logic.py`)
8. Creates, continues, or escalates an `Alert` row per `(stream_id, location)` event — never a new row per frame
9. Persists the frame's `Detection` row and any `Alert` change to Postgres
10. Broadcasts the frame update and any alert change on `/ws/dashboard`
11. Optionally renders an annotated JPEG (heatmap + grid + cluster circles + head boxes + HUD) and returns it to the caller

The pipeline is intentionally single-process and single-worker.
Correctness over throughput for this prototype.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend / test client                                          │
│   - React dashboard (Rema)    — subscribes /ws/dashboard        │
│   - Simulator UI              — /simulator                      │
│   - curl / scripts            — POST frames, GET alerts         │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 │  POST /streams/{stream_id}/frames
                 │  POST /streams/{stream_id}/frames/annotated
                 │  POST /streams/{stream_id}/frames/batch/annotated
                 │  WS   /ws/ingest/{stream_id}
                 │  WS   /ws/dashboard      (read-only broadcast)
                 │
┌────────────────▼────────────────────────────────────────────────┐
│ FastAPI app (main.py) — one process                             │
│                                                                 │
│   decode  →  YOLO  →  IoU track  →  DBSCAN cluster  →           │
│   zone assign  →  per-zone decision  →  event continuity  →     │
│   persist Detection + Alert  →  broadcast /ws/dashboard  →      │
│   (optional) render annotated JPEG                              │
│                                                                 │
│   Per-stream state kept in memory:                              │
│     _stream_states[stream_id] = StreamAiState                   │
│       .tracker      IouTracker                                  │
│       .cluster_ids  ClusterIdTracker                            │
│       .calibrator   Calibrator                                  │
│       .heatmap      Heatmap                                     │
│                                                                 │
│   Per-(stream, zone) event trackers:                            │
│     event_trackers = EventTrackerRegistry                       │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
        ┌────────────────────┐
        │ PostgreSQL (Neon)  │
        │  detections        │  one row per processed frame
        │  alerts            │  one row per ongoing event
        └────────────────────┘
```

---

## File structure

```
crowdctrl/
├── test/
│   ├── images.jpeg             # dense crowd test image (~1022 heads)
│   ├── istockphoto.jpeg        # milder crowd test image (~198 heads)
│   └── testvideo.mp4           # video for the simulator UI
│
├── .env                        # DATABASE_URL + AI_ENGINE (gitignored)
├── .gitignore
├── best.pt                     # YOLO weights, auto-downloaded (gitignored)
│
├── alert_logic.py              # severity decision + per-(stream,zone) continuity
├── analytics.py                # DBSCAN, zones, density, heatmap, rendering
├── config.py                   # all tunables
├── database.py                 # SQLAlchemy engine + fallback buffer
├── db_view.py                  # small read-only DB inspection menu
├── detection.py                # YOLO wrapper + IoU tracker
├── load_test.py                # synthetic load test for /streams/.../frames
├── main.py                     # FastAPI app, all endpoints
├── migration.sql               # drop + recreate tables (one-time)
├── models.py                   # Detection + Alert ORM models
├── schemas.py                  # Pydantic request/response shapes
├── simulator.py                # HTML for the multi-video simulator UI
├── stub_detector.py            # fake detector for backend-only testing
│
├── requirements.txt
└── README.md
```

Files that appear after a test run (safe to delete):

```
annotated.jpg     a1.jpg  a2.jpg  a3.jpg       # /frames/annotated outputs
burst.jpg         istock-burst.jpg             # /frames/batch/annotated outputs
```

---

## Quick start

Full install steps: assume venv is set up, torch + ultralytics
installed, `.env` configured, and Postgres tables created.

```powershell
# 1. Activate the venv
venv\Scripts\Activate.ps1

# 2. Start the server (single worker, no --reload on Windows)
uvicorn main:app

# 3. In a second terminal:
#    JSON response
curl.exe -X POST http://127.0.0.1:8000/streams/cam-1/frames -F "file=@test/istockphoto.jpeg"

#    Annotated JPEG response
curl.exe -X POST http://127.0.0.1:8000/streams/cam-k1/frames/annotated -F "file=@test/istockphoto.jpeg" -o annotated.jpg

#    Batch (3 frames → 1 annotated image)
curl.exe -X POST http://127.0.0.1:8000/streams/cam-k1/frames/batch/annotated -F "files=@test/istockphoto.jpeg" -F "files=@test/istockphoto.jpeg" -F "files=@test/istockphoto.jpeg" -o istock-burst.jpg

#    Another image on a different stream
curl.exe -X POST http://127.0.0.1:8000/streams/cam-k2/frames/batch/annotated -F "files=@test/images.jpeg" -F "files=@test/images.jpeg" -F "files=@test/images.jpeg" -o burst.jpg

# 4. Or open the simulator UI in a browser:
#    http://127.0.0.1:8000/simulator
```

The simulator UI loads videos from your local machine, streams them
to the backend over WebSocket, and shows annotated frames coming back
in real time. It's the closest thing to a live camera feed without a
camera.

---

## Endpoints at a glance

| Method | Path | Response | Purpose |
|---|---|---|---|
| GET  | `/` | JSON | Health check |
| GET  | `/healthz` | JSON | Status + active streams |
| POST | `/streams/{stream_id}/frames` | JSON | Frame in, metrics out |
| POST | `/streams/{stream_id}/frames/annotated` | image/jpeg | Frame in, annotated image out |
| POST | `/streams/{stream_id}/frames/batch/annotated` | image/jpeg | N frames in, 1 annotated image out |
| WS   | `/ws/ingest/{stream_id}` | bidir | Streaming frames in, annotated images out |
| WS   | `/ws/dashboard` | out only | Live frame + alert broadcast |
| GET  | `/simulator` | HTML | Browser simulator UI |
| GET  | `/detections/latest` | JSON | Latest detection |
| GET  | `/detections` | JSON | Detection history |
| GET  | `/alerts` | JSON | Alert history |
| GET  | `/alerts/active` | JSON | Unacknowledged, non-false-positive |
| PATCH | `/alerts/{id}/acknowledge` | JSON | Mark as seen / false positive |
| PATCH | `/alerts/{id}/response-team-arrived` | JSON | Set arrival timestamp |
| PATCH | `/alerts/{id}/cleared` | JSON | Set cleared timestamp, close event |

**Query overrides** (apply per-stream on first call, persist for
future calls on the same `stream_id`):

- `?conf=0.25` — YOLO confidence threshold (0.05–0.9)
- `?px_per_meter=100` — pixel-to-meter calibration for this camera
- `?dbscan_eps_px=80` — clustering distance threshold in pixels

---

## The simulator UI

`http://127.0.0.1:8000/simulator`

1. Put a video file (`.mp4` / `.webm`) anywhere reachable by the browser — e.g. `test/testvideo.mp4`.
2. Open the simulator URL.
3. Click **video files**, select the video.
4. On the panel that appears, set:
   - **stream id** — a name (e.g. `cam-sim-1`). Use a unique name per panel.
   - **send fps** — how often the browser grabs a frame. `3` is a good default. Don't go above `5` on an RTX 2050.
   - **max width** — downscale target. `640` is fine.
   - **px / metre** — leave at `100` unless you have a real calibration.
   - **cluster px** — DBSCAN eps. `80` default, `30–40` for close-up crowd shots.
   - **conf** — YOLO confidence. `0.25` default, `0.15` for more sensitivity, `0.4` for stricter.
   - **refresh every** — send one annotated frame back every N frames received. `3` matches the original design.
5. Click **▶ Start**.

Under the image:

- `out: N (x.x fps)` — frames the panel has sent
- `in: N (x.x fps)` — annotated frames the backend has sent back
- `ws: open | closed` — WebSocket connection state

**Never use the same `stream id` on two panels at once.** They share
the same in-memory tracker state, so their frames get interleaved and
both panels show garbage. Use a fresh `stream id` per panel.

**Stop before reloading or closing the tab.** Otherwise the old
WebSocket lingers server-side for a few seconds and the next
connection on the same stream id interleaves with it.

---

## Configuration highlights

All settings live in `config.py` and can be overridden via `.env` or
per-stream via the query parameters above.

The settings that matter most:

```python
# detector
yolo_conf: float = 0.25        # lower = more sensitive, higher = stricter
yolo_max_det: int = 2000       # raise if you hit the ceiling on dense images
yolo_imgsz: int = 832          # 640 on CPU or if VRAM is tight

# tracking
track_min_hits: int = 1        # 1 = confirm on first frame (still-image friendly)
                               # 3 = flicker suppression for live video
track_max_age: int = 5         # frames a track survives without a match

# clustering
dbscan_eps_px: float = 80.0    # 30-40 for close-up crowds, 80+ for wide shots
px_per_meter: float = 100.0    # per-camera; placeholder for arbitrary images

# WS ingest
display_every_n: int = 3       # 1 annotated frame sent back per N received
```

The two settings that surprise people most:

- **`track_min_hits`** — with `1`, frame 1 of any stream returns a real count. With `3` (the original default), frames 1 and 2 return 0.
- **`px_per_meter`** — a per-camera calibration constant. For a real camera, measure a known object's pixel width once and divide. For arbitrary uploaded images there's no correct value, so density numbers are relative, not absolute.

---

## Known limitations

- **Single-process, single-worker.** Per-stream AI state, heatmaps, and event trackers live in process memory. Running uvicorn with `--workers N > 1` splits state across processes and produces garbage. Always run with a single worker.

- **Single in-flight frame per process.** Every frame is processed synchronously in the request handler. Inference takes ~150 ms on an RTX 2050 at `yolo_imgsz=832`; batched across multiple streams the effective throughput is roughly 6–7 fps total. Demo comfortably with 1–3 streams at 1–3 fps each.

- **One `stream_id` = one physical camera.** The tracker assumes consecutive frames are the same scene. Sending a different scene on the same `stream_id` (swapping images, changing videos on one simulator panel) will produce mixed-tracker output for ~5 frames. Use a fresh `stream_id` per scene.

- **`px_per_meter` is a per-camera placeholder.** The default of `100` is a guess. Density numbers are internally consistent (higher → denser) but not physically absolute unless you calibrate each camera. In a demo, note this if anyone asks why `images.jpeg` reports ~28 p/m².

- **The annotated rendering is a diagnostic, not production art.** It draws every head box, cluster circle, heatmap blob, and grid line, which is fine for a demo but visually noisy on dense crowds. There's no per-element toggle at request time (only in `config.py`).

- **No authentication, wide-open CORS.** `allow_origins=["*"]` and no auth on any endpoint. Fine for a local demo, not for deployment.

- **`dbscan_eps_px=80` merges dense close-up crowds into one cluster.** For `test/images.jpeg`, all ~1022 heads land in a single cluster. To see segmentation, pass `?dbscan_eps_px=30` on the first request to a fresh stream and compare.

---

## What the frontend team needs to know

- **The existing `/streams/{stream_id}/frames` JSON endpoint is unchanged.** If Rema's React dashboard was working against the previous version, it still works.

- **To show an annotated image**, either:
  - POST to `/frames/annotated` and swap the returned JPEG into an `<img>`, or
  - Subscribe to `/ws/ingest/{stream_id}`, stream frames, and swap the received JPEGs into an `<img>` as they arrive.

- **`/ws/dashboard`** carries both `frame_update` and `alert` messages, each tagged with `stream_id`. One connection per dashboard is enough; route by the `stream_id` field, not by opening one socket per camera.

- **All `/detections/*` and `/alerts/*` REST endpoints are unchanged** and continue to work exactly as before.

- **CORS is wide open** for development. Flag this before any real deployment.
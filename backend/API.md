# API Reference

Complete endpoint documentation with request/response examples.

Base URL for local development:

```
http://127.0.0.1:8000
```

All `curl.exe` examples assume Windows PowerShell and the project root as the working directory. Replace `curl.exe` with `curl` on Linux/macOS.

---

## Table of contents

- [Health and status](#health-and-status)
- [Frame ingestion — JSON](#frame-ingestion--json)
- [Frame ingestion — annotated JPEG](#frame-ingestion--annotated-jpeg)
- [Frame ingestion — annotated batch](#frame-ingestion--annotated-batch)
- [Frame ingestion — WebSocket](#frame-ingestion--websocket)
- [Detection history](#detection-history)
- [Alerts and events](#alerts-and-events)
- [WebSocket — dashboard broadcast](#websocket--dashboard-broadcast)
- [Simulator UI](#simulator-ui)
- [Query parameters](#query-parameters)

---

## Health and status

### `GET /`

Backend reachability + selected AI engine.

```powershell
curl.exe http://127.0.0.1:8000/
```

```json
{
  "message": "Crowd Safety Analyzer backend is running",
  "ai_engine": "real"
}
```

### `GET /healthz`

Richer status — lists every stream_id with in-memory state.

```powershell
curl.exe http://127.0.0.1:8000/healthz
```

```json
{
  "status": "ok",
  "ai_engine": "real",
  "streams": ["cam-1", "cam-2", "cam-k1"]
}
```

Note: `streams` accumulates over the life of the process. A stream that finished its video still shows up here until you restart.

---

## Frame ingestion — JSON

### `POST /streams/{stream_id}/frames`

The main endpoint. One frame in, metrics JSON out. Also persists a Detection row, fires any per-zone alerts, and broadcasts on `/ws/dashboard`.

**Request** — `multipart/form-data`, one field named `file`.

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/cam-1/frames -F "file=@test/istockphoto.jpeg"
```

**Response** — `FrameProcessResult`:

```json
{
  "id": 42,
  "stream_id": "cam-1",
  "frame_id": 1,
  "timestamp": "2026-09-22T17:07:51.434128Z",
  "person_count": 198,
  "directional_surge": false,
  "zones": [
    {
      "name": "top-left",
      "cluster_count": 0,
      "person_count": 0,
      "individuals": 0,
      "severity": 10,
      "severity_name": "LOW"
    },
    {
      "name": "top-center",
      "cluster_count": 0,
      "person_count": 0,
      "individuals": 0,
      "severity": 10,
      "severity_name": "LOW"
    },
    {
      "name": "top-right",
      "cluster_count": 1,
      "person_count": 197,
      "individuals": 0,
      "severity": 75,
      "severity_name": "HIGH"
    },
    {
      "name": "bottom-left",
      "cluster_count": 0,
      "person_count": 0,
      "individuals": 0,
      "severity": 10,
      "severity_name": "LOW"
    },
    {
      "name": "bottom-center",
      "cluster_count": 0,
      "person_count": 0,
      "individuals": 0,
      "severity": 10,
      "severity_name": "LOW"
    },
    {
      "name": "bottom-right",
      "cluster_count": 0,
      "person_count": 1,
      "individuals": 1,
      "severity": 10,
      "severity_name": "LOW"
    }
  ],
  "clusters": [
    {
      "cluster_id": 1,
      "person_count": 197,
      "density": 6.103,
      "location": "top-right",
      "surge": false
    }
  ],
  "alerts_triggered": [
    {
      "alert_id": 12,
      "stream_id": "cam-1",
      "location": "top-right",
      "alert_level": 75,
      "alert_type": "HIGH",
      "event": "new"
    }
  ]
}
```

**`person_count: 0` on frame 1** is expected only if `track_min_hits` is set to 3. The shipped `config.py` uses `1`, so a real count appears immediately.

**422** if the uploaded bytes aren't a decodable image.

---

## Frame ingestion — annotated JPEG

### `POST /streams/{stream_id}/frames/annotated`

Same pipeline as the JSON endpoint, but returns an annotated JPEG instead of JSON. Persists a Detection row and fires alerts too, so this endpoint and the JSON one are interchangeable for the backend side.

**Request** — `multipart/form-data`, one field `file`.

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/cam-k1/frames/annotated -F "file=@test/istockphoto.jpeg" -o annotated.jpg
```

**Response** — `image/jpeg` with the following drawn on the frame:

- translucent heatmap (JET colormap) over the densest regions
- white 2×3 zone grid lines
- per-zone labels at each cell's top-left: `name C:n P:n`
- green 1-px bounding box around each detected head
- red 2-px circle at each cluster centroid, labeled `#id Np X.Y/m2`
- arrow from centroid in direction of motion (red = surge)
- HUD text at the bottom-left:
  ```
  <stream_id>  frame=N  people=N
  clusters=N  indiv=N  surge=N
  ```

**422** if the uploaded bytes aren't a decodable image.

---

## Frame ingestion — annotated batch

### `POST /streams/{stream_id}/frames/batch/annotated`

Accepts N frames in order. Runs each through the per-stream pipeline so the tracker accumulates hits, persists every frame as a Detection, fires alerts **once** using the last frame's payload, and returns the annotated JPEG of the last frame.

**Request** — `multipart/form-data`, repeated field `files`.

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/cam-k1/frames/batch/annotated -F "files=@test/istockphoto.jpeg" -F "files=@test/istockphoto.jpeg" -F "files=@test/istockphoto.jpeg" -o istock-burst.jpg
```

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/cam-k2/frames/batch/annotated -F "files=@test/images.jpeg" -F "files=@test/images.jpeg" -F "files=@test/images.jpeg" -o burst.jpg
```

**Response** — `image/jpeg` of the last frame in the batch, with the full overlay.

**422** if no frames are supplied or none decode.

**Why batch instead of three sequential annotated calls?** Because the tracker needs `track_min_hits` consecutive frames to confirm tracks. Sending three files in one multipart request guarantees they arrive in order on the same stream; the tracker will have confirmed tracks by frame 3. Three separate HTTP requests work too, but the batch form is one round-trip instead of three.

---

## Frame ingestion — WebSocket

### `WS /ws/ingest/{stream_id}`

Bidirectional. Client sends raw JPEG bytes; server sends back an annotated JPEG every `display_every_n` frames received.

**Opening a connection**

JavaScript:

```javascript
const ws = new WebSocket("ws://127.0.0.1:8000/ws/ingest/cam-1");
ws.binaryType = "blob";
ws.onmessage = (e) => {
  const url = URL.createObjectURL(e.data);
  document.querySelector("img").src = url;
};
```

**Optional config message** — sent as a JSON text frame:

```json
{
  "type": "config",
  "px_per_meter": 100,
  "dbscan_eps_px": 80,
  "conf": 0.25,
  "display_every_n": 3
}
```

All fields optional. Applied to the stream's `StreamAiState` immediately.

**Per-frame data** — send raw JPEG bytes as a binary WebSocket frame:

```javascript
canvas.toBlob((blob) => ws.send(blob), "image/jpeg", 0.7);
```

Alternatively, send a JSON text message `{"image": "<base64>"}`. Slower for large frames; use binary.

**Server response** — a raw JPEG binary frame, every `display_every_n` received frames. Same overlay as the annotated endpoint.

**Alerts and persistence** — fired on the display cadence, not per-frame. A 15 fps stream producing 3 alerts/sec only writes ~1 alert update per second at `display_every_n=3`. This is intentional.

**Disconnect** — either side can close the socket. The server does not clear `_stream_states[stream_id]` on disconnect; restart uvicorn to clear state.

---

## Detection history

### `GET /detections/latest`

```powershell
curl.exe "http://127.0.0.1:8000/detections/latest?stream_id=cam-1"
```

Optional `stream_id` query parameter. Omit for the latest detection across all streams.

**404** if no detections have been recorded.

### `GET /detections`

```powershell
curl.exe "http://127.0.0.1:8000/detections?stream_id=cam-1&limit=50"
```

- `stream_id` — optional filter
- `limit` — 1–500 (default 50)

Returns a list of `DetectionOut`. Same shape as `FrameProcessResult` minus `alerts_triggered`.

---

## Alerts and events

### `GET /alerts`

```powershell
curl.exe "http://127.0.0.1:8000/alerts?stream_id=cam-1&limit=20"
```

- `stream_id` — optional
- `location` — optional, one of the six zone names
- `limit` — 1–500 (default 50)

### `GET /alerts/active`

```powershell
curl.exe "http://127.0.0.1:8000/alerts/active?stream_id=cam-1"
```

Unacknowledged and non-false-positive alerts only.

### `PATCH /alerts/{id}/acknowledge`

Marks an alert as seen. Optional body marks it as a false positive, which removes it from `/alerts/active` and clears its event tracker so the next alert-worthy reading on that `(stream, zone)` starts a fresh row.

```powershell
curl.exe -X PATCH http://127.0.0.1:8000/alerts/12/acknowledge -H "Content-Type: application/json" -d "{\"false_positive\": false}"
```

Body default is `{"false_positive": false}` if omitted.

### `PATCH /alerts/{id}/response-team-arrived`

```powershell
curl.exe -X PATCH http://127.0.0.1:8000/alerts/12/response-team-arrived
```

Sets `response_team_arrived_at` to the current UTC timestamp.

### `PATCH /alerts/{id}/cleared`

```powershell
curl.exe -X PATCH http://127.0.0.1:8000/alerts/12/cleared
```

Sets `cleared_at` and clears the event tracker so a new alert-worthy reading starts fresh.

### `AlertOut` shape (all four endpoints return this)

```json
{
  "id": 12,
  "stream_id": "cam-1",
  "location": "top-right",
  "timestamp": "2026-09-22T17:07:51.434128Z",
  "alert_level": 75,
  "alert_type": "HIGH",
  "duration": 42,
  "user_acknowledged": false,
  "false_positive_flag": false,
  "response_team_arrived_at": null,
  "cleared_at": null,
  "source_detection_id": 38
}
```

**404** on any PATCH if the alert id doesn't exist.

---

## WebSocket — dashboard broadcast

### `WS /ws/dashboard`

Read-only broadcast feed. Open the socket, receive JSON messages. No config, no input expected.

```javascript
const ws = new WebSocket("ws://127.0.0.1:8000/ws/dashboard");
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  // msg.type is "frame_update" or "alert"
  // msg.stream_id tells you which camera
  // msg.data holds the payload
};
```

**`frame_update`** — sent after every processed frame from every ingest endpoint. `data` is a `FrameProcessResult`.

**`alert`** — sent when an alert is created, continued, or escalated. `data` is an `AlertOut` plus an `event` field:

- `"new"` — first alert-worthy reading for this `(stream, zone)`
- `"continue"` — same or lower severity within the continuity window
- `"escalate"` — higher severity within the continuity window

One connection per dashboard. Route messages to the correct panel using the `stream_id` field, not by opening a separate socket per camera.

---

## Simulator UI

### `GET /simulator`

Returns the multi-video simulator as HTML.

```
http://127.0.0.1:8000/simulator
```

Select one or more local video files, click **▶ Start** on each panel. The panel opens a WebSocket to `/ws/ingest/{stream_id}`, streams frames, and displays the annotated frames it receives back.

**Never use the same `stream_id` on two panels at once.**

---

## Query parameters

The following query parameters are accepted by the three HTTP frame endpoints (`/frames`, `/frames/annotated`, `/frames/batch/annotated`). Applied per-stream the first time they're passed; persisted for future requests on the same `stream_id`.

| Param           | Range      | Effect                                                                                |
| --------------- | ---------- | ------------------------------------------------------------------------------------- |
| `conf`          | 0.05 – 0.9 | YOLO detection confidence threshold. Lower = more sensitive, more false positives.    |
| `px_per_meter`  | > 0        | Pixel-to-meter scale for this camera. Affects density numbers only.                   |
| `dbscan_eps_px` | ≥ 10       | Clustering distance. Lower = more, smaller clusters. Higher = fewer, bigger clusters. |

Example — a close-up crowd image where you want finer clusters and more sensitive detection:

```powershell
curl.exe -X POST "http://127.0.0.1:8000/streams/cam-tuned/frames/annotated?conf=0.15&dbscan_eps_px=30" -F "file=@test/images.jpeg" -o tuned.jpg
```

The same values can be set over WebSocket via a `{"type":"config", ...}` text message (see the WebSocket section above).

Overrides take effect on the stream when the request arrives. To reset a stream to defaults, restart the server, or use a new `stream_id`.

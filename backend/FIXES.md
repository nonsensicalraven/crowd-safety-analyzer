# Fixes applied

## 1. Alerts were only firing on one of four endpoints

**Before:** `POST /streams/{stream_id}/frames` ran `alert_logic.evaluate_zone`
inline and fired alerts + WS broadcasts. The other three endpoints
(`/frames/annotated`, `/frames/batch/annotated`, `WS /ws/ingest/...`)
skipped the alert logic entirely — they ran the pipeline and persisted
a Detection, but never created or updated Alert rows.

Practical consequence: driving frames through the simulator UI or the
batch endpoint meant the dashboard saw `frame_update` broadcasts but
never any `alert` broadcasts, and `/alerts/active` stayed empty even
when a zone was CRITICAL.

**After:** extracted the per-zone decision + event continuity + DB
write + broadcast into `_fire_alerts_for_payload()`. All four
endpoints call it. Behavior is now identical regardless of which
endpoint the frame came in through.

For the batch endpoint specifically, alerts fire *once* after the loop
completes, using the last frame's payload — a 30-frame batch doesn't
produce 30 DB updates.

For the WS ingest endpoint, alerts fire on the display cadence (one
per `display_every_n` frames) — a 15 fps stream doesn't hammer the DB
with 15 alert updates per second.

## 2. `track_min_hits` changed from 3 to 1

**Before:** `track_min_hits: int = 3`. Frames 1 and 2 of any stream
always reported `person_count: 0`, because the IoU tracker waits for
3 consecutive hits before confirming a track.

Practical consequence: single-image uploads returned 0 people
(confirmed by your `a1.jpg` / `a2.jpg` tests). The batch endpoint
worked around this by feeding 3 frames in order, but the single-frame
and JSON endpoints didn't.

**After:** `track_min_hits: int = 1`. A track is confirmed on its
first hit, so frame 1 of a stream produces a real count.

Trade-off: on continuous video, `min_hits=1` lets single-frame false
positives through, which shows up as flicker in the person count.
For a still-image demo that's fine. For a live feed, set it back to 3
(and rely on the batch endpoint or send 3+ frames before reading the
count).

## 3. JSON endpoint now accepts the same query overrides

**Before:** `POST /streams/{stream_id}/frames` had no query parameters.
The only way to change `conf`, `px_per_meter`, or `dbscan_eps_px` for
a stream was to use one of the annotated endpoints first.

**After:** the JSON endpoint accepts `?conf=`, `?px_per_meter=`,
`?dbscan_eps_px=` — same semantics as the annotated endpoints. Applied
per-stream on first call and persisted for future calls on the same
`stream_id`.

## 4. WS ingest gets a DB session

**Before:** `ws_ingest` had no `db` parameter, so it couldn't persist
Detections or create Alerts even if it wanted to.

**After:** `ws_ingest` takes `db: Session = Depends(get_db)` and
persists + alerts on the display cadence.

## Files changed

- `main.py` — added `_fire_alerts_for_payload`, `_detection_record`
  helpers; refactored all four frame endpoints to use them; added
  query overrides to the JSON endpoint; added `db` dependency to WS
  ingest.
- `config.py` — `track_min_hits` default changed from 3 to 1.

## Files unchanged

`analytics.py`, `detection.py`, `database.py`, `models.py`,
`schemas.py`, `alert_logic.py`, `stub_detector.py`, `load_test.py`,
`migration.sql`, `requirements.txt`, `.gitignore`, `simulator.py`,
`README.md`.

## Testing checklist after swapping in these files

```

# Restart uvicorn (Ctrl+C, then):

uvicorn main:app

# 1. JSON endpoint — should now show people on frame 1

curl.exe -X POST http://127.0.0.1:8000/streams/t1/frames -F "file=@test/istockphoto.jpeg"

# Expect person_count ~198, not 0

# 2. JSON endpoint with override

curl.exe -X POST "http://127.0.0.1:8000/streams/t2/frames?conf=0.15" -F "file=@test/istockphoto.jpeg"

# Expect count slightly higher than default (lower conf = more detections)

# 3. Annotated single frame — should now fire alerts

curl.exe -X POST http://127.0.0.1:8000/streams/t3/frames/annotated -F "file=@test/images.jpeg" -o a.jpg
curl.exe http://127.0.0.1:8000/alerts/active?stream_id=t3

# Expect at least 1 CRITICAL alert row

# 4. Batch endpoint — should fire 1 alert, not 3

curl.exe -X POST http://127.0.0.1:8000/streams/t4/frames/batch/annotated -F "files=@test/images.jpeg" -F "files=@test/images.jpeg" -F "files=@test/images.jpeg" -o b.jpg
curl.exe http://127.0.0.1:8000/alerts?stream_id=t4

# Expect exactly 1 alert row

# 5. WS ingest — alerts on display cadence

# Open http://127.0.0.1:8000/simulator in a browser, stream a video

# for ~10 seconds, then check:

curl.exe http://127.0.0.1:8000/alerts/active

# Expect alerts to be present for the stream id you set on the panel

```


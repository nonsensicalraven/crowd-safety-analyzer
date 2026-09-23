# Testing

End-to-end test scenarios for the backend. Run through these in order after a fresh install to confirm the full pipeline works.

Prerequisites:

- Server running (`uvicorn main:app`) in one terminal
- This project folder as the working directory in a second terminal
- `test/images.jpeg` and `test/istockphoto.jpeg` present
- `track_min_hits = 1` in `config.py` (shipped default)

---

## 1. Health check

```powershell
curl.exe http://127.0.0.1:8000/
curl.exe http://127.0.0.1:8000/healthz
```

Expected:

- `/` returns `{"message": "...", "ai_engine": "real"}`
- `/healthz` returns `{"status": "ok", "ai_engine": "real", "streams": []}` (empty until you send a frame)

**If `/` fails with "connection refused":** server isn't running. Check the first terminal.

---

## 2. JSON endpoint — sparse image

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/test-json/frames -F "file=@test/istockphoto.jpeg"
```

Expected:

- `id` — a fresh DB row id
- `frame_id: 1`
- `person_count` around **198** (within ±10 with default settings)
- `zones[2]` (top-right) has `cluster_count: 1`, `person_count` around 197, `severity: 75`, `severity_name: "HIGH"`
- `alerts_triggered` contains one entry with `alert_type: "HIGH"` and `event: "new"`

**If `person_count` is 0:** check `track_min_hits` in `config.py`. It should be `1` for this test.

---

## 3. JSON endpoint — dense image

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/test-dense/frames -F "file=@test/images.jpeg"
```

Expected:

- `person_count` around **1022**
- One cluster (top-left or top-right depending on the image)
- `severity_name: "CRITICAL"`

**If `person_count` is stuck at exactly 500:** check `yolo_max_det` in `config.py`. The default is `2000`; the original `300` capped this image.

---

## 4. Annotated endpoint

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/test-annot/frames/annotated -F "file=@test/istockphoto.jpeg" -o annotated.jpg
```

Then open `annotated.jpg` in an image viewer.

You should see:

- 2×3 white grid lines over the image
- Green 1-px boxes around each detected head
- A red 2-px circle at the cluster centroid, labeled `#1 197p 6.1/m2`
- A translucent heatmap tint (blue/cyan/yellow/red gradient) over the cluster
- HUD text at bottom-left: `test-annot frame=1 people=198` and `clusters=1 indiv=1 surge=0`

**If you only see grid lines and no boxes:** the tracker didn't confirm any tracks. Check that `track_min_hits = 1`.

---

## 5. Batch endpoint — three frames, one image

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/test-batch-istock/frames/batch/annotated -F "files=@test/istockphoto.jpeg" -F "files=@test/istockphoto.jpeg" -F "files=@test/istockphoto.jpeg" -o istock-burst.jpg
```

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/test-batch-dense/frames/batch/annotated -F "files=@test/images.jpeg" -F "files=@test/images.jpeg" -F "files=@test/images.jpeg" -o burst.jpg
```

Open both output files.

- `istock-burst.jpg` — same overlay as the annotated test, `frame=3 people=198`
- `burst.jpg` — much denser overlay, `frame=3 people=1022`, one large cluster

The batch is one HTTP round-trip that produces three Detection rows in the DB but only one rendered image (of the last frame).

---

## 6. Verify alerts are firing from all endpoints

This confirms the fix described in `FIXES.md`. Before the fix, only the JSON endpoint fired alerts. Now all four endpoints do.

```powershell
curl.exe "http://127.0.0.1:8000/alerts?stream_id=test-json&limit=5"
curl.exe "http://127.0.0.1:8000/alerts?stream_id=test-annot&limit=5"
curl.exe "http://127.0.0.1:8000/alerts?stream_id=test-batch-istock&limit=5"
```

Each should return at least one alert row.

The batch stream should have **exactly one** alert row even though three frames were processed — alerts fire once per batch, using the last frame.

---

## 7. Query overrides

### conf — lower is more sensitive

```powershell
curl.exe -X POST "http://127.0.0.1:8000/streams/test-conf/frames?conf=0.15" -F "file=@test/istockphoto.jpeg"
```

Compare `person_count` to the default `conf=0.25` result. Should be higher with `conf=0.15`.

Then send again on the same stream to confirm the override persisted:

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/test-conf/frames -F "file=@test/istockphoto.jpeg"
```

Same count as the overridden call — the override sticks.

### dbscan_eps_px — tighter clustering

```powershell
curl.exe -X POST "http://127.0.0.1:8000/streams/test-eps/frames/annotated?dbscan_eps_px=30" -F "file=@test/images.jpeg" -o eps30.jpg
```

Open `eps30.jpg`. On the dense image, `eps=30` should break the single giant cluster into multiple smaller circles, each with its own `#id Np X.Y/m2` label. Compare with `burst.jpg` from test 5.

### px_per_meter — density scaling

```powershell
curl.exe -X POST "http://127.0.0.1:8000/streams/test-ppm/frames?px_per_meter=200" -F "file=@test/istockphoto.jpeg"
```

`density` in the JSON response should be roughly **quarter** of the default (since area scales with the square of the pixel-to-meter factor).

---

## 8. Alert lifecycle

Send a fresh alert-worthy frame, capture its alert id, then walk it through acknowledge → response-team-arrived → cleared.

```powershell
# Step 1 — trigger an alert
curl.exe -X POST http://127.0.0.1:8000/streams/test-life/frames -F "file=@test/images.jpeg"
# Note the alert_id from the response

# Step 2 — confirm it's active
curl.exe "http://127.0.0.1:8000/alerts/active?stream_id=test-life"

# Step 3 — acknowledge it (replace 999 with the actual id)
curl.exe -X PATCH http://127.0.0.1:8000/alerts/999/acknowledge -H "Content-Type: application/json" -d "{\"false_positive\": false}"

# Step 4 — confirm it's no longer active
curl.exe "http://127.0.0.1:8000/alerts/active?stream_id=test-life"

# Step 5 — mark response team arrived
curl.exe -X PATCH http://127.0.0.1:8000/alerts/999/response-team-arrived

# Step 6 — clear it
curl.exe -X PATCH http://127.0.0.1:8000/alerts/999/cleared

# Step 7 — 404 on a nonexistent alert
curl.exe -X PATCH http://127.0.0.1:8000/alerts/99999/cleared
# Expected: HTTP 404
```

After step 3, the next alert-worthy reading on `(test-life, <zone>)` should start a **fresh** alert row, not continue the acknowledged one. Send another frame on `test-life` and confirm a new `alert_id` appears.

---

## 9. Invalid image handling

```powershell
# Create a file that isn't an image
"not an image" | Out-File -Encoding ascii fake.jpg
curl.exe -X POST http://127.0.0.1:8000/streams/test-bad/frames -F "file=@fake.jpg"
```

Expected: HTTP **422** with body `{"detail": "Could not decode uploaded image"}`.

No Detection row is created for a 422. No alert. No DB pollution.

---

## 10. WebSocket ingest via the simulator UI

1. Put `test/testvideo.mp4` in the `test/` folder.
2. Open http://127.0.0.1:8000/simulator in a browser.
3. Click **video files**, select `test/testvideo.mp4`.
4. Leave **stream id** as `cam-1`, **send fps** as `3`, others at defaults.
5. Click **▶ Start**.

Under the image:

- `out:` counter starts climbing at ~3 per second
- `in:` counter starts climbing at ~1 per second (because `display_every_n=3`)
- `ws: open`

Watch the annotated image update in the box.

Verify the stream registered:

```powershell
curl.exe http://127.0.0.1:8000/healthz
# "streams" array should contain "cam-1"
```

Verify data was persisted:

```powershell
curl.exe "http://127.0.0.1:8000/detections?stream_id=cam-1&limit=5"
curl.exe "http://127.0.0.1:8000/alerts?stream_id=cam-1&limit=5"
```

**If `out:` climbs but `in:` stays at 0:** the WebSocket is being throttled by a backgrounded browser tab. Bring the tab to the foreground.

**If both counters stay at 0:** the WebSocket failed. Check the browser console (F12) for an error. Confirm the `ws base url` field in the simulator header is `ws://127.0.0.1:8000/ws/ingest`.

Click **⏹ Stop** before closing the tab or reloading. Otherwise the next connection on the same `stream_id` will interleave with the old one for a few seconds.

---

## 11. Database inspection

```powershell
python db_view.py
```

Run each menu option in order:

1. **Table row counts** — both `detections` and `alerts` should have non-zero counts after the tests above.
2. **Latest 10 detections** — should show the streams you used (`test-json`, `test-annot`, `cam-1`, ...).
3. **Latest 10 alerts** — one or more per stream.
4. **Detections per stream** — sort by `last_seen`, confirm each stream you tested appears with the right frame count and peak people count.
5. **Alerts per (stream, zone)** — should match what the REST endpoints returned.
6. **Full JSON for one detection** — press `6`, look at the `zones` and `clusters` columns. The `zones` field is a list of six objects, the `clusters` field is a list of cluster objects.

---

## 12. Load test

With the server running and the real YOLO engine active:

```powershell
python load_test.py --url http://127.0.0.1:8000 --requests 30 --concurrency 3
```

Expected on an RTX 2050 with `yolo_imgsz=832`:

- 30/30 successes
- Requests/sec somewhere between 4 and 8
- Average latency ~150–250 ms
- Median latency similar

With the server started with `AI_ENGINE=stub` in `.env`:

- Requests/sec typically 15–25
- Average latency ~30–60 ms

The `Avg latency` number divided into 1000 gives your max sustainable frames/sec across all concurrent streams. If you're demoing 3 cameras, budget ~1/3 of that number per camera.

---

## 13. Known-quirk smoke test

These confirm behavior that looks like a bug but isn't.

### Batch of 3 on a fresh stream

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/test-q1/frames/annotated -F "file=@test/istockphoto.jpeg" -o q1.jpg
```

- With `track_min_hits=1`, `q1.jpg` has the full overlay.
- With `track_min_hits=3`, `q1.jpg` has grid lines only.

That difference is expected. See `FIXES.md` for the reasoning.

### Sending a different image on the same stream_id

```powershell
# Frame 1 — dense image
curl.exe -X POST http://127.0.0.1:8000/streams/test-q2/frames -F "file=@test/images.jpeg"

# Frame 2 — completely different image, same stream
curl.exe -X POST http://127.0.0.1:8000/streams/test-q2/frames -F "file=@test/istockphoto.jpeg"
```

The frame-2 `person_count` may be wrong (mixing of old and new tracks). This is expected — the tracker assumes consecutive frames are the same scene. Use a fresh `stream_id` per scene.

### Duplicate simulator panels

Opening two browser tabs of `/simulator` and starting both with the same `stream id` produces garbage in both. This is expected — same reason. Use different `stream_id` per panel.

---

## Expected results summary

After running tests 1–11 on a fresh install, you should have:

- Non-zero rows in `detections` for at least `test-json`, `test-dense`, `test-annot`, `test-batch-istock`, `test-batch-dense`, `test-conf`, `test-eps`, `test-ppm`, `test-life`, and `cam-1`
- Non-zero rows in `alerts` for at least `test-json`, `test-annot`, `test-batch-istock`, `test-batch-dense`, `test-life`, and `cam-1`
- Working annotated JPEGs at `annotated.jpg`, `istock-burst.jpg`, `burst.jpg`, `eps30.jpg`, `q1.jpg`
- No 5xx errors anywhere

If all of the above is true, the backend is working end-to-end.

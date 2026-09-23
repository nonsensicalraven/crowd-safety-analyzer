# Setup

Install and run the Crowd Safety Analyzer backend from scratch.

Tested on Windows 11 + PowerShell, Python 3.13, RTX 2050 (CUDA 13.3 driver). Linux/macOS steps are noted where they differ.

**Note on database tooling:** this project does not require `psql` or any local Postgres install. The backend talks to Postgres (Neon or local) via SQLAlchemy + psycopg3. To inspect data, use `db_view.py` (bundled) or the Neon SQL editor. Both are covered below.

---

## Prerequisites

- **Python 3.10–3.13** — verify with `python --version`
- **PostgreSQL** — a free [Neon](https://neon.tech) project works, or a local install
- **GPU (optional)** — an NVIDIA GPU with recent drivers makes inference ~10× faster. CPU works but expect ~2 fps.
- **NVIDIA CUDA Toolkit is NOT required** — PyTorch ships with its own CUDA runtime in the wheels

---

## 1. Get the project into place

If you extracted from a ZIP:

```powershell
cd path\to\crowdctrl
```

You should see `main.py`, `config.py`, `analytics.py`, etc. in this directory. All commands below assume this is your working directory.

---

## 2. Create and activate a virtual environment

**Windows PowerShell:**

```powershell
python -m venv venv
venv\Scripts\Activate.ps1
```

If PowerShell refuses to run the activation script:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**Linux / macOS:**

```bash
python -m venv venv
source venv/bin/activate
```

You'll know it worked when your prompt has a `(venv)` prefix.

---

## 3. Install Python dependencies

```powershell
pip install -r requirements.txt
```

This installs FastAPI, SQLAlchemy, psycopg3 (`psycopg[binary]`), OpenCV, scikit-learn, huggingface_hub, loguru, and friends. It does **not** install PyTorch or Ultralytics — those are platform-specific and installed separately in the next step.

**Note on psycopg:** this project uses `psycopg` v3, not `psycopg2`. If you ever see a `psycopg2` import error, your `.env` URL is missing the `+psycopg` scheme modifier (see step 5).

---

## 4. Install PyTorch and Ultralytics

Pick exactly one of the following PyTorch variants.

### NVIDIA GPU (CUDA)

```powershell
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
pip install ultralytics
```

If your `nvidia-smi` reports a CUDA version of 12.8 or newer, you can use `cu128` instead of `cu124`. Both work.

If `pip install` says "no matching distribution", fall back to:

```powershell
pip install torch torchvision
pip install ultralytics
```

### CPU only

```powershell
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install ultralytics
```

### Verify PyTorch can see the GPU

```powershell
python -c "import torch; print(torch.__version__); print('cuda:', torch.cuda.is_available())"
```

On a GPU machine you should see something like:

```
2.5.1+cu124
cuda: True
```

If `cuda` is `False` on a machine that has a GPU, you accidentally installed the CPU wheel. Reinstall with the explicit `--index-url`.

---

## 5. Create the `.env` file

In the project root, create a file named `.env` with these two lines:

```env
DATABASE_URL=postgresql+psycopg://USER:PASSWORD@HOST:PORT/DBNAME
AI_ENGINE=real
```

### The `+psycopg` part is required

The project uses **psycopg 3**, so the scheme must be `postgresql+psycopg://`, not plain `postgresql://`. SQLAlchemy defaults to psycopg2 if you don't specify.

### Example — Neon

From your [Neon console](https://console.neon.tech), copy the connection string and modify it:

```
Original:  postgresql://user:pass@ep-xyz.aws.neon.tech/neondb?sslmode=require
Modified:  postgresql+psycopg://user:pass@ep-xyz.aws.neon.tech/neondb?sslmode=require
```

### Example — local Postgres

```env
DATABASE_URL=postgresql+psycopg://crowd_safety_user:yourpassword@localhost:5432/crowd_safety
```

### `AI_ENGINE`

- `real` — actual YOLO model (default, and what you want for any demo)
- `stub` — fake random detections, for testing the backend on a machine with no GPU and no network access to Hugging Face. Never use this for a demo.

---

## 6. Prepare the database

Two options. **Pick one.**

### Option A — do nothing (recommended for a fresh database)

When you start the server, `main.py`'s lifespan hook calls `Base.metadata.create_all()` and creates any missing tables. If the tables don't exist, they get created. If they exist with the wrong schema, **they are not modified** — you'd need Option B.

**For a first-time setup on a fresh Neon project, this is all you need to do. Skip to step 7.**

### Option B — reset tables to the current schema

Only needed if the `detections` and `alerts` tables exist with an **old** schema (e.g. you're upgrading from a previous version of this project). This **drops both tables and recreates them — all existing data is destroyed.**

You don't need `psql` for this. Two ways:

**Option B1 — Neon SQL editor (no install):**

1. Open https://console.neon.tech → your project → **SQL Editor**
2. Open `migration.sql` in a text editor, copy the whole thing
3. Paste into the Neon SQL editor, click **Run**
4. Tables are dropped and recreated

**Option B2 — if you happen to have `psql` installed:**

```powershell
psql "$DATABASE_URL" -f migration.sql
```

Note: replace `$DATABASE_URL` with the literal connection string (strip the `+psycopg` part — `psql` uses the plain scheme). If you don't have `psql`, use B1.

---

## 7. Start the server

**Do not use `--reload` on Windows.** Uvicorn's file-watcher spawns a child process on Windows, and PyTorch's CUDA initialization can crash that child silently at startup. Without `--reload`, everything runs in one process and starts reliably.

```powershell
uvicorn main:app
```

You should see, in order:

```
INFO:     Started server process [xxxx]
INFO:     Waiting for application startup.
YOLO head detector ready (weights=best.pt, device=cuda, half=True)
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:8000
```

**First run will download `best.pt`** (~6 MB) from Hugging Face and cache it in the project root. Subsequent runs skip the download.

**The server does not return to the prompt.** It stays in the foreground. That's expected — leave this window open and open a second terminal for the curl commands below.

To stop the server: `Ctrl+C` in the server window.

---

## 8. Verify it's alive

In a **second PowerShell window**, from the same project folder:

```powershell
curl.exe http://127.0.0.1:8000/
```

Expected:

```json
{ "message": "Crowd Safety Analyzer backend is running", "ai_engine": "real" }
```

If this fails with `Failed to connect`, the server isn't running or you're hitting the wrong port.

---

## 9. Run the test curls

You'll need the two sample images in `test/`:

- `test/images.jpeg` — dense crowd (~1022 heads)
- `test/istockphoto.jpeg` — milder crowd (~198 heads)

### JSON endpoint — one frame in, JSON out

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/cam-1/frames -F "file=@test/istockphoto.jpeg"
```

Expected: a JSON blob with `person_count` around 198 and one cluster in `top-right`.

**`person_count: 0` on the first frame is normal if `track_min_hits` is still 3.** With the shipped `config.py` (`track_min_hits=1`), the first frame gives a real count immediately.

### Annotated endpoint — one frame in, JPEG out

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/cam-k1/frames/annotated -F "file=@test/istockphoto.jpeg" -o annotated.jpg
```

Open `annotated.jpg` — you should see the 2×3 grid, green head boxes, cluster circle(s), heatmap tint, and HUD text.

### Batch endpoint — three frames in, one JPEG out

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/cam-k1/frames/batch/annotated -F "files=@test/istockphoto.jpeg" -F "files=@test/istockphoto.jpeg" -F "files=@test/istockphoto.jpeg" -o istock-burst.jpg
```

Same overlay as the annotated endpoint, but the tracker has seen 3 frames by the time the image renders. Useful for cold streams.

Same command, different image:

```powershell
curl.exe -X POST http://127.0.0.1:8000/streams/cam-k2/frames/batch/annotated -F "files=@test/images.jpeg" -F "files=@test/images.jpeg" -F "files=@test/images.jpeg" -o burst.jpg
```

### Query overrides

Applied per-stream, persisting for future calls on the same `stream_id`:

```powershell
# More sensitive detection, tighter clustering
curl.exe -X POST "http://127.0.0.1:8000/streams/cam-tuned/frames/annotated?conf=0.15&dbscan_eps_px=30" -F "file=@test/images.jpeg" -o tuned.jpg

# Subsequent calls on cam-tuned don't need the query params
curl.exe -X POST http://127.0.0.1:8000/streams/cam-tuned/frames/annotated -F "file=@test/images.jpeg" -o tuned2.jpg
```

---

## 10. The simulator UI

Put a video file into `test/` as `testvideo.mp4` (or anywhere reachable by the browser).

Open in a browser:

```
http://127.0.0.1:8000/simulator
```

1. Click **video files**, select `test/testvideo.mp4`.
2. In the panel that appears:
   - **stream id** — leave the auto-generated `cam-1`, or set a unique name. **Do not reuse a stream id across panels.**
   - **send fps** — start with `3`.
   - Other fields — leave at defaults.
3. Click **▶ Start**.

Frames stream to the backend over WebSocket; annotated frames come back and update in the `<img>` box. Under the image:

```
status: streaming →
out: 42 (3.1 fps)   in: 14 (1.0 fps)   ws: open
```

- `out:` = frames sent
- `in:` = annotated frames received (roughly `out / refresh_every`)
- `ws:` = connection state

**Stop before reloading or closing the tab.** Otherwise the old WebSocket lingers server-side for a few seconds and the next connection on the same stream id interleaves with it.

---

## 11. Inspect the database

You do **not** need `psql` or any Postgres client installed. Two options:

### Option A — `db_view.py` (bundled, recommended)

```powershell
python db_view.py
```

Reads `DATABASE_URL` from `.env` (applies the `+psycopg` scheme fix automatically), connects with SQLAlchemy, and shows a numbered menu of six read-only queries:

1. Table row counts
2. Latest 10 detections
3. Latest 10 alerts
4. Detections per stream (with peak people count)
5. Alerts per (stream, zone)
6. Full JSON for the latest detection (zones + clusters)

Press the number, press Enter. `q` to quit.

### Option B — Neon SQL editor

Log in at https://console.neon.tech → your project → **SQL Editor**. Paste any query, hit Run. Same queries as `db_view.py`, plus ad-hoc ones you want to try.

Example to sanity-check recent activity:

```sql
SELECT id, stream_id, frame_id, timestamp, person_count
FROM detections
ORDER BY timestamp DESC
LIMIT 10;
```

---

## 12. Optional — load test

With the server running:

```powershell
python load_test.py --url http://127.0.0.1:8000 --requests 30 --concurrency 3
```

Fires 30 synthetic frames at the `/streams/.../frames` endpoint. With the real YOLO engine, expect ~150–250 ms average latency per request on an RTX 2050. With `AI_ENGINE=stub` on the server, latency drops to the DB-write cost (~30–60 ms).

The reported "Avg latency" divided into 1000 gives your max sustainable fps across all streams.

---

## Troubleshooting

| Symptom                                                | Cause                                                 | Fix                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `RuntimeError: DATABASE_URL is not set`                | `.env` missing or in wrong directory                  | `.env` must be in the same folder as `main.py`                      |
| `ModuleNotFoundError: No module named 'psycopg'`       | `requirements.txt` not installed                      | `pip install -r requirements.txt`                                   |
| `ModuleNotFoundError: No module named 'psycopg2'`      | `.env` URL is missing `+psycopg`                      | Change scheme to `postgresql+psycopg://`                            |
| `ModuleNotFoundError: No module named 'torch'`         | PyTorch not installed                                 | See step 4                                                          |
| `CUDA unavailable — running on CPU` warning            | Torch is the CPU build                                | Reinstall with `--index-url https://download.pytorch.org/whl/cu124` |
| Server exits silently after "Started reloader process" | `--reload` on Windows                                 | Run `uvicorn main:app` without `--reload`                           |
| `RuntimeError: Zone grid config...`                    | Someone changed `grid_cols`/`grid_rows`               | Revert to `3`/`2` in `config.py`                                    |
| `curl: (7) Failed to connect`                          | Server not running, or running in same window as curl | Start server in window 1, run curl in window 2                      |
| `curl: (26) Failed to open/read local data`            | Wrong filename                                        | Check with `Get-ChildItem test`                                     |
| `psql: command not found`                              | `psql` isn't installed                                | You don't need it — use `python db_view.py` or the Neon SQL editor  |
| `CUDA out of memory`                                   | VRAM (4 GB on RTX 2050) exhausted at `yolo_imgsz=832` | Add `YOLO_IMGSZ=640` to `.env`, restart server                      |

---

## Resetting state

### In-memory state (per-stream trackers, heatmaps, event trackers)

**Restart uvicorn.** There's no endpoint for it — restarting is one command and takes 3 seconds.

### Database state

If you want to wipe all detection and alert history:

1. Open the Neon SQL editor (or any Postgres client you happen to have)
2. Paste the contents of `migration.sql`
3. Run

This drops and recreates both tables. All history is gone.

You don't need to do this for normal operation. The tables persist across server restarts.

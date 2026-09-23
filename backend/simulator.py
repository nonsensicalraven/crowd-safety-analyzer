"""
simulator.py — HTML page served at GET /simulator.
Ported from Crowd_ai v3/pipeline.py's embedded FRONTEND_HTML. It is a
development/testing UI: select several local video files, each opens
its own WebSocket to /ws/ingest/<stream_id>, streams JPEG frames, and
displays the annotated frames the backend sends back. Per-stream
config (px/m, cluster distance, conf, refresh rate) can be changed
live via the on-page controls.
"""
from __future__ import annotations

FRONTEND_HTML = r"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Crowd AI — Multi-Stream Simulator</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0e1420; color:#e8eef7; margin:0; padding:20px; }
  h1 { font-size:18px; margin:0 0 14px; }
  .row { display:flex; gap:14px; flex-wrap:wrap; align-items:flex-end; margin-bottom:14px; }
  label { display:flex; flex-direction:column; font-size:11px; color:#8fa3bd; gap:4px; }
  label.chk { flex-direction:row; align-items:center; font-size:13px; }
  input, button { background:#1a2433; color:#e8eef7; border:1px solid #33455e; border-radius:6px; padding:8px 10px; font-size:14px; }
  button { cursor:pointer; }
  button:disabled { opacity:.35; cursor:default; }
  button.primary { background:#2563eb; border-color:#2563eb; }
  .card { border:1px solid #33455e; border-radius:10px; padding:12px; margin-bottom:16px; background:#121a28; }
  .cardtitle { font-size:13px; margin-bottom:8px; color:#cfe0f5; }
  img.out { max-width:100%; border:1px solid #33455e; border-radius:8px; background:#000; min-height:200px; }
  .stats { font:12px/1.7 ui-monospace, Consolas, monospace; color:#8fa3bd; margin-top:8px; white-space:pre; }
</style>
</head>
<body>
<h1>🎬 Crowd AI — multi-video simulator</h1>
<div class="row">
  <label>video files (select several) <input type="file" id="files" accept="video/*" multiple></label>
  <label>ws base url <input id="wsurl" value="ws://127.0.0.1:8000/ws/ingest" size="40"></label>
</div>
<div id="streams"></div>
<script>
const $ = id => document.getElementById(id);
const panels = [];
let idx = 0;
class Panel {
  constructor(file) {
    this.idx = ++idx;
    this.file = file;
    this.sent = 0; this.recv = 0; this.t0 = 0;
    this.msg = "idle"; this.objUrl = null; this.ws = null; this.timer = null;
    this.build();
  }
  build() {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="cardtitle">📹 ${this.file.name}</div>
      <div class="row">
        <label>stream id <input class="sid" value="cam-${this.idx}" size="7"></label>
        <label>send fps <input class="fps" type="number" value="3" min="1" max="15" style="width:52px"></label>
        <label>max width <input class="maxw" type="number" value="640" step="80" style="width:64px"></label>
        <label>px / metre <input class="ppm" type="number" value="100" min="1" style="width:64px"></label>
        <label>cluster px <input class="eps" type="number" value="80" min="10" style="width:56px"></label>
        <label>conf <input class="conf" type="number" value="0.25" min="0.05" max="0.9" step="0.05" style="width:60px"></label>
        <label>refresh every <input class="every" type="number" value="3" min="1" max="30" style="width:52px"></label>
        <label class="chk">loop <input class="loop" type="checkbox" checked></label>
        <button class="start primary">▶ Start</button>
        <button class="stop" disabled>⏹ Stop</button>
      </div>
      <img class="out" alt="">
      <div class="stats">idle</div>
      <video class="vid" style="display:none" muted playsinline></video>
      <canvas class="cv" style="display:none"></canvas>`;
    this.root = el;
    this.q = s => el.querySelector(s);
    this.vid = this.q(".vid");
    this.cv = this.q(".cv");
    this.ctx = this.cv.getContext("2d");
    this.q(".start").onclick = () => this.start();
    this.q(".stop").onclick = () => this.stop("stopped");
  }
  async start() {
    const sid = this.q(".sid").value.trim() || ("cam-" + this.idx);
    const base = $("wsurl").value;
    try {
      this.ws = await new Promise((res, rej) => {
        const w = new WebSocket(`${base}/${sid}`);
        w.binaryType = "blob";
        w.onopen = () => res(w);
        w.onerror = () => rej(new Error("fail"));
        w.onclose = () => { if (this.timer) this.stop("backend closed"); };
        w.onmessage = e => {
          if (!(e.data instanceof Blob)) return;
          this.recv++;
          if (this.objUrl) URL.revokeObjectURL(this.objUrl);
          this.objUrl = URL.createObjectURL(e.data);
          this.q(".out").src = this.objUrl;
        };
      });
    } catch { this.msg = "❌ websocket failed"; return; }
    this.ws.send(JSON.stringify({
      type: "config",
      px_per_meter: +this.q(".ppm").value,
      dbscan_eps_px: +this.q(".eps").value,
      conf: +this.q(".conf").value,
      display_every_n: +this.q(".every").value,
    }));
    this.vid.src = URL.createObjectURL(this.file);
    await new Promise(r => this.vid.onloadedmetadata = r);
    const s = Math.min(1, (+this.q(".maxw").value || 640) / this.vid.videoWidth);
    this.cv.width  = Math.max(2, Math.round(this.vid.videoWidth  * s / 2) * 2);
    this.cv.height = Math.max(2, Math.round(this.vid.videoHeight * s / 2) * 2);
    this.vid.loop = this.q(".loop").checked;
    this.vid.currentTime = 0;
    try { await this.vid.play(); } catch { this.msg = "❌ play blocked"; return; }
    this.t0 = performance.now();
    this.timer = setInterval(() => this.grab(), 1000 / (+this.q(".fps").value || 3));
    this.q(".start").disabled = true;
    this.q(".stop").disabled = false;
    this.msg = "streaming →";
  }
  grab() {
    if (this.vid.readyState < 2) return;
    this.ctx.drawImage(this.vid, 0, 0, this.cv.width, this.cv.height);
    if (this.ws && this.ws.readyState === 1) {
      this.cv.toBlob(b => {
        if (b && this.ws && this.ws.readyState === 1) { this.ws.send(b); this.sent++; }
      }, "image/jpeg", 0.7);
    }
  }
  stop(reason) {
    clearInterval(this.timer); this.timer = null;
    this.vid.pause();
    if (this.ws) { const w = this.ws; this.ws = null; w.close(); }
    this.q(".start").disabled = false;
    this.q(".stop").disabled = true;
    this.msg = reason || "stopped";
  }
}
$("files").addEventListener("change", e => {
  for (const f of e.target.files) {
    const p = new Panel(f);
    panels.push(p);
    $("streams").appendChild(p.root);
  }
  e.target.value = "";
});
setInterval(() => {
  for (const p of panels) {
    const dt = Math.max((performance.now() - p.t0) / 1000, 1);
    p.q(".stats").textContent =
      `status: ${p.msg}\nout: ${p.sent} (${(p.sent / dt).toFixed(1)} fps)   ` +
      `in: ${p.recv} (${(p.recv / dt).toFixed(1)} fps)   ws: ${p.ws ? "open" : "closed"}`;
  }
}, 250);
</script>
</body>
</html>"""

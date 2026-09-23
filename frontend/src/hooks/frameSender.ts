// src/streaming/FrameSender.ts
//
// Grabs frames from a <video> element and POSTs them to the backend as JPEGs.
//
//   video frame -> <canvas> -> canvas.toBlob('image/jpeg') -> multipart POST
//   POST http://127.0.0.1:8000/streams/{stream_id}/frames   (form field: "file")
//
// The backend does no throttling, so this class is the only thing limiting the
// send rate. It runs a self-scheduling loop (setTimeout, not setInterval) so
// there is never more than one request in flight.
//
// Plain browser code: no Node imports, no React. Use it directly, or through
// the useFrameSender hook.

export type FrameSenderStatus = 'idle' | 'sending' | 'error';

export interface FrameSenderOptions {
  /** Backend origin. Default: http://127.0.0.1:8000 */
  baseUrl?: string;
  /** Target gap between frame sends, in ms. Default 500 (about 2 fps). */
  intervalMs?: number;
  /** JPEG quality, 0..1. Default 0.7 */
  jpegQuality?: number;
  /** Downscale frames wider than this (keeps aspect ratio). 0 = send full size. Default 1280 */
  maxWidth?: number;
  /** Abort a request that takes longer than this, in ms. Default 5000 */
  requestTimeoutMs?: number;
  /** Upper bound for the retry delay after failures, in ms. Default 5000 */
  maxBackoffMs?: number;
  /** Don't send while the video is paused or ended. Default true */
  skipWhenPaused?: boolean;
  /** Called when status changes, and on every failed attempt (with the error). */
  onStatusChange?: (status: FrameSenderStatus, error?: Error) => void;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';

export class FrameSender {
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly jpegQuality: number;
  private readonly maxWidth: number;
  private readonly requestTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly skipWhenPaused: boolean;
  private readonly onStatusChange?: FrameSenderOptions['onStatusChange'];

  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private timer: number | undefined;
  private abort: AbortController | null = null;
  private running = false;
  private failures = 0;
  private status: FrameSenderStatus = 'idle';

  constructor(streamId: string, options: FrameSenderOptions = {}) {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.url = `${baseUrl}/streams/${encodeURIComponent(streamId)}/frames`;
    this.intervalMs = options.intervalMs ?? 500;
    this.jpegQuality = options.jpegQuality ?? 0.7;
    this.maxWidth = options.maxWidth ?? 1280;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.maxBackoffMs = options.maxBackoffMs ?? 5000;
    this.skipWhenPaused = options.skipWhenPaused ?? true;
    this.onStatusChange = options.onStatusChange;
  }

  /** Begin sending frames from this video element. Safe to call once per instance. */
  start(video: HTMLVideoElement): void {
    if (this.running) return;
    this.video = video;
    this.running = true;
    this.failures = 0;
    void this.tick();
  }

  /** Stop the loop and cancel any request in flight. */
  stop(): void {
    this.running = false;
    window.clearTimeout(this.timer);
    this.abort?.abort();
    this.abort = null;
    this.video = null;
    this.setStatus('idle');
  }

  // ---------------------------------------------------------------- loop

  private async tick(): Promise<void> {
    if (!this.running || !this.video) return;
    const startedAt = performance.now();

    try {
      const blob = await this.captureFrame(this.video);
      // blob === null means "nothing to send this round" (video not ready / paused)
      if (blob) {
        await this.post(blob);
        this.failures = 0;
        this.setStatus('sending');
      }
    } catch (err) {
      if (!this.running) return; // aborted by stop(), not a real failure
      this.failures += 1;
      this.setStatus('error', err instanceof Error ? err : new Error(String(err)));
    }

    if (!this.running) return;

    // Healthy: keep a steady cadence (subtract the time this round took).
    // Failing: back off exponentially so we don't hammer a dead backend.
    const delay =
      this.failures > 0
        ? Math.min(this.maxBackoffMs, this.intervalMs * 2 ** this.failures)
        : Math.max(0, this.intervalMs - (performance.now() - startedAt));

    this.timer = window.setTimeout(() => void this.tick(), delay);
  }

  // ------------------------------------------------------------- capture

  private async captureFrame(video: HTMLVideoElement): Promise<Blob | null> {
    // HAVE_CURRENT_DATA (2) = at least one decoded frame is available to draw.
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) {
      return null;
    }
    if (this.skipWhenPaused && (video.paused || video.ended)) return null;

    if (!this.canvas) {
      this.canvas = document.createElement('canvas'); // off-screen, never added to the DOM
      this.ctx = this.canvas.getContext('2d');
    }
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!ctx) throw new Error('2D canvas context is not available');

    const scale =
      this.maxWidth > 0 && video.videoWidth > this.maxWidth
        ? this.maxWidth / video.videoWidth
        : 1;
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);

    // Only resize when the size actually changed (resizing clears the canvas).
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    // Throws a SecurityError from toBlob() below if the video is cross-origin
    // without CORS headers ("tainted canvas"), which surfaces as an 'error' status.
    ctx.drawImage(video, 0, 0, w, h);

    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', this.jpegQuality);
    });
  }

  // ---------------------------------------------------------------- send

  private async post(blob: Blob): Promise<void> {
    // FormData builds the multipart body. Do NOT set a Content-Type header
    // yourself: the browser adds it along with the multipart boundary.
    const form = new FormData();
    form.append('file', blob, 'frame.jpg'); // field name "file" is what the backend expects

    const controller = new AbortController();
    this.abort = controller;
    const timeout = window.setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Frame upload failed: HTTP ${res.status} ${detail.slice(0, 200)}`.trim());
      }
    } finally {
      window.clearTimeout(timeout);
      this.abort = null;
    }
  }

  // -------------------------------------------------------------- status

  private setStatus(next: FrameSenderStatus, error?: Error): void {
    const changed = next !== this.status;
    this.status = next;
    // Notify on any change, and on every failure so the latest error is visible.
    if (changed || next === 'error') this.onStatusChange?.(next, error);
  }
}
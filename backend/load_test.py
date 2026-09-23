"""
load_test.py

Simple load-testing script. Fires many POST /streams/{stream_id}/frames
requests (small synthetic JPEG frames) at the running backend with
configurable count and concurrency, and reports basic
throughput/latency numbers.

NOTE: this exercises the FULL pipeline including real YOLO inference
if AI_ENGINE=real on the server -- expect much lower throughput than
the old JSON-only /detect endpoint, since every request now does
actual image decode + detection + clustering, not just a DB write.
For a pure API/DB throughput number unrelated to inference cost, run
the server with AI_ENGINE=stub instead.

This is a prototype-scale tool for a local pre-demo sanity check --
not a substitute for a real tool like Locust or k6.

Usage:
    python load_test.py --url http://127.0.0.1:8000 --requests 100 --concurrency 10
"""

import argparse
import statistics
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import cv2
import numpy as np
import httpx


def make_frame_jpeg(seed: int) -> bytes:
    """A small synthetic frame so we're not shipping a real image
    around -- content doesn't matter for load testing, only size and
    that it's valid JPEG bytes the server can decode."""
    rng = np.random.default_rng(seed)
    img = rng.integers(0, 255, (240, 320, 3), dtype=np.uint8)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
    if not ok:
        raise RuntimeError("failed to encode synthetic frame")
    return buf.tobytes()


def send_one(client: httpx.Client, url: str, stream_id: str, jpeg: bytes):
    start = time.perf_counter()
    try:
        r = client.post(
            f"{url}/streams/{stream_id}/frames",
            files={"file": ("frame.jpg", jpeg, "image/jpeg")},
            timeout=30.0,
        )
        elapsed = time.perf_counter() - start
        return (r.status_code < 400, elapsed, r.status_code)
    except Exception as exc:
        elapsed = time.perf_counter() - start
        return (False, elapsed, str(exc))


def main():
    parser = argparse.ArgumentParser(description="Load test POST /streams/{stream_id}/frames")
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--stream-id", default="cam-loadtest")
    parser.add_argument("--requests", type=int, default=50, help="Total number of requests to send")
    parser.add_argument("--concurrency", type=int, default=5, help="Number of concurrent workers")
    args = parser.parse_args()

    jpeg = make_frame_jpeg(0)  # reuse one synthetic frame -- content doesn't matter

    results = []
    start_time = time.perf_counter()

    with httpx.Client() as client:
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futures = [
                pool.submit(send_one, client, args.url, args.stream_id, jpeg)
                for _ in range(args.requests)
            ]
            for future in as_completed(futures):
                results.append(future.result())

    total_elapsed = time.perf_counter() - start_time

    successes = [r for r in results if r[0]]
    failures = [r for r in results if not r[0]]
    latencies = [r[1] for r in results]

    print("=" * 50)
    print("Load test results")
    print("=" * 50)
    print(f"Target:              {args.url}/streams/{args.stream_id}/frames")
    print(f"Requests sent:       {len(results)}")
    print(f"Concurrency:         {args.concurrency}")
    print(f"Successful:          {len(successes)}")
    print(f"Failed:              {len(failures)}")
    print(f"Total elapsed:       {total_elapsed:.2f}s")
    print(f"Requests/sec:        {len(results) / total_elapsed:.2f}")
    if latencies:
        print(f"Avg latency:         {statistics.mean(latencies) * 1000:.1f} ms")
        print(f"Median latency:      {statistics.median(latencies) * 1000:.1f} ms")
        print(f"Max latency:         {max(latencies) * 1000:.1f} ms")
    if failures:
        print("-" * 50)
        print("Sample failures (up to 5):")
        for _, _, detail in failures[:5]:
            print(f"  {detail}")


if __name__ == "__main__":
    main()
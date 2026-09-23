// src/hooks/useFrameSender.ts
//
// Starts a FrameSender while `enabled` is true and stops it on unmount or when
// any option changes. Adjust the import path if you put FrameSender elsewhere.
//
// Usage:
//
//   const videoRef = useRef<HTMLVideoElement>(null);
//   const { status, error } = useFrameSender(videoRef, 'cam-1', { intervalMs: 500 });
//
//   <video ref={videoRef} src="/clips/entrance.mp4" autoPlay muted playsInline loop />
//   <span style={{ fontSize: 12 }}>frames: {status}{error ? ` (${error.message})` : ''}</span>
//
// For a webcam, set videoRef.current.srcObject = stream (from getUserMedia)
// before or after mounting; the sender waits until frames are available.

import { useEffect, useState, type RefObject } from 'react';
import {
  FrameSender,
  type FrameSenderOptions,
  type FrameSenderStatus,
} from './frameSender';

export interface UseFrameSenderOptions extends Omit<FrameSenderOptions, 'onStatusChange'> {
  /** Set false to pause sending without unmounting. Default true. */
  enabled?: boolean;
}

export function useFrameSender(
  videoRef: RefObject<HTMLVideoElement | null>,
  streamId: string,
  options: UseFrameSenderOptions = {},
): { status: FrameSenderStatus; error: Error | null } {
  // Destructure to primitives so the effect only re-runs when a value changes,
  // not every render (an inline `{ intervalMs: 500 }` is a new object each time).
  const {
    enabled = true,
    baseUrl,
    intervalMs,
    jpegQuality,
    maxWidth,
    requestTimeoutMs,
    maxBackoffMs,
    skipWhenPaused,
  } = options;

  const [status, setStatus] = useState<FrameSenderStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    setStatus('idle');
    setError(null);
    if (!enabled || !video || !streamId) return;

    let active = true; // blocks state updates after cleanup
    const sender = new FrameSender(streamId, {
      baseUrl,
      intervalMs,
      jpegQuality,
      maxWidth,
      requestTimeoutMs,
      maxBackoffMs,
      skipWhenPaused,
      onStatusChange: (s, e) => {
        if (!active) return;
        setStatus(s);
        setError(s === 'error' ? e ?? null : null);
      },
    });

    sender.start(video);
    return () => {
      active = false;
      sender.stop();
    };
  }, [
    videoRef,
    streamId,
    enabled,
    baseUrl,
    intervalMs,
    jpegQuality,
    maxWidth,
    requestTimeoutMs,
    maxBackoffMs,
    skipWhenPaused,
  ]);

  return { status, error };
}
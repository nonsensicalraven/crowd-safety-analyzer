import ReconnectingWebSocket from 'reconnecting-websocket';
import {
  DensityFeedEnvelopeSchema,
  type FrameUpdateEnvelope,
  type AlertEnvelope,
} from '../schemas/wsdetection.schema';

// NEW: backend dashboard channel (one shared socket for ALL cameras).
// Update the Settings page default to this value too.
export const DEFAULT_FEED_URL = 'ws://127.0.0.1:8000/ws/dashboard';

// CHANGED: the payloads now include `stream_id`, so handlers can tell cameras apart.
export type FrameUpdateData = FrameUpdateEnvelope['data'];
export type AlertData = AlertEnvelope['data'];

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

type FrameHandler = (data: FrameUpdateData) => void;
type AlertHandler = (data: AlertData) => void;
type StatusHandler = (status: ConnectionStatus) => void;

// A subscription can optionally be limited to one camera.
// streamId === undefined means "receive every stream".
interface Subscription<T> {
  cb: (data: T) => void;
  streamId?: string;
}

export class DensityFeedClient {
  private socket: ReconnectingWebSocket;
  private frameSubs = new Set<Subscription<FrameUpdateData>>();
  private alertSubs = new Set<Subscription<AlertData>>();
  private statusHandlers = new Set<StatusHandler>();
  private currentStatus: ConnectionStatus = 'connecting';

  constructor(url: string = DEFAULT_FEED_URL) {
    // CHANGED: explicit backoff settings. Retries start at 1s and grow by 1.5x per
    // attempt, capped at 10s, and never give up (maxRetries defaults to Infinity).
    this.socket = new ReconnectingWebSocket(url, undefined, {
      minReconnectionDelay: 1000,
      maxReconnectionDelay: 10000,
      reconnectionDelayGrowFactor: 1.5,
    });

    this.socket.addEventListener('open', () => this.emitStatus('open'));
    this.socket.addEventListener('close', () => this.emitStatus('closed'));
    this.socket.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(event.data);
    });

    this.socket.addEventListener('error', (event) => {
      // reconnecting-websocket keeps retrying on its own; just log for visibility
      console.error('[DensityFeedClient] socket error', event);
    });
  }

  private handleMessage(raw: unknown) {
    if (typeof raw !== 'string') {
      console.error('[DensityFeedClient] received non-text message', raw);
      return;
    }

    let parsedJson: unknown; // we don't know what type of data the server actually sent
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      console.error('[DensityFeedClient] received non-JSON message', raw, err);
      return;
    }

    const result = DensityFeedEnvelopeSchema.safeParse(parsedJson);
    if (!result.success) {
      console.error('[DensityFeedClient] schema validation failed', result.error, parsedJson);
      return;
    }

    const envelope = result.data;

    // CHANGED: 'detection' -> 'frame_update', plus routing by stream_id.
    if (envelope.type === 'frame_update') {
      this.dispatch(this.frameSubs, envelope.stream_id, envelope.data);
    } else {
      this.dispatch(this.alertSubs, envelope.stream_id, envelope.data);
    }
  }

  // NEW: delivers to subscribers whose filter matches, and isolates failures so one
  // throwing UI handler can't stop the others from receiving the message.
  private dispatch<T>(subs: Set<Subscription<T>>, streamId: string, data: T) {
    subs.forEach((sub) => {
      if (sub.streamId !== undefined && sub.streamId !== streamId) return;
      try {
        sub.cb(data);
      } catch (err) {
        console.error('[DensityFeedClient] handler threw', err);
      }
    });
  }

  private emitStatus(status: ConnectionStatus) {
    this.currentStatus = status;
    this.statusHandlers.forEach((cb) => cb(status));
  }

  // CHANGED: was onDetection(cb). Pass a streamId to only receive that camera.
  onFrame(cb: FrameHandler, streamId?: string): () => void {
    const sub = { cb, streamId };
    this.frameSubs.add(sub);
    return () => {
      this.frameSubs.delete(sub);
    };
  }

  // Alert messages carry an `event` ('new' | 'continue' | 'escalate') telling the UI
  // whether to add a card or update the existing one (match by data.id).
  onAlert(cb: AlertHandler, streamId?: string): () => void {
    const sub = { cb, streamId };
    this.alertSubs.add(sub);
    return () => {
      this.alertSubs.delete(sub);
    };
  }

  // CHANGED: the handler is called immediately with the current status, so a component
  // that subscribes after the socket already opened doesn't miss the 'open' event.
  onStatusChange(cb: StatusHandler): () => void {
    this.statusHandlers.add(cb);
    cb(this.currentStatus);
    return () => {
      this.statusHandlers.delete(cb);
    };
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  close() {
    this.socket.close();
  }
}
// REST client for the /alerts endpoints.
//
// There's no separate backend settings/base-URL for HTTP yet (SettingsStore.ts
// only configures the WebSocket endpoint), so this derives the REST host from
// DEFAULT_FEED_URL: ws://127.0.0.1:8000/ws/dashboard -> http://127.0.0.1:8000.
// If the backend ever serves REST on a different host/port, update
// deriveRestBase (or replace it with its own configured value) here only.
import { AlertRowSchema, type AlertRow } from '../schemas/wsdetection.schema';
import { DEFAULT_FEED_URL } from '../websocket/DensityFeedClient';

function deriveRestBase(wsUrl: string): string {
  const url = new URL(wsUrl);
  const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${url.host}`;
}

export const REST_BASE_URL = deriveRestBase(DEFAULT_FEED_URL);

async function parseAlertRow(res: Response, action: string): Promise<AlertRow> {
  if (!res.ok) {
    throw new Error(`${action} failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return AlertRowSchema.parse(json);
}

export async function fetchActiveAlerts(): Promise<AlertRow[]> {
  const res = await fetch(`${REST_BASE_URL}/alerts/active`);
  if (!res.ok) {
    throw new Error(`Failed to fetch active alerts: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return AlertRowSchema.array().parse(json);
}

export async function acknowledgeAlert(id: number): Promise<AlertRow> {
  const res = await fetch(`${REST_BASE_URL}/alerts/${id}/acknowledge`, { method: 'PATCH' });
  return parseAlertRow(res, 'Acknowledge');
}

export async function markResponseTeamArrived(id: number): Promise<AlertRow> {
  const res = await fetch(`${REST_BASE_URL}/alerts/${id}/response-team-arrived`, { method: 'PATCH' });
  return parseAlertRow(res, 'Mark response team arrived');
}

export async function clearAlert(id: number): Promise<AlertRow> {
  const res = await fetch(`${REST_BASE_URL}/alerts/${id}/cleared`, { method: 'PATCH' });
  return parseAlertRow(res, 'Clear alert');
}
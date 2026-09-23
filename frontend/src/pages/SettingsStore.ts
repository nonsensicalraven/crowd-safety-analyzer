// Lightweight persisted settings store for the dashboard.
//
// There's no backend settings endpoint (alert thresholds are hardcoded
// constants in alert_logic.py), so this is purely client-side, backed by
// localStorage. Any component that needs a setting (e.g. the piece of code
// that constructs DensityFeedClient) should import `getSettings()` / call
// `subscribeSettings()` rather than hardcoding a value.
//
// Adjust the import path below if this file doesn't live next to
// DensityFeedClient.ts.
import { DEFAULT_FEED_URL } from '../websocket/DensityFeedClient';

export interface AppSettings {
  /** WebSocket URL for the shared dashboard feed (all cameras/zones). */
  wsEndpoint: string;
  /** User's stated preference for playing a sound on CRITICAL alerts.
   *  NOTE: storing this here doesn't make it happen — whatever renders the
   *  live alert board (Dashboard.tsx) needs to check this flag when it
   *  receives a CRITICAL alert and play the sound itself. Not wired yet. */
  soundOnCritical: boolean;
  /** User's stated preference for browser push notifications. The actual
   *  permission is tracked by the browser (Notification.permission) and is
   *  NOT persisted here — this just remembers whether the user opted in. */
  pushNotificationsEnabled: boolean;
}

const STORAGE_KEY = 'crowd-analyzer:settings';

export const DEFAULT_SETTINGS: AppSettings = {
  wsEndpoint: DEFAULT_FEED_URL,
  soundOnCritical: false,
  pushNotificationsEnabled: false,
};

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    // Merge over defaults so old/partial saved blobs (or a future new field)
    // don't crash the app or leave fields undefined.
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (err) {
    console.error('[settingsStore] failed to load settings, using defaults', err);
    return { ...DEFAULT_SETTINGS };
  }
}

let current: AppSettings = load();
const listeners = new Set<(settings: AppSettings) => void>();

export function getSettings(): AppSettings {
  return current;
}

export function saveSettings(next: AppSettings): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.error('[settingsStore] failed to persist settings', err);
  }
  listeners.forEach((cb) => cb(current));
}

export function resetSettings(): AppSettings {
  const defaults = { ...DEFAULT_SETTINGS };
  saveSettings(defaults);
  return defaults;
}

/** Subscribe to settings changes (e.g. from another tab/component calling saveSettings). */
export function subscribeSettings(cb: (settings: AppSettings) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
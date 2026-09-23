import type { SeverityName } from '../schemas/wsdetection.schema';

export type SeverityLevel = 'Safe' | 'Watch' | 'Elevated' | 'Critical';
export type AlertLevel = SeverityLevel | 'Resolved';

// UNCHANGED: these thresholds already line up with the backend scale
//   LOW=10 -> Safe, MEDIUM=40 -> Watch, HIGH=75 -> Elevated, CRITICAL=90 -> Critical
export function resolveAlertLevel(raw: number): SeverityLevel {
  if (raw <= 25) return 'Safe';
  if (raw <= 50) return 'Watch';
  if (raw <= 75) return 'Elevated';
  return 'Critical';
}

// NEW: map the backend's named severity (`alert_type` / `severity_name`) directly.
// Prefer this over the numeric version when you have the name.
// NOTE: the backend currently never produces HIGH, so 'Elevated' won't appear yet.
const SEVERITY_NAME_TO_LEVEL: Record<SeverityName, SeverityLevel> = {
  LOW: 'Safe',
  MEDIUM: 'Watch',
  HIGH: 'Elevated',
  CRITICAL: 'Critical',
};

export function resolveSeverityName(name: SeverityName): SeverityLevel {
  return SEVERITY_NAME_TO_LEVEL[name];
}

// Re-export inferred types from schema so consumers import from one place if preferred
// CHANGED: DetectionEnvelope -> FrameUpdateEnvelope; added the REST/row types
export type {
  FrameUpdateEnvelope,
  AlertEnvelope,
  DensityFeedEnvelope,
  FrameData,
  AlertRow,
  Zone,
  Cluster,
  ZoneName,
  SeverityName,
  AlertEvent,
} from '../schemas/wsdetection.schema';
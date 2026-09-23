import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

// The backend always reports exactly these 6 grid cells per camera.
// Zones arrive in no guaranteed order, so always look them up by `name`.
export const ZONE_NAMES = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;
export const ZoneNameSchema = z.enum(ZONE_NAMES);
export type ZoneName = z.infer<typeof ZoneNameSchema>;

// LOW=10, MEDIUM=40, HIGH=75, CRITICAL=90
// NOTE: HIGH is defined but the backend's current rules never produce it.
export const SEVERITY_NAMES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const SeverityNameSchema = z.enum(SEVERITY_NAMES);
export type SeverityName = z.infer<typeof SeverityNameSchema>;

export const AlertEventSchema = z.enum(['new', 'continue', 'escalate']);
export type AlertEvent = z.infer<typeof AlertEventSchema>;

// ---------------------------------------------------------------------------
// Frame (detection) data
// ---------------------------------------------------------------------------

const ZoneSchema = z.object({
    name: ZoneNameSchema,
    cluster_count: z.number().int().nonnegative(),
    person_count: z.number().int().nonnegative(),
    individuals: z.number().int().nonnegative(),
    severity: z.number().int().min(0).max(100),
    severity_name: SeverityNameSchema,
});

// `clusters` only lists zones that actually have a cluster this frame (can be empty)
const ClusterSchema = z.object({
    cluster_id: z.number().int().nonnegative(),
    person_count: z.number().int().nonnegative(),
    density: z.number().nonnegative(),
    location: ZoneNameSchema,
    surge: z.boolean(),
});

// Shape shared by the WebSocket frame_update and GET /detections history rows
export const FrameDataSchema = z.object({
    id: z.number().int().nonnegative(),
    stream_id: z.string(),
    frame_id: z.number().int().nonnegative(),
    timestamp: z.string(), // ISO 8601, UTC
    person_count: z.number().int().nonnegative(),
    directional_surge: z.boolean(), // informational only, not used for alert decisions
    zones: z.array(ZoneSchema),
    clusters: z.array(ClusterSchema),
});

// Summary of alert actions caused by THIS frame. The same events also arrive as
// separate 'alert' messages, so handle only one of the two in the UI or alerts
// will be double-counted. (Our plan: use the 'alert' messages, ignore this.)
const TriggeredAlertSchema = z.object({
    alert_id: z.number().int().nonnegative(),
    stream_id: z.string(),
    location: ZoneNameSchema,
    alert_level: z.number().int().min(0).max(100),
    alert_type: SeverityNameSchema,
    event: AlertEventSchema,
});

const FrameUpdateDataSchema = FrameDataSchema.extend({
    alerts_triggered: z.array(TriggeredAlertSchema).default([]),
});

// ---------------------------------------------------------------------------
// Alert data
// ---------------------------------------------------------------------------

// One row of the alerts table. This is what the REST endpoints return:
// GET /alerts, GET /alerts/active (arrays), and all three PATCH actions (single row).
export const AlertRowSchema = z.object({
    id: z.number().int().nonnegative(),
    stream_id: z.string(),
    location: ZoneNameSchema,
    timestamp: z.string(), // when the event was first detected
    alert_level: z.number().int().min(0).max(100),
    alert_type: SeverityNameSchema,
    duration: z.number().int().nonnegative(), // seconds the ongoing event has lasted
    user_acknowledged: z.boolean(),
    false_positive_flag: z.boolean(),
    response_team_arrived_at: z.string().nullable(),
    cleared_at: z.string().nullable(),
    // null in the rare case the source detection couldn't be saved right away
    source_detection_id: z.number().int().nonnegative().nullable(),
});

// WebSocket alert payload = the row plus an `event` telling the UI what to do:
//   new      -> add a new alert card
//   continue -> update `duration` on the existing card (match by id)
//   escalate -> update alert_level / alert_type / duration on the existing card
const AlertDataSchema = AlertRowSchema.extend({
    event: AlertEventSchema,
});

// ---------------------------------------------------------------------------
// Envelopes: every WebSocket message is { type, stream_id, data }
// ---------------------------------------------------------------------------

export const FrameUpdateEnvelopeSchema = z.object({
    type: z.literal('frame_update'),
    stream_id: z.string(),
    data: FrameUpdateDataSchema,
});

export const AlertEnvelopeSchema = z.object({
    type: z.literal('alert'),
    stream_id: z.string(),
    data: AlertDataSchema,
});

export const DensityFeedEnvelopeSchema = z.discriminatedUnion('type', [
    FrameUpdateEnvelopeSchema,
    AlertEnvelopeSchema,
]);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type FrameData = z.infer<typeof FrameDataSchema>;
export type Zone = z.infer<typeof ZoneSchema>;
export type Cluster = z.infer<typeof ClusterSchema>;
export type AlertRow = z.infer<typeof AlertRowSchema>;
export type FrameUpdateEnvelope = z.infer<typeof FrameUpdateEnvelopeSchema>;
export type AlertEnvelope = z.infer<typeof AlertEnvelopeSchema>;
export type DensityFeedEnvelope = z.infer<typeof DensityFeedEnvelopeSchema>;
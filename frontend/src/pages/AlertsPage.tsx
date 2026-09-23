import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
    DensityFeedClient,
    DEFAULT_FEED_URL,
    type ConnectionStatus,
} from "../websocket/DensityFeedClient";
import type { AlertRow, SeverityName, ZoneName } from "../schemas/wsdetection.schema";
import {
    fetchActiveAlerts,
    acknowledgeAlert,
    markResponseTeamArrived,
    clearAlert,
} from "./AlertsApi";

// Must match the STREAM_ID in Dashboard.tsx -- this page shows history/live
// status for the same single camera, not a cross-camera alert feed.
const STREAM_ID = "cam-1";

type ActionKind = "acknowledge" | "team" | "clear";

// Buckets alerts are grouped into. Severity buckets mirror the backend's
// SeverityName; RESOLVED is a UI-only bucket for anything with cleared_at set,
// regardless of what severity it was at when it cleared.
type Bucket = SeverityName | "RESOLVED";
const BUCKET_ORDER: Bucket[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "RESOLVED"];

const SEVERITY_COLORS: Record<SeverityName, string> = {
    LOW: "#22c55e",
    MEDIUM: "#eab308",
    HIGH: "#f97316",
    CRITICAL: "#ef4444",
};
const RESOLVED_COLOR = "#6b7280";

const STATUS_DISPLAY: Record<ConnectionStatus, { color: string; label: string }> = {
    open: { color: "#22c55e", label: "Live" },
    connecting: { color: "#eab308", label: "Connecting" },
    closed: { color: "#ef4444", label: "Offline" },
};

const colors = {
    bg: "#0f1420",
    panel: "#161d2e",
    panelBorder: "#232c42",
    text: "#e5e9f2",
    subtext: "#8b93a8",
    accent: "#3b82f6",
    danger: "#ef4444",
};

function bucketOf(alert: AlertRow): Bucket {
    return alert.cleared_at ? "RESOLVED" : alert.alert_type;
}

function bucketColor(bucket: Bucket): string {
    return bucket === "RESOLVED" ? RESOLVED_COLOR : SEVERITY_COLORS[bucket];
}

function bucketLabel(bucket: Bucket): string {
    if (bucket === "RESOLVED") return "Resolved";
    return bucket.charAt(0) + bucket.slice(1).toLowerCase();
}

function formatZoneName(zone: ZoneName): string {
    return zone
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function formatTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "--:--:--";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

interface ActionButtonProps {
    label: string;
    doneLabel: string;
    doneDetail?: string | null;
    done: boolean;
    pending: boolean;
    onClick: () => void;
}

const ActionButton: React.FC<ActionButtonProps> = ({ label, doneLabel, doneDetail, done, pending, onClick }) => {
    if (done) {
        return (
            <span style={styles.actionDone}>
                ✓ {doneLabel}
                {doneDetail ? ` · ${doneDetail}` : ""}
            </span>
        );
    }
    return (
        <button style={styles.actionButton} onClick={onClick} disabled={pending}>
            {pending ? "…" : label}
        </button>
    );
};

export const AlertsPage: React.FC = () => {
    const navigate = useNavigate();

    const [alerts, setAlerts] = useState<AlertRow[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());

    // Initial list: GET /alerts/active
    useEffect(() => {
        let cancelled = false;
        fetchActiveAlerts()
            .then((rows) => {
                if (cancelled) return;
                setAlerts(rows.filter((row) => row.stream_id === STREAM_ID));
            })
            .catch((err) => {
                if (cancelled) return;
                console.error("[AlertsPage] failed to load active alerts", err);
                setLoadError("Could not load alerts from the server.");
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Live updates: one DensityFeedClient for this page, same pattern as Dashboard.tsx.
    // 'new' -> add a card, 'continue' / 'escalate' -> update the existing one by id.
    useEffect(() => {
        const client = new DensityFeedClient(DEFAULT_FEED_URL);

        const offStatus = client.onStatusChange(setStatus);

        const offAlert = client.onAlert((incoming) => {
            setAlerts((prev) => {
                const index = prev.findIndex((a) => a.id === incoming.id);
                if (index === -1) return [...prev, incoming];
                const updated = [...prev];
                updated[index] = incoming;
                return updated;
            });
        }, STREAM_ID);

        return () => {
            offStatus();
            offAlert();
            client.close();
        };
    }, []);

    const runAction = async (id: number, action: ActionKind) => {
        const key = `${id}:${action}`;
        setPendingActions((prev) => new Set(prev).add(key));
        try {
            const updated =
                action === "acknowledge"
                    ? await acknowledgeAlert(id)
                    : action === "team"
                        ? await markResponseTeamArrived(id)
                        : await clearAlert(id);
            setAlerts((prev) => prev.map((a) => (a.id === id ? updated : a)));
        } catch (err) {
            console.error(`[AlertsPage] ${action} failed for alert ${id}`, err);
        } finally {
            setPendingActions((prev) => {
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
        }
    };

    const grouped = BUCKET_ORDER.map((bucket) => ({
        bucket,
        alerts: alerts
            .filter((a) => bucketOf(a) === bucket)
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    })).filter((group) => group.alerts.length > 0);

    return (
        <div style={styles.page}>
            <style>
                {`
                    .alerts-grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
                        gap: 16px;
                        align-items: start;
                    }
                `}
            </style>

            <div style={styles.topRow}>
                <div>
                    <h1 style={styles.title}>Alert History</h1>
                    <p style={styles.subtitle}>Live and recent crowd density alerts for this camera.</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", color: colors.subtext }}>
                        <span
                            style={{
                                width: "8px",
                                height: "8px",
                                borderRadius: "50%",
                                backgroundColor: STATUS_DISPLAY[status].color,
                                display: "inline-block",
                            }}
                        />
                        {STATUS_DISPLAY[status].label}
                    </span>
                    <button style={styles.backButton} onClick={() => navigate("/")}>
                        ← Back to Dashboard
                    </button>
                </div>
            </div>

            {loadError && <div style={styles.errorBanner}>{loadError}</div>}

            {isLoading ? (
                <div style={styles.emptyState}>Loading alerts…</div>
            ) : grouped.length === 0 ? (
                <div style={styles.emptyState}>No alerts.</div>
            ) : (
                <div className="alerts-grid">
                    {grouped.map((group) => (
                        <div
                            key={group.bucket}
                            style={{
                                ...styles.card,
                                border: `1px solid ${bucketColor(group.bucket)}33`,
                                borderTop: `4px solid ${bucketColor(group.bucket)}`,
                            }}
                        >
                            <div style={styles.cardHeader}>
                                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                    <div
                                        style={{
                                            width: "10px",
                                            height: "10px",
                                            borderRadius: "50%",
                                            backgroundColor: bucketColor(group.bucket),
                                        }}
                                    />
                                    <span style={{ color: colors.text, fontWeight: 700, fontSize: "15px" }}>
                                        {bucketLabel(group.bucket)}
                                    </span>
                                </div>
                                <span
                                    style={{
                                        color: bucketColor(group.bucket),
                                        fontSize: "12px",
                                        fontWeight: 700,
                                        backgroundColor: `${bucketColor(group.bucket)}22`,
                                        padding: "2px 8px",
                                        borderRadius: "10px",
                                    }}
                                >
                                    {group.alerts.length}
                                </span>
                            </div>

                            <div>
                                {group.alerts.map((alert, index) => (
                                    <div
                                        key={alert.id}
                                        style={{
                                            padding: "12px 16px",
                                            borderBottom: index < group.alerts.length - 1 ? "1px solid #232c42" : "none",
                                        }}
                                    >
                                        <div style={styles.alertTopRow}>
                                            <span style={{ color: colors.text, fontWeight: 700, fontSize: "14px" }}>
                                                {formatZoneName(alert.location)}
                                            </span>
                                            <span
                                                style={{
                                                    color: bucketColor(bucketOf(alert)),
                                                    fontSize: "12px",
                                                    fontWeight: 700,
                                                    backgroundColor: `${bucketColor(bucketOf(alert))}22`,
                                                    padding: "1px 7px",
                                                    borderRadius: "8px",
                                                }}
                                            >
                                                {alert.alert_level}%
                                            </span>
                                        </div>

                                        <div style={styles.alertMetaRow}>
                                            <span>{formatTime(alert.timestamp)}</span>
                                            <span>
                                                {alert.cleared_at
                                                    ? `Cleared ${formatTime(alert.cleared_at)}`
                                                    : `Ongoing · ${formatDuration(alert.duration)}`}
                                            </span>
                                        </div>

                                        <div style={styles.actionsRow}>
                                            <ActionButton
                                                label="Acknowledge"
                                                doneLabel="Acknowledged"
                                                done={alert.user_acknowledged}
                                                pending={pendingActions.has(`${alert.id}:acknowledge`)}
                                                onClick={() => runAction(alert.id, "acknowledge")}
                                            />
                                            <ActionButton
                                                label="Team Arrived"
                                                doneLabel="Team arrived"
                                                doneDetail={alert.response_team_arrived_at ? formatTime(alert.response_team_arrived_at) : null}
                                                done={!!alert.response_team_arrived_at}
                                                pending={pendingActions.has(`${alert.id}:team`)}
                                                onClick={() => runAction(alert.id, "team")}
                                            />
                                            <ActionButton
                                                label="Clear"
                                                doneLabel="Cleared"
                                                doneDetail={alert.cleared_at ? formatTime(alert.cleared_at) : null}
                                                done={!!alert.cleared_at}
                                                pending={pendingActions.has(`${alert.id}:clear`)}
                                                onClick={() => runAction(alert.id, "clear")}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

const styles: Record<string, React.CSSProperties> = {
    page: {
        minHeight: "100vh",
        backgroundColor: colors.bg,
        color: colors.text,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        padding: "28px 24px 60px",
    },
    topRow: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        marginBottom: "22px",
        flexWrap: "wrap",
        gap: "12px",
    },
    title: {
        fontSize: "22px",
        fontWeight: 700,
        margin: "0 0 4px",
        color: colors.text,
    },
    subtitle: {
        fontSize: "13px",
        color: colors.subtext,
        margin: 0,
    },
    backButton: {
        padding: "8px 14px",
        backgroundColor: "transparent",
        color: colors.subtext,
        border: `1px solid ${colors.panelBorder}`,
        borderRadius: "6px",
        cursor: "pointer",
        fontSize: "13px",
    },
    errorBanner: {
        backgroundColor: "#2a1418",
        border: `1px solid ${colors.danger}55`,
        color: "#fca5a5",
        borderRadius: "8px",
        padding: "10px 14px",
        fontSize: "13px",
        marginBottom: "16px",
    },
    emptyState: {
        color: colors.subtext,
        fontSize: "14px",
        textAlign: "center",
        marginTop: "60px",
    },
    card: {
        backgroundColor: colors.panel,
        borderRadius: "10px",
        overflow: "hidden",
    },
    cardHeader: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 16px",
        borderBottom: `1px solid ${colors.panelBorder}`,
    },
    alertTopRow: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        marginBottom: "4px",
    },
    alertMetaRow: {
        display: "flex",
        justifyContent: "space-between",
        color: colors.subtext,
        fontSize: "11px",
        marginBottom: "8px",
    },
    actionsRow: {
        display: "flex",
        flexWrap: "wrap",
        gap: "6px",
    },
    actionButton: {
        padding: "4px 9px",
        backgroundColor: "transparent",
        color: colors.text,
        border: `1px solid ${colors.panelBorder}`,
        borderRadius: "6px",
        cursor: "pointer",
        fontSize: "11px",
    },
    actionDone: {
        padding: "4px 9px",
        color: colors.subtext,
        fontSize: "11px",
    },
};
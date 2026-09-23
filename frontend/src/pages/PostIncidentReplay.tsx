import React, { useEffect, useState } from "react";
import { useNavigate } from 'react-router-dom';
// NOTE: adjust these two relative paths to match where this file actually
// lives relative to src/schemas and src/(wherever wsdetection.ts is).
import type { AlertRow, ZoneName } from '../schemas/wsdetection.schema';
import { resolveSeverityName, type SeverityLevel } from '../types/wsdetection';

const API_BASE = "http://127.0.0.1:8000";

const LEVEL_COLORS: Record<SeverityLevel, string> = {
    Critical: '#ef4444',
    Elevated: '#f97316',
    Watch: '#eab308',
    Safe: '#3b82f6',
};
const RESOLVED_COLOR = '#6b7280';

function formatTimestamp(ts: string): string {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString();
}

function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
}

// 'top-left' -> 'Top Left'
function formatZoneName(zone: ZoneName): string {
    return zone
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

export const PostIncidentReplay: React.FC = () => {
    const navigate = useNavigate();

    const [alerts, setAlerts] = useState<AlertRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Optional filters — the backend only supports stream_id / location / limit
    const [streamId, setStreamId] = useState<string>('');
    const [locationFilter, setLocationFilter] = useState<string>('');
    const [limit, setLimit] = useState<number>(50);

    const fetchAlerts = () => {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        if (streamId.trim()) params.set('stream_id', streamId.trim());
        if (locationFilter.trim()) params.set('location', locationFilter.trim());
        params.set('limit', String(limit));

        fetch(`${API_BASE}/alerts?${params.toString()}`)
            .then((res) => {
                if (!res.ok) throw new Error(`GET /alerts failed: ${res.status}`);
                return res.json();
            })
            .then((data: AlertRow[]) => {
                // /alerts returns everything (acknowledged or not, cleared or not),
                // most-recent-first per the API — no client-side "active only" filter.
                setAlerts(data);
            })
            .catch((err) => setError(err.message || 'Failed to load alerts'))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        fetchAlerts();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
            <button
                onClick={() => navigate('/')}
                style={{
                    marginBottom: '16px',
                    padding: '8px 12px',
                    backgroundColor: '#6b7280',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '14px',
                }}
            >
                Back to Dashboard
            </button>

            <h1>Post-Incident Alert History</h1>

            {/* Filters — mirrors what GET /alerts actually accepts */}
            <div
                style={{
                    display: 'flex',
                    gap: '8px',
                    alignItems: 'flex-end',
                    marginBottom: '16px',
                    flexWrap: 'wrap',
                }}
            >
                <div>
                    <label style={{ display: 'block', fontSize: '12px', color: '#666' }}>
                        Stream ID
                    </label>
                    <input
                        value={streamId}
                        onChange={(e) => setStreamId(e.target.value)}
                        placeholder="optional"
                        style={{ padding: '6px 8px', border: '1px solid #ccc', borderRadius: '4px' }}
                    />
                </div>
                <div>
                    <label style={{ display: 'block', fontSize: '12px', color: '#666' }}>
                        Location
                    </label>
                    <input
                        value={locationFilter}
                        onChange={(e) => setLocationFilter(e.target.value)}
                        placeholder="e.g. top-left (optional)"
                        style={{ padding: '6px 8px', border: '1px solid #ccc', borderRadius: '4px' }}
                    />
                </div>
                <div>
                    <label style={{ display: 'block', fontSize: '12px', color: '#666' }}>
                        Limit
                    </label>
                    <input
                        type="number"
                        value={limit}
                        onChange={(e) => setLimit(Number(e.target.value) || 50)}
                        style={{ padding: '6px 8px', border: '1px solid #ccc', borderRadius: '4px', width: '80px' }}
                    />
                </div>
                <button
                    onClick={fetchAlerts}
                    style={{
                        padding: '8px 12px',
                        backgroundColor: '#3b82f6',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '14px',
                    }}
                >
                    Apply
                </button>
            </div>

            {loading && <p>Loading alerts…</p>}
            {error && <p style={{ color: '#ef4444' }}>Error loading alerts: {error}</p>}

            {!loading && !error && alerts.length === 0 && (
                <p style={{ color: '#666' }}>No alerts returned for this query.</p>
            )}

            <div style={{ marginTop: '2px' }}>
                {alerts.map((alert) => {
                    const isCleared = alert.cleared_at !== null;
                    const level = resolveSeverityName(alert.alert_type);
                    const levelColor = isCleared ? RESOLVED_COLOR : LEVEL_COLORS[level];

                    return (
                        <div
                            key={alert.id}
                            style={{
                                padding: '16px',
                                marginBottom: '12px',
                                border: '1px solid #ddd',
                                borderRadius: '6px',
                                backgroundColor: '#f9f9f9',
                            }}
                        >
                            <h3 style={{ margin: '0 0 4px 0' }}>
                                {formatTimestamp(alert.timestamp)}
                            </h3>
                            <p style={{ margin: '0 0 4px 0', color: '#666' }}>
                                <strong>Zone:</strong> {formatZoneName(alert.location)}
                                &nbsp;|&nbsp;
                                <strong>Stream:</strong> {alert.stream_id}
                            </p>
                            <p style={{ margin: '0 0 4px 0', color: '#666' }}>
                                <strong>Severity:</strong>{' '}
                                <span style={{ color: levelColor, fontWeight: 600 }}>
                                    {isCleared ? 'Resolved' : level.toUpperCase()}
                                </span>
                                {' '}
                                <span style={{ fontSize: '12px' }}>
                                    ({alert.alert_type}, score {alert.alert_level})
                                </span>
                                {alert.false_positive_flag && (
                                    <span style={{ marginLeft: '8px', color: '#9333ea', fontSize: '12px' }}>
                                        Flagged as false positive
                                    </span>
                                )}
                            </p>
                            <p style={{ margin: '0', color: '#666', fontSize: '12px' }}>
                                Duration: {formatDuration(alert.duration)} |{' '}
                                {isCleared
                                    ? `Cleared ${formatTimestamp(alert.cleared_at as string)}`
                                    : alert.user_acknowledged
                                    ? 'Acknowledged'
                                    : 'Unacknowledged'}
                                {alert.response_team_arrived_at && (
                                    <> | Response team arrived {formatTimestamp(alert.response_team_arrived_at)}</>
                                )}
                            </p>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
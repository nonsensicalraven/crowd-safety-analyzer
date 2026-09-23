import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useCameraFeed } from "../context/CameraFeedContext";
import { DensityFeedClient, DEFAULT_FEED_URL, type AlertData, type ConnectionStatus } from "../websocket/DensityFeedClient"; // NEW
import { ZONE_NAMES, type SeverityName, type Zone, type ZoneName } from "../schemas/wsdetection.schema"; // NEW
import { useFrameSender } from "../hooks/useFrameSender"; // ← NEW: wires frame uploads to the backend

// CHANGED: severity now uses the backend's severity_name (LOW / MEDIUM / HIGH / CRITICAL)
// instead of the old red / orange / yellow keys. This is a Record over every SeverityName,
// so TypeScript will flag any level that is missing a color (e.g. HIGH).
const SEVERITY_COLORS: Record<SeverityName, string> = {
    LOW: "#22c55e",
    MEDIUM: "#eab308",
    HIGH: "#f97316",
    CRITICAL: "#ef4444",
};

// CHANGED: replaces `const ZONE = "Zone 1"`. The dashboard shows one camera and the backend
// splits it into 6 grid zones. This must match the stream_id the frames are POSTed with
// (POST /streams/<STREAM_ID>/frames), because everything below is filtered to it.
const STREAM_ID = "cam-1";

// NEW: keep at most this many alerts on the board
const MAX_ALERTS = 100;

// NEW: header indicator, driven by the WebSocket connection status
const STATUS_DISPLAY: Record<ConnectionStatus, { color: string; label: string }> = {
    open: { color: "#22c55e", label: "Live" },
    connecting: { color: "#eab308", label: "Connecting" },
    closed: { color: "#ef4444", label: "Offline" },
};

// NEW: second line of an alert card, chosen by the message's `event`
const ALERT_EVENT_TEXT: Record<AlertData["event"], string> = {
    new: "New alert",
    continue: "Ongoing",
    escalate: "Escalated",
};

// CHANGED: PANEL_WIDTH removed — the video now sizes to 100% of its (responsive)
// container instead of a fixed pixel width. PANEL_HEIGHT kept as the panel's
// fixed height; object-fit: contain (below) letterboxes whatever aspect ratio
// the source video actually is, instead of cropping it to fill this box.
const PANEL_HEIGHT = 400;

// Layout dimensions for the dashboard grid
const SIDEBAR_WIDTH = 140;
const ALERT_BOARD_HEIGHT = 464;

// Left sidebar navigation links
const NAV_ITEMS: { label: string; path: string }[] = [
    { label: "Local Video", path: "/local-video" },
    { label: "Alert History", path: "/alerts" },
    { label: "Post-Incident Replay", path: "/replay" },
    { label: "Settings", path: "/settings" },
];

// REMOVED: GRID_CARD_HEIGHT and TOP_GRID_SLOTS — the "Densest grid #1/#2/#3"
// placeholder cards below the video are gone (they never had real data wired up).
// REMOVED: SAMPLE_MESSAGES, alertIdCounter and makeAlert() (the fake alert generator).

// NEW: backend timestamps are ISO 8601 UTC strings; show them in local time as before.
function formatTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "--:--:--";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const Dashboard: React.FC = () => {
    // CHANGED: starts empty (was 6 fake alerts); filled from the backend's 'alert' messages
    const [alerts, setAlerts] = useState<AlertData[]>([]);
    // NEW: latest state of each of the 6 zones, keyed by zone name (the backend sends them in no fixed order)
    const [zones, setZones] = useState<Partial<Record<ZoneName, Zone>>>({});
    // NEW: WebSocket connection status, for the header indicator and to dim stale zone readings
    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [autoScroll, setAutoScroll] = useState(true);
    const scrollRef = useRef<HTMLDivElement>(null);
    const { videoSrc, fileName } = useCameraFeed();

    // ← NEW: the <video> element that FrameSender grabs frames from.
    const videoRef = useRef<HTMLVideoElement>(null);

    // ← NEW: start uploading frames to the backend whenever a video is loaded.
    // FrameSender posts JPEG frames to POST /streams/{STREAM_ID}/frames at ~2 fps.
    // Once frames arrive, the backend broadcasts `frame_update` / `alert` messages
    // on /ws/dashboard, which the subscriptions below consume.
    const { status: senderStatus, error: senderError } = useFrameSender(
        videoRef,
        STREAM_ID,
        {
            // baseUrl defaults to http://127.0.0.1:8000 inside FrameSender, so we
            // can omit it. Pass it explicitly if you move the backend.
            intervalMs: 500, // ~2 fps; matches the backend's demo budget
            enabled: !!videoSrc, // don't run before a file is chosen
        },
    );

    // CHANGED: replaces the mock setInterval / makeAlert() generator.
    // One DensityFeedClient per mount; both subscriptions are limited to STREAM_ID.
    useEffect(() => {
        const client = new DensityFeedClient(DEFAULT_FEED_URL);
        const offStatus = client.onStatusChange(setStatus);
        // frame_update -> replace the state of all 6 zones. Look zones up by name, never by array position.
        const offFrame = client.onFrame((frame) => {
            const next: Partial<Record<ZoneName, Zone>> = {};
            for (const zone of frame.zones) next[zone.name] = zone;
            setZones(next);
        }, STREAM_ID);
        // alert -> match by id. 'new' adds a card; 'continue' / 'escalate' update the existing one.
        // If we join mid-event and see 'continue' first, the card is added instead of dropped.
        const offAlert = client.onAlert((incoming) => {
            setAlerts((prev) => {
                const index = prev.findIndex((a) => a.id === incoming.id);
                if (index === -1) return [...prev, incoming].slice(-MAX_ALERTS);
                const updated = [...prev];
                updated[index] = incoming;
                return updated;
            });
        }, STREAM_ID);
        return () => {
            offStatus();
            offFrame();
            offAlert();
            client.close();
        };
    }, []);

    // Auto-scroll to the latest alert, unless the user has scrolled up to read history
    useEffect(() => {
        if (autoScroll && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [alerts, autoScroll]);

    const handleAlertScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        setAutoScroll(nearBottom);
    };

    return (
        <div style={{ padding: '20px', fontFamily: 'sans-serif', backgroundColor: '#2b2b2c', minHeight: '100vh' }}>
            <h1 style={{color: '#fff'}}>Crowd Safety Analyzer</h1>
            <p style={{color: '#fff'}}>Live monitoring for Stampede Risk and Mitigation.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', marginTop: '30px', alignItems: 'flex-start' }}>
                {/* Left sidebar — navigation links */}
                <nav
                    style={{
                        width: SIDEBAR_WIDTH,
                        flex: `0 0 ${SIDEBAR_WIDTH}px`,
                        //alignSelf: 'stretch',
                        boxSizing: 'border-box',
                        backgroundColor: '#1c1c1e',
                        border: '1px solid #3a3a3c',
                        borderRadius: '8px',
                        padding: '10px',
                        display: 'flex',
                        flexDirection: 'column',
                    }}
                >
                    {NAV_ITEMS.map((item, index) => (
                        <Link
                            key={item.path}
                            to={item.path}
                            style={{
                                padding: '12px 4px',
                                color: '#e5e5e7',
                                textDecoration: 'none',
                                fontSize: '14px',
                                borderBottom:
                                    index < NAV_ITEMS.length - 1 ? '1px solid #3a3a3c' : 'none',
                            }}
                        >
                            {item.label}
                        </Link>
                    ))}
                </nav>
                {/* Main content column: camera feed only, now that the densest-grid cards are gone */}
                <div style={{ flex: '2 1 500px', minWidth: 0 }}>
                    {/* CHANGED: was a CSS grid with gridTemplateColumns: 'minmax(600px, 1fr)'.
                        That 600px floor is what caused the overlap with the alert board on
                        narrow windows — it forced this column to stay >= 600px wide even
                        when the flex layout had less room, so it overflowed sideways instead
                        of shrinking. A plain div has no such floor and shrinks with its
                        flex parent (which already has minWidth: 0 above). */}
                    <div style={{ width: '100%', maxWidth: '690px' }}>
                        {/* Camera feed display only — local video selection lives on /local-video */}
                        <div
                            style={{
                                border: '1px solid #ddd',
                                borderRadius: '8px',
                                width: '100%',
                                height: PANEL_HEIGHT,
                                // CHANGED: black instead of light gray, so any letterbox bars
                                // from object-fit: contain (below) read as intentional letterboxing.
                                backgroundColor: '#000',
                                position: 'relative',
                                overflow: 'hidden',
                                boxSizing: 'border-box',
                            }}
                        >
                            {!videoSrc && (
                                <div style={{ padding: '16px', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
                                    <h3 style={{ margin: 0, color: '#fff' }}>{STREAM_ID}</h3>
                                    <p style={{ margin: '8px 0 16px 0', color: '#999', fontSize: '14px' }}>
                                        Camera feed | Waiting for source
                                    </p>
                                    <div
                                        style={{
                                            flex: '1 1 auto',
                                            borderRadius: '8px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            color: '#666',
                                            fontSize: '14px',
                                            backgroundColor: '#111',
                                            textAlign: 'center',
                                            padding: '16px',
                                        }}
                                    >
                                        No camera feed yet. Use Local Video in the sidebar to choose a file.
                                    </div>
                                </div>
                            )}
                            {videoSrc && (
                                <>
                                    {/* CHANGED: width/height are now 100% of the panel (not fixed
                                        693x400 px) so the video shrinks with the panel instead of
                                        overflowing it. objectFit changed from 'cover' (crops to fill)
                                        to 'contain' (scales down to fit whole frame inside the box,
                                        letterboxing with the panel's black background on whichever
                                        sides don't match the box's aspect ratio) — this is what makes
                                        it work for any source resolution/aspect ratio without cropping.

                                        ← NEW: ref={videoRef} — FrameSender draws frames from this element. */}
                                    <video
                                        ref={videoRef}
                                        src={videoSrc}
                                        controls
                                        style={{
                                            width: '100%',
                                            height: '100%',
                                            objectFit: 'contain',
                                            display: 'block',
                                        }}
                                    />
                                    {fileName && (
                                        <div
                                            style={{
                                                position: 'absolute',
                                                top: 8,
                                                left: 8,
                                                padding: '6px 10px',
                                                backgroundColor: 'rgba(0,0,0,0.6)',
                                                color: '#fff',
                                                borderRadius: '6px',
                                                fontSize: '12px',
                                                maxWidth: '70%',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                            }}
                                        >
                                            {STREAM_ID} · {fileName}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                        {/* ← NEW: tiny upload-status line so you can see frames leaving the browser.
                            Remove this block once integration is confirmed working. */}
                        {videoSrc && (
                            <div style={{ marginTop: 6, fontSize: 11, color: '#8fa3bd' }}>
                                frame upload: <span style={{ color: senderStatus === 'error' ? '#ef4444' : senderStatus === 'sending' ? '#22c55e' : '#eab308' }}>{senderStatus}</span>
                                {senderError ? ` — ${senderError.message}` : ''}
                            </div>
                        )}
                    </div>
                </div>
                {/* Live alert board — CHANGED: real connection status in the header, 6-zone status grid, log fed by real alerts */}
                <div
                    style={{
                        width: '300px',
                        flex: '0 0 300px',
                        backgroundColor: '#1c1c1e',
                        border: '1px solid #3a3a3c',
                        borderRadius: '8px',
                        display: 'flex',
                        flexDirection: 'column',
                        height: ALERT_BOARD_HEIGHT,
                        overflow: 'hidden',
                    }}
                >
                    <div
                        style={{
                            padding: '12px 14px',
                            borderBottom: '1px solid #3a3a3c',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                        }}
                    >
                        <span style={{ color: '#fff', fontWeight: 'bold', fontSize: '14px' }}>Live Alerts</span>
                        <span
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                color: '#9ca3af',
                                fontSize: '12px',
                            }}
                        >
                            <span
                                style={{
                                    width: '8px',
                                    height: '8px',
                                    borderRadius: '50%',
                                    backgroundColor: STATUS_DISPLAY[status].color,
                                    display: 'inline-block',
                                }}
                            />
                            {STATUS_DISPLAY[status].label}
                        </span>
                    </div>
                    {/* NEW: live status of all 6 zones (from frame_update), in a fixed order that mirrors the
                        camera's 3x2 grid. Dimmed while the socket is down so old readings don't look current. */}
                    <div
                        style={{
                            padding: '10px',
                            borderBottom: '1px solid #3a3a3c',
                            display: 'grid',
                            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                            gap: '6px',
                            opacity: status === 'open' ? 1 : 0.45,
                        }}
                    >
                        {ZONE_NAMES.map((name) => {
                            const zone = zones[name];
                            const color = zone ? SEVERITY_COLORS[zone.severity_name] : '#5f5f63';
                            return (
                                <div
                                    key={name}
                                    style={{
                                        padding: '6px 8px',
                                        borderRadius: '6px',
                                        border: `1px solid ${zone ? color : '#3a3a3c'}`,
                                        backgroundColor: '#242427',
                                    }}
                                >
                                    <div
                                        style={{
                                            color: '#a1a1aa',
                                            fontSize: '10px',
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                        }}
                                    >
                                        {name}
                                    </div>
                                    <div style={{ color, fontWeight: 'bold', fontSize: '12px', letterSpacing: '0.03em' }}>
                                        {zone ? zone.severity_name : '—'}
                                    </div>
                                    <div style={{ color: '#5f5f63', fontSize: '10px' }}>
                                        {zone
                                            ? `${zone.person_count} ${zone.person_count === 1 ? 'person' : 'people'}`
                                            : 'no data'}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div
                        ref={scrollRef}
                        onScroll={handleAlertScroll}
                        style={{
                            flex: '1 1 auto',
                            overflowY: 'auto',
                            padding: '8px 10px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '2px',
                        }}
                    >
                        {alerts.length === 0 && (
                            <div style={{ color: '#5f5f63', fontSize: '12px', textAlign: 'center', marginTop: '16px' }}>
                                No alerts
                            </div>
                        )}
                        {alerts.map((alert) => (
                            <div
                                key={alert.id}
                                style={{
                                    padding: '6px 8px',
                                    borderRadius: '6px',
                                    fontSize: '13px',
                                    lineHeight: 1.4,
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
                                    <span
                                        style={{
                                            color: SEVERITY_COLORS[alert.alert_type],
                                            fontWeight: 'bold',
                                            fontSize: '11px',
                                            letterSpacing: '0.03em',
                                        }}
                                    >
                                        {alert.alert_type}
                                    </span>
                                    <span style={{ color: '#a1a1aa', fontSize: '11px' }}>{alert.location}</span>
                                    <span style={{ color: '#5f5f63', fontSize: '10px', marginLeft: 'auto' }}>
                                        {formatTime(alert.timestamp)}
                                    </span>
                                </div>
                                <div style={{ color: SEVERITY_COLORS[alert.alert_type], marginTop: '2px' }}>
                                    {ALERT_EVENT_TEXT[alert.event]} · {alert.duration}s
                                </div>
                            </div>
                        ))}
                    </div>
                    {!autoScroll && (
                        <button
                            onClick={() => {
                                setAutoScroll(true);
                                if (scrollRef.current) {
                                    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                                }
                            }}
                            style={{
                                margin: '8px',
                                padding: '6px',
                                backgroundColor: '#3b82f6',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontSize: '12px',
                                fontWeight: 'bold',
                            }}
                        >
                            ↓ Jump to latest
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
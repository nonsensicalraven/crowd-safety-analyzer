// src/mocks/scriptedDensityTimeline.ts
import { ZoneDensitySnapshot, DensityPoint } from '../types/density';

interface ScriptedHotspot {
    id: string;
    x: number;
    y: number;
    spread: number;
    count: number;
    weightMin: number;
    weightMax: number;
}

interface TimelineKeyframe {
    startTime: number;
    hotspots: ScriptedHotspot[];
}

// Hotspots only control the yellow/orange/red flare-ups.
// The blue "safe" field and the flowing traffic are handled separately below.
const TIMELINE: TimelineKeyframe[] = [
    {
        startTime: 0,
        hotspots: [
            { id: 'entrance', x: 200, y: 500, spread: 80, count: 10, weightMin: 0.3, weightMax: 0.5 },
        ],
    },
    {
        startTime: 10,
        hotspots: [
            { id: 'entrance', x: 200, y: 500, spread: 100, count: 35, weightMin: 0.6, weightMax: 0.85 },
            { id: 'concourse', x: 400, y: 300, spread: 150, count: 25, weightMin: 0.5, weightMax: 0.7 },
        ],
    },
    {
        startTime: 25,
        hotspots: [
            { id: 'concourse', x: 400, y: 300, spread: 180, count: 55, weightMin: 0.75, weightMax: 1.0 },
            { id: 'stage', x: 650, y: 250, spread: 100, count: 50, weightMin: 0.8, weightMax: 1.0 },
        ],
    },
    {
        startTime: 40,
        hotspots: [
            { id: 'stage', x: 650, y: 250, spread: 90, count: 65, weightMin: 0.85, weightMax: 1.0 },
        ],
    },
];

const ALL_HOTSPOT_IDS = Array.from(
    new Set(TIMELINE.flatMap(frame => frame.hotspots.map(h => h.id)))
);

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function zeroedHotspot(id: string, ref: ScriptedHotspot): ScriptedHotspot {
    return { ...ref, id, count: 0, weightMin: 0, weightMax: 0 };
}

function findHotspot(frame: TimelineKeyframe, id: string): ScriptedHotspot | undefined {
    return frame.hotspots.find(h => h.id === id);
}

function getSurroundingKeyframes(currentTime: number): [TimelineKeyframe, TimelineKeyframe, number] {
    if (currentTime <= TIMELINE[0].startTime) {
        return [TIMELINE[0], TIMELINE[0], 0];
    }
    for (let i = 0; i < TIMELINE.length - 1; i++) {
        const curr = TIMELINE[i];
        const next = TIMELINE[i + 1];
        if (currentTime >= curr.startTime && currentTime < next.startTime) {
            const t = (currentTime - curr.startTime) / (next.startTime - curr.startTime);
            return [curr, next, t];
        }
    }
    const last = TIMELINE[TIMELINE.length - 1];
    return [last, last, 0];
}

// --- Blue "safe" baseline field ---
// A dense, low-weight grid covering the whole canvas so the aggregated
// heatmap reads as a uniform blue field everywhere hotspots aren't active.
function generateBackgroundField(canvasWidth: number, canvasHeight: number): DensityPoint[] {
    const points: DensityPoint[] = [];
    const spacing = 25; // smaller = denser/more solid-looking field
    const now = new Date().toISOString();

    for (let x = 0; x <= canvasWidth; x += spacing) {
        for (let y = 0; y <= canvasHeight; y += spacing) {
            points.push({
                x: x + (Math.random() - 0.5) * spacing * 0.6,
                y: y + (Math.random() - 0.5) * spacing * 0.6,
                weight: 0.12 + Math.random() * 0.08, // low, stays blue
                timestamp: now,
            });
        }
    }
    return points;
}

// --- Right-to-left moving crowd stream ---
// A handful of horizontal "lanes" where points drift from right edge to left edge
// over time, wrapping around, to simulate the walking direction seen in the video.
interface StreamLane {
    y: number;
    speedPxPerSec: number;
    laneWidth: number; // vertical jitter band around y
    weightMin: number;
    weightMax: number;
    pointsPerLane: number;
}

const STREAM_LANES: StreamLane[] = [
    { y: 150, speedPxPerSec: 60, laneWidth: 40, weightMin: 0.3, weightMax: 0.5, pointsPerLane: 12 },
    { y: 350, speedPxPerSec: 45, laneWidth: 50, weightMin: 0.35, weightMax: 0.55, pointsPerLane: 14 },
    { y: 480, speedPxPerSec: 70, laneWidth: 35, weightMin: 0.3, weightMax: 0.45, pointsPerLane: 10 },
];

function generateMovingStream(
    currentTime: number,
    canvasWidth: number
): DensityPoint[] {
    const points: DensityPoint[] = [];
    const now = new Date().toISOString();

    for (const lane of STREAM_LANES) {
        for (let i = 0; i < lane.pointsPerLane; i++) {
            // Stagger each point's starting offset so they're spread along the lane,
            // not clumped together, then drift them all leftward with time.
            const stagger = (i / lane.pointsPerLane) * canvasWidth;
            const traveled = currentTime * lane.speedPxPerSec;
            // Start from the right edge, wrap around using modulo once fully off-screen left
            const rawX = canvasWidth - ((traveled + stagger) % (canvasWidth + 100));
            const x = rawX;

            points.push({
                x,
                y: lane.y + (Math.random() - 0.5) * lane.laneWidth,
                weight: lane.weightMin + Math.random() * (lane.weightMax - lane.weightMin),
                timestamp: now,
            });
        }
    }
    return points;
}

export function generateScriptedDensitySnapshot(
    zoneId: string,
    currentTime: number,
    canvasWidth: number = 800,
    canvasHeight: number = 600
): ZoneDensitySnapshot {
    const points: DensityPoint[] = [];
    const now = new Date().toISOString();

    // 1. Blue safe-zone baseline, everywhere
    //points.push(...generateBackgroundField(canvasWidth, canvasHeight));

    // 2. Right-to-left moving crowd traffic
    //points.push(...generateMovingStream(currentTime, canvasWidth));

    // 3. Scripted hotspots (yellow/orange/red flare-ups), interpolated smoothly
    const [frameA, frameB, t] = getSurroundingKeyframes(currentTime);

    for (const id of ALL_HOTSPOT_IDS) {
        const hA = findHotspot(frameA, id);
        const hB = findHotspot(frameB, id);
        const a = hA ?? (hB ? zeroedHotspot(id, hB) : undefined);
        const b = hB ?? (hA ? zeroedHotspot(id, hA) : undefined);
        if (!a || !b) continue;

        const interpolated: ScriptedHotspot = {
            id,
            x: lerp(a.x, b.x, t),
            y: lerp(a.y, b.y, t),
            spread: lerp(a.spread, b.spread, t),
            count: Math.round(lerp(a.count, b.count, t)),
            weightMin: lerp(a.weightMin, b.weightMin, t),
            weightMax: lerp(a.weightMax, b.weightMax, t),
        };

        for (let i = 0; i < interpolated.count; i++) {
            points.push({
                x: interpolated.x + (Math.random() - 0.5) * interpolated.spread,
                y: interpolated.y + (Math.random() - 0.5) * interpolated.spread,
                weight:
                    interpolated.weightMin +
                    Math.random() * Math.max(0, interpolated.weightMax - interpolated.weightMin),
                timestamp: now,
            });
        }
    }

    return { zoneId, points, updatedAt: now };
}
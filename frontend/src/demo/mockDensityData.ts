import { ZoneDensitySnapshot, DensityPoint } from '../types/density';

/* Generate mock density points in a cluster pattern.
   Simulates hotspots in a venue.
*/

export function generateMockDensitySnapshot(
    zoneId: string,
    canvasWidth: number = 800,
    canvasHeight: number = 600
): ZoneDensitySnapshot {
    const points: DensityPoint[] = [];
    const now = new Date().toISOString();

    //Hotspot 1: Main entrance (bottom-left cluster)
    const hotspot1 = {x: 200, y: 500};
    for (let i=0; i<40; i++){
        points.push({
            x: hotspot1.x + (Math.random() - 0.5) * 150,
            y: hotspot1.y + (Math.random() - 0.5) * 100,
            weight: 0.6 + Math.random() * 0.4,
            timestamp: now,
        });
    }

    //hotspot 2: Central concourse (mid-center)
    const hotspot2 = {x:400, y:300};
    for (let i=0; i<60; i++){
        points.push({
            x: hotspot2.x + (Math.random() - 0.5) * 200,
            y: hotspot2.y + (Math.random() - 0.5) * 180,
            weight: 0.7 + Math.random() *0.3,
            timestamp: now,
        });
    }

    //hotspot 3: Stage/focal point (top-right)
    const hotspot3 = {x: 650, y: 250};
    for (let i=0; i<50; i++){
        points.push({
            x: hotspot3.x + (Math.random() - 0.5) * 120,
            y: hotspot3.y + (Math.random() - 0.5) * 120,
            weight: 0.5 + Math.random() * 0.5,
            timestamp: now,
        });
    }

    //Light background scatter
    for (let i=0; i<30; i++){
        points.push({
            x: Math.random() * canvasWidth,
            y: Math.random() * canvasHeight,
            weight: 0.1 + Math.random() * 0.2,
            timestamp: now,
        });
    }

    return {
        zoneId,
        points,
        updatedAt: now,
    };
}
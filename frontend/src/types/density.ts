export interface DensityPoint {
    x: number;
    y: number;
    weight: number;
    zoneId?: string;
    timestamp?: string;
}

export interface ZoneDensitySnapshot {
    zoneId: string;
    points: DensityPoint[];
    updatedAt: string;
}
import { useEffect, useState, useCallback } from 'react';
import { DensityPointsSchema } from '../schemas/density';
import type { DensityPoint, ZoneDensitySnapshot } from '../types/density';

interface UseDensityPointsOptions {
  source?: 'mock' | 'websocket';
  refreshIntervalMs?: number;
  zoneId?: string;
  width?: number;
  height?: number;
}

// --- REPLACE the old generateMockPoints with this block ---

function randomGaussian(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

interface ClusterConfig {
  clusterCount?: number;

  // core blob (the big signature)
  coreSize?: number;        // points in the dense core
  coreSpread?: number;      // px std-dev — small = tight overlapping blob
  coreWeight?: number;      // base weight per core point (higher = "hotter"/bigger on heatmap)

  // satellite groups (separate but clumped nearby)
  satelliteGroups?: number;     // how many small clumps surround the core
  satelliteGroupSize?: number;  // people per satellite clump
  satelliteSpread?: number;     // px std-dev within a satellite clump (tight, like the core but smaller)
  satelliteMinDist?: number;    // min distance of a satellite clump from core center
  satelliteMaxDist?: number;    // max distance of a satellite clump from core center
  satelliteWeight?: number;     // base weight per satellite point (lower = smaller/cooler than core)
}

function generateMockPoints(
  width = 800,
  height = 600,
  {
    clusterCount = 3,
    coreSize = 100,
    coreSpread = 50,
    coreWeight = 50,
    satelliteGroups = 4,
    satelliteGroupSize = 10,
    satelliteSpread = 8,
    satelliteMinDist = 60,
    satelliteMaxDist = 140,
    satelliteWeight = 3,
  }: ClusterConfig = {}
): DensityPoint[] {
  const points: DensityPoint[] = [];
  const now = new Date().toISOString();
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);

  for (let c = 0; c < clusterCount; c++) {
    const centerX = width * 0.15 + Math.random() * width * 0.7;
    const centerY = height * 0.15 + Math.random() * height * 0.7;

    // --- dense core: tight spread + overlapping points = one big blob ---
    for (let i = 0; i < coreSize; i++) {
      points.push({
        x: clamp(centerX + randomGaussian() * coreSpread, width),
        y: clamp(centerY + randomGaussian() * coreSpread, height),
        weight: coreWeight * (0.8 + Math.random() * 0.4),
        timestamp: now,
      });
    }

    // --- satellite clumps: small separate groups orbiting the core ---
    for (let g = 0; g < satelliteGroups; g++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = satelliteMinDist + Math.random() * (satelliteMaxDist - satelliteMinDist);
      const groupCenterX = centerX + Math.cos(angle) * dist;
      const groupCenterY = centerY + Math.sin(angle) * dist;

      for (let i = 0; i < satelliteGroupSize; i++) {
        points.push({
          x: clamp(groupCenterX + randomGaussian() * satelliteSpread, width),
          y: clamp(groupCenterY + randomGaussian() * satelliteSpread, height),
          weight: satelliteWeight * (0.7 + Math.random() * 0.6),
          timestamp: now,
        });
      }
    }
  }

  return points;
}

// --- end replacement ---

export function useDensityPoints({
  source = 'mock',
  refreshIntervalMs = 2000,
  zoneId = 'zone-1',
  width = 800,
  height = 600,
}: UseDensityPointsOptions = {}) {
  const [snapshot, setSnapshot] = useState<ZoneDensitySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ingest = useCallback((rawPoints: unknown) => {
    const result = DensityPointsSchema.safeParse(rawPoints);
    if (!result.success) {
      setError(result.error.message);
      return;
    }
    setError(null);
    setSnapshot({ zoneId, updatedAt: new Date().toISOString(), points: result.data });
  }, [zoneId]);

  useEffect(() => {
    if (source !== 'mock') return;
    // --- UPDATED call sites (dropped the `count` arg) ---
    ingest(generateMockPoints(width, height));
    const interval = setInterval(() => ingest(generateMockPoints(width, height)), refreshIntervalMs);
    return () => clearInterval(interval);
  }, [source, refreshIntervalMs, ingest, width, height]);

  return { snapshot, error, ingest };
}
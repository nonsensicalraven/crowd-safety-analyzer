// src/components/HeatmapCanvas.tsx
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { OrthographicViewState } from '@deck.gl/core';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import type { DensityPoint } from '../types/density';

interface HeatmapCanvasProps {
  points: DensityPoint[];
  width: number;
  height: number;
  radiusPixels?: number;
  intensity?: number;
  threshold?: number;
}

const INITIAL_VIEW_STATE: OrthographicViewState = {
  target: [0, 0, 0],
  zoom: 0, 
};

export function HeatmapCanvas({
  points,
  width,
  height,
  radiusPixels = 50,
  intensity = 1,
  threshold = 0.05,
}: HeatmapCanvasProps) {
  const layer = new HeatmapLayer<DensityPoint>({
    id: 'density-heatmap',
    data: points,
    getPosition: (d) => [d.x, d.y],
    getWeight: (d) => d.weight,
    radiusPixels,
    intensity,
    threshold,
    colorRange: [
      [0, 0, 255, 0],
      [0, 255, 255, 120],
      [0, 255, 0, 160],
      [255, 255, 0, 200],
      [255, 128, 0, 220],
      [255, 0, 0, 255],
    ],
  });

  return (
    <DeckGL
      views={new OrthographicView({ id: 'ortho' })}
      initialViewState={INITIAL_VIEW_STATE}
      controller
      layers={[layer]}
      style={{ width: `${width}px`, height: `${height}px`, position: 'relative' }}
    />
  );
}
import { z } from 'zod';

export const DensityPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  weight: z.number().min(0),
  zoneId: z.string().optional(),
  timestamp: z.string().optional(),
});

export const DensityPointsSchema = z.array(DensityPointSchema);
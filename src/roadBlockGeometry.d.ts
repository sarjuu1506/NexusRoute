export type Coordinate = [number, number];

export function distanceMeters(first: Coordinate, second: Coordinate): number;
export function distanceAlongRoute(route: Coordinate[]): number;
export function orientRouteForTrip(
  route: Coordinate[],
  origin: Coordinate,
  destination: Coordinate,
  maximumEndpointDistance?: number
): Coordinate[] | null;
export function pointAtDistance(route: Coordinate[], distance: number): { point: Coordinate; index: number } | null;
export function remainingRoute(route: Coordinate[], progressMeters: number): Coordinate[];
export function makeCirclePolygon(point: Coordinate, radiusMeters: number): Coordinate[];
export function pointInPolygon(point: Coordinate, polygon: Coordinate[]): boolean;
export function firstPolygonIntersectionFraction(start: Coordinate, end: Coordinate, polygon: Coordinate[]): number | null;
export function routeIntersectsPolygon(route: Coordinate[], polygon: Coordinate[], fromProgressMeters?: number): boolean;
export function advanceAlongRoute(
  route: Coordinate[],
  progressMeters: number,
  distanceToAdvance: number,
  polygon: Coordinate[],
  stopBufferMeters?: number
): { progressMeters: number; point: Coordinate; blocked: boolean };

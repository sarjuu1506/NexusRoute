import type { Vehicle, RoadEvent } from "./types";
import { makeCirclePolygon } from "./roadBlockGeometry.js";

export const demoVehicleProfiles: Pick<Vehicle, "id" | "name" | "speedKph" | "load">[] = [
  { id: "TX-01", name: "TX-01", speedKph: 28, load: "78%" },
  { id: "TX-03", name: "TX-03", speedKph: 34, load: "91%" },
  { id: "TX-07", name: "TX-07", speedKph: 39, load: "64%" }
];

export function createRoadBlock(point: [number, number], vehicleName: string): RoadEvent {
  const radiusMeters = 150;
  return {
    id: `block-${crypto.randomUUID()}`,
    title: "Road block",
    road: `On ${vehicleName}'s road`,
    severity: "HIGH",
    distance: "On vehicle route",
    source: "Demo road block",
    lng: point[0],
    lat: point[1],
    state: "ACTIVE",
    freshness: "Just now",
    radiusMeters,
    polygon: makeCirclePolygon(point, radiusMeters),
    simulated: true
  };
}

export function createTrafficObstacle(
  id: string,
  title: string,
  coordinates: [number, number],
  distanceKm: number
): RoadEvent {
  const radiusMeters = 150;
  return {
    id,
    title,
    road: "Nearby road",
    severity: "MEDIUM",
    distance: `${distanceKm.toFixed(1)} km from you`,
    source: "TomTom live traffic",
    lng: coordinates[0],
    lat: coordinates[1],
    state: "REPORTED",
    freshness: "Live feed",
    radiusMeters,
    polygon: makeCirclePolygon(coordinates, radiusMeters),
    simulated: false
  };
}

export const emptyVehicles: Vehicle[] = [];
export const emptyObstacles: RoadEvent[] = [];
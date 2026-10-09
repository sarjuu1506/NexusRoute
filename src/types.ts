export type Vehicle = {
  id: string;
  name: string;
  status: "On route" | "At risk" | "Blocked ahead" | "Rerouted" | "Delivered" | string;
  speedKph: number;
  etaSeconds: number;
  load: string;
  lng: number;
  lat: number;
  routeCoordinates: [number, number][];
  previousRouteCoordinates?: [number, number][];
  progressMeters: number;
  source: "Demo vehicle" | "Demo truck" | string;
  riskObstacleId?: string;
  bypassedObstacleId?: string;
  deliveries?: number;
  startRoadName?: string;
  destRoadName?: string;
};
export type RoadEvent = {
  id: string;
  title: string;
  road: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  distance: string;
  source: string;
  lng: number;
  lat: number;
  state: string;
  freshness: string;
  radiusMeters: number;
  polygon?: [number, number][];
  simulated: boolean;
};
export type UserLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
};
export type RouteAlternative = {
  id: string;
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  avoidsObstacle: boolean;
  extraTimeSeconds: number;
};
export type Destination = {
  label: string;
  coordinates: [number, number];
};
import type { RoadEvent, RouteAlternative, UserLocation, Vehicle } from "../types";

async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new Error(result.error ?? `Backend request failed with HTTP ${response.status}.`);
  }
  return result;
}

function post<T>(path: string, body: unknown, signal?: AbortSignal) {
  return apiRequest<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
    signal
  });
}

export function createDemoVehicles(location: UserLocation, signal?: AbortSignal) {
  return post<{ vehicles: Vehicle[]; count: number; created: number }>(
    "/api/demo/vehicles",
    { location },
    signal
  );
}

export function createDemoTruck(location: UserLocation, signal?: AbortSignal) {
  return post<{ truck: Vehicle; obstacle: RoadEvent }>(
    "/api/demo/truck",
    { location },
    signal
  );
}

export function createDemoTrafficJams(location: UserLocation, signal?: AbortSignal) {
  return post<{ jams: RoadEvent[]; obstacles: RoadEvent[] }>("/api/demo/jams", { location }, signal);
}



export function createNearbyRoadBlock(
  location: UserLocation,
  vehicles: Vehicle[],
  signal?: AbortSignal
) {
  return post<RoadEvent>("/api/obstacles/nearby", { location, vehicles }, signal);
}

export async function getRoute(
  origin: [number, number],
  destination: [number, number],
  obstacles: RoadEvent[],
  signal?: AbortSignal
) {
  try {
    return await post<{ routes: RouteAlternative[] }>("/api/route", {
      origin,
      destination,
      obstacles
    }, signal);
  } catch (backendError) {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${origin[0]},${origin[1]};${destination[0]},${destination[1]}?overview=full&geometries=geojson`;
      const response = await fetch(url, { signal });
      if (!response.ok) throw backendError;
      const data = await response.json();
      if (data.code === "Ok" && Array.isArray(data.routes) && data.routes.length > 0) {
        const route = data.routes[0];
        return {
          routes: [
            {
              id: "osrm-route-1",
              coordinates: route.geometry.coordinates as [number, number][],
              distanceMeters: route.distance,
              durationSeconds: route.duration,
              avoidsObstacle: true,
              extraTimeSeconds: 0
            }
          ]
        };
      }
    } catch {
      // ignore client fallback error and throw original
    }
    throw backendError;
  }
}

export type AlternativePlan = {
  id: string;
  routes: RouteAlternative[];
  recommendation: string | null;
  wait: boolean;
  reason: string;
  reasonSource: "template" | "gemini";
  baselineDurationSeconds: number | null;
};

export function getAlternatives(
  origin: [number, number],
  destination: [number, number],
  obstacle: RoadEvent,
  signal?: AbortSignal
) {
  return post<AlternativePlan>("/api/alternatives", {
    origin,
    destination,
    obstacle
  }, signal);
}

export function rerouteVehicle(
  origin: [number, number],
  destination: [number, number],
  obstaclePolygon: [number, number][],
  signal?: AbortSignal
) {
  return post<AlternativePlan>("/api/reroute", {
    origin,
    destination,
    obstaclePolygon: { type: "Polygon", coordinates: [obstaclePolygon] }
  }, signal);
}

export function getNearbyIncidents(location: UserLocation, signal?: AbortSignal) {
  return post<{ incidents: RoadEvent[]; configured: boolean }>(
    "/api/incidents",
    { location },
    signal
  );
}

export function searchPlaces(
  query: string,
  location: UserLocation | null,
  signal?: AbortSignal
) {
  const params = new URLSearchParams({ q: query });
  if (location) {
    params.set("lat", String(location.latitude));
    params.set("lon", String(location.longitude));
  }
  return apiRequest<{ features?: unknown[] }>(`/api/places?${params.toString()}`, { signal });
}

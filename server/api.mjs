import { randomUUID } from "node:crypto";
import {
  distanceAlongRoute,
  makeCirclePolygon,
  makeCorridorPolygon,
  segmentAtDistance,
  orientRouteForTrip,
  pointAtDistance,
  routeIntersectsPolygon
} from "../src/roadBlockGeometry.js";

const EARTH_RADIUS_METERS = 6_371_000;
const INCIDENT_RADIUS_METERS = 150;
const REROUTE_CLEARANCE_SCALE = 1.3;
const DEMO_TRIP_DISTANCE_METERS = 1_500;
const VEHICLE_PROFILES = [
  { id: "TX-01", name: "TX-01", speedKph: 28, desiredDistance: 110, bearing: 25, load: "78%" },
  { id: "TX-03", name: "TX-03", speedKph: 34, desiredDistance: 165, bearing: 145, load: "91%" },
  { id: "TX-07", name: "TX-07", speedKph: 39, desiredDistance: 220, bearing: 265, load: "64%" }
];

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body is too large.");
  }
  return body ? JSON.parse(body) : {};
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function coordinate(value) {
  return Array.isArray(value)
    && value.length >= 2
    && number(value[0])
    && number(value[1])
    && value[0] >= -180
    && value[0] <= 180
    && value[1] >= -90
    && value[1] <= 90;
}

function haversine(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latDelta = radians(second[1] - first[1]);
  const lngDelta = radians(second[0] - first[0]);
  const value = Math.sin(latDelta / 2) ** 2
    + Math.cos(radians(first[1])) * Math.cos(radians(second[1])) * Math.sin(lngDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function destinationPoint(origin, distanceMeters, bearingDegrees) {
  const bearing = bearingDegrees * Math.PI / 180;
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const latitude = origin[1] * Math.PI / 180;
  const longitude = origin[0] * Math.PI / 180;
  const nextLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance)
    + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const nextLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(nextLatitude)
  );
  return [nextLongitude * 180 / Math.PI, nextLatitude * 180 / Math.PI];
}

function pointToSegmentDistance(point, start, end) {
  const latitudeScale = Math.PI / 180 * EARTH_RADIUS_METERS;
  const longitudeScale = latitudeScale * Math.cos(point[1] * Math.PI / 180);
  const x = (coordinate) => (coordinate[0] - point[0]) * longitudeScale;
  const y = (coordinate) => (coordinate[1] - point[1]) * latitudeScale;
  const sx = x(start);
  const sy = y(start);
  const ex = x(end);
  const ey = y(end);
  const dx = ex - sx;
  const dy = ey - sy;
  const denominator = dx * dx + dy * dy;
  const fraction = denominator === 0 ? 0 : Math.max(0, Math.min(1, -(sx * dx + sy * dy) / denominator));
  return Math.hypot(sx + fraction * dx, sy + fraction * dy);
}

function distanceToLine(point, coordinates) {
  if (!coordinates.length) return Number.POSITIVE_INFINITY;
  if (coordinates.length === 1) return haversine(point, coordinates[0]);
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < coordinates.length; index += 1) {
    minimum = Math.min(minimum, pointToSegmentDistance(point, coordinates[index - 1], coordinates[index]));
  }
  return minimum;
}

function routeCoordinates(feature) {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates)) return [];
  return coordinates.filter((item) => coordinate(item)).map((item) => [item[0], item[1]]);
}

function routeSummary(feature) {
  const summary = feature?.properties?.summary;
  const distance = summary?.distance;
  const duration = summary?.duration;
  if (!number(distance) || !number(duration)) return null;
  const coordinates = routeCoordinates(feature);
  if (coordinates.length < 2) return null;
  return { coordinates, distanceMeters: distance, durationSeconds: duration };
}

async function requestOrs(path, body) {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) {
    const error = new Error("The routing service is not configured on the backend.");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(`https://api.openrouteservice.org${path}`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`OpenRouteService HTTP ${response.status}: ${errorBody}`);
    const error = new Error(`Routing service returned HTTP ${response.status}.`);
    error.statusCode = response.status >= 500 ? 502 : 422;
    throw error;
  }
  return response.json();
}

async function requestOsrm(coordinates) {
  const coordString = coordinates.map((c) => `${c[0]},${c[1]}`).join(";");
  const response = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${coordString}?overview=full&geometries=geojson`
  );
  if (!response.ok) {
    throw new Error(`OSRM routing returned HTTP ${response.status}.`);
  }
  const data = await response.json();
  if (data.code !== "Ok" || !Array.isArray(data.routes) || !data.routes.length) {
    throw new Error("No driving route found to this destination.");
  }
  return data.routes.map((route) => ({
    coordinates: route.geometry.coordinates,
    distanceMeters: route.distance,
    durationSeconds: route.duration
  }));
}

async function directions(coordinates, options = {}, alternatives = false) {
  try {
    const body = { coordinates, options };
    if (alternatives) body.alternative_routes = { target_count: 3, weight_factor: 1.6, share_factor: 0.6 };
    const response = await requestOrs("/v2/directions/driving-car/geojson", body);
    const routes = (response.features ?? []).map(routeSummary).filter(Boolean);
    if (!routes.length) {
      throw new Error("The routing service returned no usable road geometry.");
    }
    return routes;
  } catch (error) {
    try {
      const osrmRoutes = await requestOsrm(coordinates);
      if (osrmRoutes && osrmRoutes.length) {
        return osrmRoutes;
      }
    } catch {
      // If OSRM also fails, re-throw the original error to preserve error reporting
    }
    throw error;
  }
}

function makeObstaclePolygon(point, radiusMeters) {
  const latitudeDelta = radiusMeters / 111_320;
  const longitudeDelta = radiusMeters / (111_320 * Math.cos(point[1] * Math.PI / 180));
  const ring = [];
  for (let index = 0; index <= 32; index += 1) {
    const angle = index * Math.PI * 2 / 32;
    ring.push([
      point[0] + Math.cos(angle) * longitudeDelta,
      point[1] + Math.sin(angle) * latitudeDelta
    ]);
  }
  return { type: "MultiPolygon", coordinates: [[[...ring]]] };
}

function nearestPolylinePoint(point, polylines, maximumDistance = 1_000) {
  let best = null;
  let bestDistance = maximumDistance;
  for (const line of polylines) {
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      const latitudeScale = Math.PI / 180 * EARTH_RADIUS_METERS;
      const longitudeScale = latitudeScale * Math.cos(point[1] * Math.PI / 180);
      const sx = (start[0] - point[0]) * longitudeScale;
      const sy = (start[1] - point[1]) * latitudeScale;
      const ex = (end[0] - point[0]) * longitudeScale;
      const ey = (end[1] - point[1]) * latitudeScale;
      const dx = ex - sx;
      const dy = ey - sy;
      const denominator = dx * dx + dy * dy;
      const fraction = denominator === 0 ? 0 : Math.max(0, Math.min(1, -(sx * dx + sy * dy) / denominator));
      const snapped = [start[0] + fraction * (end[0] - start[0]), start[1] + fraction * (end[1] - start[1])];
      const distance = haversine(point, snapped);
      if (distance < bestDistance) {
        best = snapped;
        bestDistance = distance;
      }
    }
  }
  return best ? { point: best, distanceMeters: bestDistance, fallback: true } : null;
}

function selectVehicleRoute(coordinates, origin, desiredDistance) {
  const start = pointAtDistance(coordinates, desiredDistance);
  if (!start || coordinates.length < 2
    || haversine(origin, start.point) < 75
    || haversine(origin, start.point) > 250) return null;
  return [start.point, ...coordinates.slice(start.index)];
}

function cleanObstacle(value) {
  return value && coordinate([value.lng, value.lat]) && typeof value.id === "string"
    ? value
    : null;
}

async function createDemoVehicles(location) {
  const origin = [location.longitude, location.latitude];
  let routingError = null;
  const results = await Promise.all(VEHICLE_PROFILES.map(async (profile) => {
    const target = destinationPoint(origin, DEMO_TRIP_DISTANCE_METERS, profile.bearing);
    try {
      const routes = await directions([origin, target]);
      const route = routes[0];
      const routeGeometry = selectVehicleRoute(route.coordinates, origin, profile.desiredDistance);
      if (!routeGeometry || routeGeometry.length < 2) return null;
      
      const snapped = await snapPoint(routeGeometry[0], [routeGeometry]);
      if (snapped.distanceMeters > 30) {
        console.warn(`Initial placement for ${profile.name} could not snap within 30m.`);
        return null;
      }
      routeGeometry[0] = snapped.point;

      const routeDistance = routeGeometry.slice(1).reduce(
        (sum, point, index) => sum + haversine(routeGeometry[index], point),
        0
      );
      return {
        id: profile.id,
        name: profile.name,
        status: "On route",
        speedKph: profile.speedKph,
        load: profile.load,
        etaSeconds: routeDistance / (profile.speedKph / 3.6),
        progressMeters: 0,
        routeCoordinates: routeGeometry,
        lng: routeGeometry[0][0],
        lat: routeGeometry[0][1],
        source: "Demo vehicle"
      };
    } catch (error) {
      routingError ??= error;
      console.warn(`Could not create ${profile.name} demo route: ${error.message}`);
      return null;
    }
  }));
  const vehicles = results.filter(Boolean);
  if (!vehicles.length) {
    if (routingError) {
      routingError.statusCode ??= 502;
      throw routingError;
    }
    const error = new Error("Could not create any nearby demo vehicles on a routable road.");
    error.statusCode = 422;
    throw error;
  }
  return { vehicles, count: VEHICLE_PROFILES.length, created: vehicles.length };
}

async function createNearbyRoadBlock(body) {
  const location = body.location;
  if (!location || !number(location.longitude) || !number(location.latitude)
    || !Array.isArray(body.vehicles)) {
    const error = new Error("A live location and demo vehicle routes are required.");
    error.statusCode = 400;
    throw error;
  }

  const origin = [location.longitude, location.latitude];
  const candidates = [];
  for (const vehicle of body.vehicles) {
    if (!Array.isArray(vehicle?.routeCoordinates)
      || vehicle.routeCoordinates.length < 2
      || !vehicle.routeCoordinates.every(coordinate)) continue;
    const progress = number(vehicle.progressMeters) ? vehicle.progressMeters : 0;
    const routeLength = distanceAlongRoute(vehicle.routeCoordinates);
    for (let routeProgress = progress + 25; routeProgress < routeLength; routeProgress += 25) {
      const roadPoint = pointAtDistance(vehicle.routeCoordinates, routeProgress)?.point;
      if (!roadPoint) continue;
      const distanceFromUser = haversine(origin, roadPoint);
      if (distanceFromUser < 300 || distanceFromUser > 800) continue;
      candidates.push({
        vehicle,
        progressMeters: progress,
        routeProgress,
        routePoint: roadPoint,
        distanceFromUser,
        preference: Math.abs(distanceFromUser - 550)
      });
    }
  }

  candidates.sort((left, right) => left.preference - right.preference);
  for (const candidate of candidates) {
    const snapped = await snapPoint(candidate.routePoint, [candidate.vehicle.routeCoordinates]);
    
    const segment = segmentAtDistance(candidate.vehicle.routeCoordinates, candidate.routeProgress);
    const radiusMeters = 25;
    const polygon = segment 
      ? makeCorridorPolygon(segment.start, segment.end, radiusMeters) 
      : makeCirclePolygon(snapped.point, radiusMeters);

    if (snapped.distanceMeters > 20
      || !routeIntersectsPolygon(
        candidate.vehicle.routeCoordinates,
        polygon,
        candidate.progressMeters
      )) continue;
    const distanceFromUser = haversine(origin, snapped.point);
    if (distanceFromUser < 300 || distanceFromUser > 800) continue;
    
    return {
      id: `block-${randomUUID()}`,
      title: "Road block",
      road: `On ${candidate.vehicle.name}'s route`,
      severity: "HIGH",
      distance: `${Math.round(distanceFromUser)} m from you`,
      source: "Demo road block",
      lng: snapped.point[0],
      lat: snapped.point[1],
      polygon,
      state: "ACTIVE",
      freshness: "Just now",
      radiusMeters,
      simulated: true
    };
  }

  const error = new Error("Could not place a snapped road block 300–800 m ahead on a demo vehicle route.");
  error.statusCode = 422;
  throw error;
}

async function snapPoint(point, cachedRoutes = []) {
  const apiKey = process.env.ORS_API_KEY;
  if (apiKey) {
    try {
      const response = await requestOrs("/v2/snap/driving-car/json", {
        locations: [point],
        radius: 1_000
      });
      const snapped = response.locations?.[0]?.location
        ?? response.locations?.[0]?.coordinates
        ?? response.features?.[0]?.geometry?.coordinates;
      if (coordinate(snapped)) {
        const snappedPoint = [snapped[0], snapped[1]];
        return { point: snappedPoint, distanceMeters: haversine(point, snappedPoint), fallback: false };
      }
    } catch (error) {
      console.warn(`Road snap service unavailable; checking cached road geometry: ${error.message}`);
    }
  }

  const lines = Array.isArray(cachedRoutes)
    ? cachedRoutes.filter((line) => Array.isArray(line) && line.every(coordinate))
    : [];
  const fallback = nearestPolylinePoint(point, lines);
  if (fallback) return fallback;

  const error = new Error("Could not snap this point to a road or a cached vehicle route.");
  error.statusCode = 422;
  throw error;
}

async function getNearbyIncidents(location) {
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) return { incidents: [], configured: false };
  const latitudeDelta = 5_000 / 111_320;
  const longitudeDelta = latitudeDelta / Math.cos(location.latitude * Math.PI / 180);
  const bounds = [
    location.longitude - longitudeDelta,
    location.latitude - latitudeDelta,
    location.longitude + longitudeDelta,
    location.latitude + latitudeDelta
  ];
  const url = new URL("https://api.tomtom.com/maps/orbis/traffic/incidents/details");
  url.searchParams.set("apiVersion", "2");
  url.searchParams.set("bbox", bounds.join(","));
  url.searchParams.set("timeValidity", "present");
  const response = await fetch(url, {
    headers: {
      "TomTom-Api-Key": apiKey,
      Attributes: "incidents(type,geometry(type,coordinates),properties(iconCategory))"
    }
  });
  if (!response.ok) {
    const error = new Error(`Traffic incident service returned HTTP ${response.status}.`);
    error.statusCode = 502;
    throw error;
  }
  const result = await response.json();
  const incidents = (result.incidents ?? []).flatMap((incident, index) => {
    const coordinates = incident.geometry?.coordinates;
    const collect = (value) => {
      if (!Array.isArray(value)) return [];
      if (coordinate(value)) return [[value[0], value[1]]];
      return value.flatMap(collect);
    };
    const points = collect(coordinates);
    if (!points.length) return [];
    const origin = [location.longitude, location.latitude];
    const closest = points.reduce((best, point) =>
      haversine(origin, point) < haversine(origin, best) ? point : best
    );
    const distance = haversine(origin, closest);
    if (distance > 5_000) return [];
    const category = incident.properties?.iconCategory;
    const title = typeof category === "string"
      ? category.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (letter) => letter.toUpperCase())
      : "Traffic incident";
    return [{
      id: `tomtom-${incident.id ?? index}`,
      title,
      road: "Nearby road",
      severity: /accident|closure|flood/i.test(title) ? "HIGH" : "MEDIUM",
      distance: `${(distance / 1000).toFixed(1)} km from you`,
      source: "TomTom live traffic",
      lng: closest[0],
      lat: closest[1],
      state: "REPORTED",
      freshness: "Live feed",
      radiusMeters: INCIDENT_RADIUS_METERS,
      simulated: false
    }];
  });
  return { incidents, configured: true };
}

async function createDemoTrafficJams(location) {
  if (!location || !number(location.longitude) || !number(location.latitude)
    || Math.abs(location.longitude) > 180 || Math.abs(location.latitude) > 90) {
    const error = new Error("A valid live location is required to place nearby traffic jams.");
    error.statusCode = 400;
    throw error;
  }
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) {
    const error = new Error("TomTom routing is not configured on the backend.");
    error.statusCode = 503;
    throw error;
  }

  const origin = [location.longitude, location.latitude];
  const bearings = [25, 145, 265];
  const jams = [];
  const obstacles = [];
  for (const [index, bearing] of bearings.entries()) {
    const destination = destinationPoint(origin, 2_000, bearing);
    const routeUrl = new URL(
      `https://api.tomtom.com/routing/1/calculateRoute/${origin[1]},${origin[0]}:${destination[1]},${destination[0]}/json`
    );
    routeUrl.searchParams.set("key", apiKey);
    routeUrl.searchParams.set("routeType", "fastest");
    routeUrl.searchParams.set("traffic", "true");
    routeUrl.searchParams.set("travelMode", "car");
    const response = await fetch(routeUrl);
    if (!response.ok) {
      const error = new Error(`TomTom routing returned HTTP ${response.status}.`);
      error.statusCode = response.status >= 500 ? 502 : 422;
      throw error;
    }
    const result = await response.json();
    const coordinates = (result.routes?.[0]?.legs ?? [])
      .flatMap((leg) => leg.points ?? [])
      .filter((point) => number(point.longitude) && number(point.latitude))
      .map((point) => [point.longitude, point.latitude]);
    const routeDistance = distanceAlongRoute(coordinates);
    if (coordinates.length < 2 || routeDistance < 800) {
      const error = new Error("TomTom returned no usable nearby road geometry for a demo jam.");
      error.statusCode = 502;
      throw error;
    }
    const targetDistances = [
      450 + index * 350,
      750 + index * 350,
      1_050 + index * 350,
      1_350 + index * 350
    ];
    const jamPoint = targetDistances
      .filter((distance) => distance <= routeDistance)
      .map((distance) => pointAtDistance(coordinates, distance)?.point)
      .find((candidate) => candidate
        && haversine(origin, candidate) <= 2_000
        && jams.every((jam) => haversine([jam.lng, jam.lat], candidate) >= 180));
    if (!jamPoint) {
      const error = new Error("Could not place three separate demo jams on nearby roads.");
      error.statusCode = 502;
      throw error;
    }
    const radiusMeters = 35;
    jams.push({
      id: `demo-jam-${index + 1}-${randomUUID()}`,
      title: "Jam",
      road: `Nearby road ${index + 1}`,
      severity: "MEDIUM",
      distance: `${Math.round(haversine(origin, jamPoint))} m from you`,
      source: "Demo traffic jam",
      lng: jamPoint[0],
      lat: jamPoint[1],
      state: "REPORTED",
      freshness: "Demo",
      radiusMeters,
      polygon: makeCirclePolygon(jamPoint, radiusMeters),
      simulated: true
    });

    const obstacleCandidates = [];
    for (let routeProgress = 300; routeProgress <= Math.min(routeDistance, 1_900); routeProgress += 50) {
      const candidate = pointAtDistance(coordinates, routeProgress)?.point;
      if (!candidate) continue;
      const distanceFromOrigin = haversine(origin, candidate);
      if (distanceFromOrigin < 350 || distanceFromOrigin > 2_000) continue;
      obstacleCandidates.push({ point: candidate, routeProgress });
    }
    const findObstaclePoint = (jamClearance, obstacleClearance) => obstacleCandidates
      .filter(({ point }) => jams.every((jam) =>
        haversine([jam.lng, jam.lat], point) >= jamClearance)
        && obstacles.every((obstacle) =>
          haversine([obstacle.lng, obstacle.lat], point) >= obstacleClearance))
      .sort((left, right) =>
        Math.abs(left.routeProgress - (1_250 + index * 100))
        - Math.abs(right.routeProgress - (1_250 + index * 100)))[0]?.point;
    const obstaclePoint = findObstaclePoint(120, 150)
      ?? findObstaclePoint(80, 100);
    if (!obstaclePoint) {
      const error = new Error("Could not place three separate demo obstacles ahead on nearby roads.");
      error.statusCode = 502;
      throw error;
    }
    const obstacleRadiusMeters = 75;
    obstacles.push({
      id: `demo-obstacle-${index + 1}-${randomUUID()}`,
      title: "Obstacle",
      road: `Nearby road ${index + 1}`,
      severity: "HIGH",
      distance: `${Math.round(haversine(origin, obstaclePoint))} m from you`,
      source: "Demo road obstacle",
      lng: obstaclePoint[0],
      lat: obstaclePoint[1],
      state: "ACTIVE",
      freshness: "Demo",
      radiusMeters: obstacleRadiusMeters,
      polygon: makeCirclePolygon(obstaclePoint, obstacleRadiusMeters),
      simulated: true
    });
  }
  return { jams, obstacles };
}

async function searchDrivableRoad(origin, minDistance, maxDistance, maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    const dist = minDistance + Math.random() * (maxDistance - minDistance);
    const bearing = Math.random() * 360;
    const candidate = destinationPoint(origin, dist, bearing);

    try {
      const data = await requestOrs("/v2/snap/driving-car/json", {
        locations: [candidate],
        radius: 150
      });
      if (data.locations && data.locations.length > 0 && data.locations[0].location) {
        const loc = data.locations[0];
        console.log(`[DEMO TRUCK] Found road: ${loc.name || "Unnamed road"} (snapped ${Math.round(loc.snapped_distance)}m)`);
        return {
          point: loc.location,
          name: loc.name || "Unnamed road",
          snapDistance: loc.snapped_distance
        };
      }
    } catch (e) {
      // ignore and retry
    }
  }
  return null;
}

async function createDemoTruck(location) {
  const origin = [location.longitude, location.latitude];
  
  const startRoad = await searchDrivableRoad(origin, 300, 800);
  if (!startRoad) {
    const error = new Error("No drivable road found within 1.5 km of your location. Move the map to a road area and try again.");
    error.statusCode = 422;
    throw error;
  }
  const startPoint = startRoad.point;

  const destRoad = await searchDrivableRoad(startPoint, 3000, 6000);
  if (!destRoad) {
    const error = new Error("Could not find a drivable destination road within 3 to 6 km of the start point.");
    error.statusCode = 422;
    throw error;
  }
  const destPoint = destRoad.point;

  const routes = await directions([startPoint, destPoint]);
  const route = routes[0];
  if (!route || route.coordinates.length < 2) {
    const error = new Error("Could not compute a route for the demo truck.");
    error.statusCode = 422;
    throw error;
  }

  const blockProgress = 300;
  const blockSegment = segmentAtDistance(route.coordinates, blockProgress);
  if (!blockSegment) {
    const error = new Error("Route is too short for a road block.");
    error.statusCode = 422;
    throw error;
  }

  const radiusMeters = 25;
  const polygon = makeCorridorPolygon(blockSegment.start, blockSegment.end, radiusMeters);
  const blockPointInfo = pointAtDistance(route.coordinates, blockProgress);
  const blockPoint = blockPointInfo ? blockPointInfo.point : blockSegment.start;

  const obstacle = {
    id: `demo-truck-block-${randomUUID()}`,
    title: "Road block",
    road: "Ahead on route",
    severity: "HIGH",
    distance: "300 m ahead",
    source: "Road block",
    lng: blockPoint[0],
    lat: blockPoint[1],
    polygon,
    state: "ACTIVE",
    freshness: "Just now",
    radiusMeters,
    simulated: false
  };

  const truck = {
    id: "DEMO-TRUCK",
    name: "DEMO TRUCK",
    status: "Starting",
    speedKph: 30,
    load: "8.2 / 12 t",
    etaSeconds: route.durationSeconds,
    progressMeters: 0,
    routeCoordinates: route.coordinates,
    lng: startPoint[0],
    lat: startPoint[1],
    source: "Demo truck",
    deliveries: 3,
    startRoadName: startRoad.name,
    destRoadName: destRoad.name
  };

  return { truck, obstacle };
}

async function getPlaceSearch(searchParams) {
  const query = searchParams.get("q")?.trim();
  if (!query || query.length > 200) {
    const error = new Error("Search query must be between 1 and 200 characters.");
    error.statusCode = 400;
    throw error;
  }
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");
  url.searchParams.set("lang", "en");
  const latitude = Number(searchParams.get("lat"));
  const longitude = Number(searchParams.get("lon"));
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
  }
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Place search service returned HTTP ${response.status}.`);
    error.statusCode = 502;
    throw error;
  }
  return response.json();
}

async function getDecisionReason(prompt, fallback) {
  if (!process.env.GEMINI_API_KEY) return { reason: fallback, reasonSource: "template" };
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Write exactly one complete, plain-language sentence of 8 to 18 words explaining this fixed routing decision. If extra travel time is provided, state it as "N extra minutes". Do not select or change a route, add facts, or use a fragment or heading. ${prompt}` }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1_024 }
        })
      }
    );
    if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}.`);
    const result = await response.json();
    const generated = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    const includesRequiredTimeUnit = !/\bextra minutes\b/i.test(prompt) || /\bminutes?\b/i.test(generated ?? "");
    if (generated
      && generated.split(/\s+/).length >= 6
      && /[.!?]$/.test(generated)
      && includesRequiredTimeUnit) {
      return { reason: generated, reasonSource: "gemini" };
    }
    throw new Error("Gemini returned no complete explanation.");
  } catch (error) {
    console.warn(`Gemini explanation unavailable; using template: ${error.message}`);
    return { reason: fallback, reasonSource: "template" };
  }
}

async function createAlternatives(body) {
  const { origin, destination, obstacle } = body;
  if (!coordinate(origin) || !coordinate(destination) || !cleanObstacle(obstacle)) {
    const error = new Error("A valid route origin, destination, and obstacle are required.");
    error.statusCode = 400;
    throw error;
  }
  const radiusMeters = number(obstacle.radiusMeters) ? obstacle.radiusMeters : INCIDENT_RADIUS_METERS;
  const avoidPolygons = Array.isArray(obstacle.polygon)
    ? { type: "MultiPolygon", coordinates: [[obstacle.polygon]] }
    : makeObstaclePolygon([obstacle.lng, obstacle.lat], radiusMeters);
  let routes;
  try {
    routes = await directions(
      [origin, destination],
      { avoid_polygons: avoidPolygons },
      true
    );
  } catch (error) {
    if (error.statusCode !== 422) throw error;
    const fallback = "The routing service could not find a drivable alternative around the 150 m obstacle zone. Wait for the road to clear before continuing.";
    const wording = await getDecisionReason(
      "The route service found no drivable alternative avoiding the obstacle. Recommend waiting.",
      fallback
    );
    return {
      id: randomUUID(),
      routes: [],
      recommendation: null,
      wait: true,
      ...wording,
      baselineDurationSeconds: null
    };
  }
  const assessed = routes.map((route, index) => ({
    ...route,
    id: `alternative-${index + 1}`,
    avoidsObstacle: distanceToLine([obstacle.lng, obstacle.lat], route.coordinates) > radiusMeters,
    extraTimeSeconds: null
  }));
  const available = assessed.filter((route) => route.avoidsObstacle);
  const recommended = available.sort((left, right) => left.durationSeconds - right.durationSeconds)[0] ?? null;
  const baseRoute = (await directions([origin, destination]))[0];
  const baselineDuration = baseRoute.durationSeconds;
  for (const route of assessed) route.extraTimeSeconds = route.durationSeconds - baselineDuration;
  const selectedRoute = assessed.find((route) => route.id === recommended?.id) ?? null;

  const fallback = selectedRoute
    ? `This route avoids the 150 m obstacle zone and is the quickest safe alternative, taking about ${Math.max(0, Math.round(selectedRoute.extraTimeSeconds / 60))} extra minutes.`
    : "No returned route avoids the obstacle radius. Waiting for the road to clear is safer than sending the vehicle through the blocked area.";
  const wording = await getDecisionReason(
    selectedRoute
      ? `Recommend the selected fastest alternative that avoids the obstacle. Its distance is ${(selectedRoute.distanceMeters / 1000).toFixed(1)} km, ETA ${Math.round(selectedRoute.durationSeconds / 60)} minutes, with ${Math.round(selectedRoute.extraTimeSeconds / 60)} extra minutes.`
      : "No returned road route avoids the obstacle radius. Recommend waiting instead of driving through the blocked area.",
    fallback
  );

  return {
    id: randomUUID(),
    routes: assessed,
    recommendation: selectedRoute?.id ?? null,
    wait: !selectedRoute,
    ...wording,
    baselineDurationSeconds: baselineDuration
  };
}

async function createReroute(body) {
  if (!coordinate(body.origin) || !coordinate(body.destination)) {
    const error = new Error("A valid current position and destination are required.");
    error.statusCode = 400;
    throw error;
  }
  const polygon = body.obstaclePolygon?.type === "Polygon"
    ? body.obstaclePolygon.coordinates?.[0]
    : body.obstaclePolygon;
  if (!Array.isArray(polygon) || polygon.length < 4 || !polygon.every(coordinate)) {
    const error = new Error("A valid road block polygon is required.");
    error.statusCode = 400;
    throw error;
  }

  const routes = await directions(
    [body.origin, body.destination],
    { avoid_polygons: { type: "MultiPolygon", coordinates: [[polygon]] } },
    true
  );
  
  const safeRoutes = routes
    .map((route) => ({
      ...route,
      coordinates: orientRouteForTrip(route.coordinates, body.origin, body.destination)
    }))
    .filter((route) => route.coordinates !== null)
    .filter((route) => !routeIntersectsPolygon(route.coordinates, polygon))
    .sort((left, right) => left.durationSeconds - right.durationSeconds);
  const fastestDuration = safeRoutes[0]?.durationSeconds ?? 0;
  const assessedRoutes = safeRoutes.map((route, index) => ({
      ...route,
      id: `safe-route-${index + 1}`,
      avoidsObstacle: true,
      extraTimeSeconds: route.durationSeconds - fastestDuration
    }));
  const recommended = assessedRoutes[0] ?? null;
  return {
    id: randomUUID(),
    routes: assessedRoutes,
    recommendation: recommended?.id ?? null,
    wait: !recommended,
    reason: recommended
      ? "The fastest returned route avoids the road block and has passed the route safety check."
      : "No returned alternative avoids the road block. The vehicle is stopped; wait for the road to clear.",
    reasonSource: "template",
    baselineDurationSeconds: null
  };
}

export async function handleApiRequest(request, response) {
  try {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    if (request.method === "GET" && path === "/api/health") {
      return json(response, 200, {
        ok: true,
        routingConfigured: Boolean(process.env.ORS_API_KEY),
        trafficConfigured: Boolean(process.env.TOMTOM_API_KEY),
        aiConfigured: Boolean(process.env.GEMINI_API_KEY)
      });
    }

    if (request.method === "GET" && path === "/api/config") {
      return json(response, 200, {
        maptilerKey: process.env.VITE_MAPTILER_API_KEY || process.env.MAPTILER_API_KEY || "LQTybYHKY6IqrTD2Xzne"
      });
    }

    if (request.method !== "POST" && !(
      request.method === "GET" && (path === "/api/places" || path === "/api/config")
    )) {
      return json(response, 405, { error: "Method not allowed." });
    }

    if (path === "/api/places") {
      return json(response, 200, await getPlaceSearch(url.searchParams));
    }

    const body = await readBody(request);
    if (path === "/api/demo/truck") {
      if (!body.location || !number(body.location.longitude) || !number(body.location.latitude)) {
        return json(response, 400, { error: "A valid live location is required." });
      }
      return json(response, 200, await createDemoTruck(body.location));
    }
    if (path === "/api/demo/vehicles") {
      if (!body.location || !number(body.location.longitude) || !number(body.location.latitude)) {
        return json(response, 400, { error: "A valid live location is required." });
      }
      return json(response, 200, await createDemoVehicles(body.location));
    }
    if (path === "/api/demo/jams") {
      return json(response, 200, await createDemoTrafficJams(body.location));
    }
    if (path === "/api/obstacles/nearby") {
      return json(response, 200, await createNearbyRoadBlock(body));
    }
    if (path === "/api/snap") {
      if (!coordinate(body.point)) return json(response, 400, { error: "A valid map point is required." });
      return json(response, 200, await snapPoint(body.point, body.cachedRoutes));
    }
    if (path === "/api/route") {
      if (!coordinate(body.origin) || !coordinate(body.destination)) {
        return json(response, 400, { error: "A valid origin and destination are required." });
      }
      const avoidPolygons = Array.isArray(body.obstacles)
        ? body.obstacles.filter(cleanObstacle).map((obstacle) =>
          makeObstaclePolygon([obstacle.lng, obstacle.lat], number(obstacle.radiusMeters) ? obstacle.radiusMeters : INCIDENT_RADIUS_METERS))
        : [];
      const options = avoidPolygons.length ? { avoid_polygons: { type: "MultiPolygon", coordinates: avoidPolygons.flatMap((polygon) => polygon.coordinates) } } : {};
      return json(response, 200, { routes: await directions([body.origin, body.destination], options) });
    }
    if (path === "/api/alternatives") {
      return json(response, 200, await createAlternatives(body));
    }
    if (path === "/api/reroute") {
      return json(response, 200, await createReroute(body));
    }
    if (path === "/api/incidents") {
      if (!body.location || !number(body.location.longitude) || !number(body.location.latitude)) {
        return json(response, 400, { error: "A valid live location is required." });
      }
      return json(response, 200, await getNearbyIncidents(body.location));
    }

    return json(response, 404, { error: "API endpoint not found." });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
    if (status >= 500) console.error(`API request failed: ${error.message}`);
    return json(response, status, { error: error.message || "Request failed." });
  }
}

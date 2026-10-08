import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceAlongRoute,
  distanceMeters,
  makeCirclePolygon,
  orientRouteForTrip,
  pointInPolygon,
  routeIntersectsPolygon
} from "../src/roadBlockGeometry.js";
import { handleApiRequest } from "../server/api.mjs";

function makeRequest(path, body) {
  return {
    method: "POST",
    url: path,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    }
  };
}

function makeResponse() {
  return {
    statusCode: 0,
    body: null,
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(value) {
      this.body = JSON.parse(value);
    }
  };
}

test("a demo vehicle stops before entering a road block polygon", () => {
  const route = [[0, 0], [0.02, 0]];
  const polygon = makeCirclePolygon([0.01, 0], 150);
  const movement = advanceAlongRoute(route, 0, 2_000, polygon);

  assert.equal(movement.blocked, true);
  assert.equal(pointInPolygon(movement.point, polygon), false);
  assert.ok(movement.progressMeters < distanceMeters(route[0], [0.01, 0]));
  assert.ok(routeIntersectsPolygon(route, polygon));
});

test("reroute geometry is oriented from the vehicle toward its destination", () => {
  const origin = [77, 11];
  const destination = [77.01, 11];
  const reversedRoute = [destination, [77.005, 11.002], origin];
  const route = orientRouteForTrip(reversedRoute, origin, destination);

  assert.deepEqual(route, reversedRoute.slice().reverse());
  assert.equal(orientRouteForTrip([[78, 12], [78.01, 12]], origin, destination), null);
});

test("demo vehicle routes stay local to the live location", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ORS_API_KEY;
  const requestedRoutes = [];
  const origin = [77.0, 11.0];
  process.env.ORS_API_KEY = "test-only-routing-key";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (!body.coordinates) {
      return Response.json({ locations: [{ location: body.locations[0] }] });
    }
    requestedRoutes.push(body.coordinates);
    const [start, destination] = body.coordinates;
    const nearbyRoadPoint = [
      start[0] + (destination[0] - start[0]) / 15,
      start[1] + (destination[1] - start[1]) / 15
    ];
    return Response.json({
      features: [{
        geometry: { type: "LineString", coordinates: [start, destination] },
        properties: { summary: { distance: 1_500, duration: 180 } }
      }]
    });
  };
  try {
    const response = makeResponse();
    await handleApiRequest(makeRequest("/api/demo/vehicles", {
      location: { longitude: origin[0], latitude: origin[1] }
    }), response);

    assert.equal(response.statusCode, 200);
    assert.equal(requestedRoutes.length, 3);
    for (const [, destination] of requestedRoutes) {
      assert.ok(Math.abs(distanceMeters(origin, destination) - 1_500) < 5);
    }
    for (const vehicle of response.body.vehicles) {
      assert.ok(distanceMeters(origin, [vehicle.lng, vehicle.lat]) <= 250);
      assert.ok(distanceMeters(origin, [vehicle.lng, vehicle.lat]) >= 75);
      assert.ok(distanceMeters(origin, vehicle.routeCoordinates.at(-1)) <= 1_505);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ORS_API_KEY;
    else process.env.ORS_API_KEY = originalApiKey;
  }
});

test("demo fleet reports a routing provider error instead of hiding it", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ORS_API_KEY;
  const originalConsoleWarn = console.warn;
  process.env.ORS_API_KEY = "test-only-routing-key";
  console.warn = () => {};
  globalThis.fetch = async () => new Response("provider denied request", { status: 403 });
  try {
    const response = makeResponse();
    await handleApiRequest(makeRequest("/api/demo/vehicles", {
      location: { longitude: 77, latitude: 11 }
    }), response);

    assert.equal(response.statusCode, 422);
    assert.match(response.body.error, /routing service returned HTTP 403/i);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalConsoleWarn;
    if (originalApiKey === undefined) delete process.env.ORS_API_KEY;
    else process.env.ORS_API_KEY = originalApiKey;
  }
});

test("demo jam endpoint creates exactly three small markers on TomTom road routes", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TOMTOM_API_KEY;
  const requestedUrls = [];
  process.env.TOMTOM_API_KEY = "test-only-traffic-key";
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    requestedUrls.push(parsed);
    const route = parsed.pathname.match(/calculateRoute\/([^:]+):([^/]+)\/json$/);
    assert.ok(route);
    const [, startText, endText] = route;
    const [startLat, startLng] = startText.split(",").map(Number);
    const [endLat, endLng] = endText.split(",").map(Number);
    const middle = [(startLng + endLng) / 2, (startLat + endLat) / 2];
    return Response.json({
      routes: [{
        legs: [{
          points: [
            { longitude: startLng, latitude: startLat },
            { longitude: middle[0], latitude: middle[1] },
            { longitude: endLng, latitude: endLat }
          ]
        }]
      }]
    });
  };
  try {
    const response = makeResponse();
    await handleApiRequest(makeRequest("/api/demo/jams", {
      location: { longitude: 77, latitude: 11 }
    }), response);

    assert.equal(response.statusCode, 200);
    assert.equal(requestedUrls.length, 3);
    assert.equal(response.body.jams.length, 3);
    assert.equal(response.body.obstacles.length, 3);
    for (const jam of response.body.jams) {
      assert.equal(jam.title, "Jam");
      assert.equal(jam.source, "Demo traffic jam");
      assert.equal(jam.radiusMeters, 35);
      assert.equal(jam.simulated, true);
      assert.ok(jam.distance.includes("m from you"));
      const distance = distanceMeters([77, 11], [jam.lng, jam.lat]);
      assert.ok(distance > 200 && distance < 2_000);
    }
    assert.equal(new Set(response.body.jams.map((jam) => `${jam.lng},${jam.lat}`)).size, 3);
    for (let index = 1; index < response.body.jams.length; index += 1) {
      const previous = response.body.jams[index - 1];
      const current = response.body.jams[index];
      assert.ok(distanceMeters([previous.lng, previous.lat], [current.lng, current.lat]) >= 180);
    }
    for (const obstacle of response.body.obstacles) {
      assert.equal(obstacle.title, "Obstacle");
      assert.equal(obstacle.source, "Demo road obstacle");
      assert.equal(obstacle.radiusMeters, 75);
      assert.equal(obstacle.simulated, true);
      assert.ok(distanceMeters([77, 11], [obstacle.lng, obstacle.lat]) >= 800);
    }
    assert.equal(new Set(response.body.obstacles.map((obstacle) =>
      `${obstacle.lng},${obstacle.lat}`
    )).size, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TOMTOM_API_KEY;
    else process.env.TOMTOM_API_KEY = originalApiKey;
  }
});

test("the nearby road block endpoint road-snaps a block 300-800 m from live location", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ORS_API_KEY;
  process.env.ORS_API_KEY = "test-only-routing-key";
  let snapUrl;
  globalThis.fetch = async (url, options) => {
    snapUrl = String(url);
    const body = JSON.parse(options.body);
    return Response.json({ locations: [{ location: body.locations[0] }] });
  };
  try {
    const route = [[0, 0], [0.01, 0]];
    const response = makeResponse();
    await handleApiRequest(makeRequest("/api/obstacles/nearby", {
      location: { longitude: 0, latitude: 0 },
      vehicles: [{
        id: "TX-01",
        name: "TX-01",
        routeCoordinates: route,
        progressMeters: 0
      }]
    }), response);

    assert.equal(response.statusCode, 200);
    assert.match(snapUrl, /api\.openrouteservice\.org\/v2\/snap\/driving-car\/json/);
    assert.equal(response.body.title, "Road block");
    assert.ok(response.body.distance.includes("m from you"));
    const distance = distanceMeters([0, 0], [response.body.lng, response.body.lat]);
    assert.ok(distance >= 300 && distance <= 800);
    assert.ok(Array.isArray(response.body.polygon));
    assert.ok(routeIntersectsPolygon(route, response.body.polygon));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ORS_API_KEY;
    else process.env.ORS_API_KEY = originalApiKey;
  }
});

test("reroute endpoint rejects intersecting alternatives and returns the fastest safe route", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ORS_API_KEY;
  process.env.ORS_API_KEY = "test-only-routing-key";
  let requestedBody;
  const blockedRoute = [[0, 0], [0.005, 0], [0.01, 0]];
  const tooCloseRoute = [[0, 0], [0.003, -0.0005], [0.007, -0.0005], [0.01, 0]];
  const safeRoute = [[0, 0], [0.003, -0.002], [0.007, -0.002], [0.01, 0]];
  globalThis.fetch = async (_url, options) => {
    requestedBody = JSON.parse(options.body);
    return Response.json({
      features: [
        {
          geometry: { type: "LineString", coordinates: blockedRoute },
          properties: { summary: { distance: 1_000, duration: 200 } }
        },
        {
          geometry: { type: "LineString", coordinates: tooCloseRoute },
          properties: { summary: { distance: 1_100, duration: 250 } }
        },
        {
          geometry: { type: "LineString", coordinates: safeRoute.slice().reverse() },
          properties: { summary: { distance: 1_500, duration: 300 } }
        }
      ]
    });
  };
  try {
    const polygon = [
      [0.004, -0.001],
      [0.006, -0.001],
      [0.006, 0.001],
      [0.004, 0.001],
      [0.004, -0.001]
    ];
    const response = makeResponse();
    await handleApiRequest(makeRequest("/api/reroute", {
      origin: [0, 0],
      destination: [0.01, 0],
      obstaclePolygon: { type: "Polygon", coordinates: [polygon] }
    }), response);

    assert.equal(response.statusCode, 200);
    assert.equal(requestedBody.alternative_routes.target_count, 3);
    assert.deepEqual(requestedBody.options.avoid_polygons.coordinates, [[polygon]]);
    assert.equal(response.body.wait, false);
    assert.equal(response.body.routes.length, 1);
    assert.deepEqual(response.body.routes[0].coordinates, safeRoute);
    assert.equal(routeIntersectsPolygon(response.body.routes[0].coordinates, polygon), false);
    assert.equal(response.body.recommendation, response.body.routes[0].id);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ORS_API_KEY;
    else process.env.ORS_API_KEY = originalApiKey;
  }
});

test("reroute endpoint reports waiting when all returned routes intersect the block", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ORS_API_KEY;
  process.env.ORS_API_KEY = "test-only-routing-key";
  globalThis.fetch = async () => Response.json({
    features: [{
      geometry: { type: "LineString", coordinates: [[0, 0], [0.005, 0], [0.01, 0]] },
      properties: { summary: { distance: 1_000, duration: 200 } }
    }]
  });
  try {
    const polygon = [
      [0.004, -0.001],
      [0.006, -0.001],
      [0.006, 0.001],
      [0.004, 0.001],
      [0.004, -0.001]
    ];
    const response = makeResponse();
    await handleApiRequest(makeRequest("/api/reroute", {
      origin: [0, 0],
      destination: [0.01, 0],
      obstaclePolygon: { type: "Polygon", coordinates: [polygon] }
    }), response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.wait, true);
    assert.equal(response.body.recommendation, null);
    assert.deepEqual(response.body.routes, []);
    assert.match(response.body.reason, /vehicle is stopped/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ORS_API_KEY;
    else process.env.ORS_API_KEY = originalApiKey;
  }
});

test("reroute endpoint returns a service error instead of a blocked route when ORS fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ORS_API_KEY;
  const originalConsoleError = console.error;
  process.env.ORS_API_KEY = "test-only-routing-key";
  console.error = () => {};
  globalThis.fetch = async () => new Response("provider failure", { status: 503 });
  try {
    const response = makeResponse();
    await handleApiRequest(makeRequest("/api/reroute", {
      origin: [0, 0],
      destination: [0.01, 0],
      obstaclePolygon: {
        type: "Polygon",
        coordinates: [[[0.004, -0.001], [0.006, -0.001], [0.006, 0.001], [0.004, 0.001], [0.004, -0.001]]]
      }
    }), response);

    assert.equal(response.statusCode, 502);
    assert.match(response.body.error, /routing service/i);
    assert.equal(response.body.routes, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (originalApiKey === undefined) delete process.env.ORS_API_KEY;
    else process.env.ORS_API_KEY = originalApiKey;
  }
});

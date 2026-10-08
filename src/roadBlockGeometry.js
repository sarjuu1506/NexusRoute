const EARTH_RADIUS_METERS = 6_371_000;

export function distanceMeters(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(second[1] - first[1]);
  const longitudeDelta = radians(second[0] - first[0]);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(first[1])) * Math.cos(radians(second[1])) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function distanceAlongRoute(route) {
  return route.slice(1).reduce(
    (sum, point, index) => sum + distanceMeters(route[index], point),
    0
  );
}

export function orientRouteForTrip(route, origin, destination, maximumEndpointDistance = 250) {
  if (route.length < 2) return null;
  const forwardDistance = distanceMeters(route[0], origin)
    + distanceMeters(route[route.length - 1], destination);
  const reverseDistance = distanceMeters(route[route.length - 1], origin)
    + distanceMeters(route[0], destination);
  const coordinates = reverseDistance < forwardDistance ? route.slice().reverse() : route;
  if (distanceMeters(coordinates[0], origin) > maximumEndpointDistance
    || distanceMeters(coordinates[coordinates.length - 1], destination) > maximumEndpointDistance) {
    return null;
  }
  return coordinates;
}

export function pointAtDistance(route, distance) {
  if (!route.length) return null;
  if (distance <= 0) return { point: route[0], index: 0 };
  let travelled = 0;
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1];
    const end = route[index];
    const segmentLength = distanceMeters(start, end);
    if (travelled + segmentLength >= distance) {
      const fraction = segmentLength === 0 ? 0 : (distance - travelled) / segmentLength;
      return {
        point: [
          start[0] + (end[0] - start[0]) * fraction,
          start[1] + (end[1] - start[1]) * fraction
        ],
        index
      };
    }
    travelled += segmentLength;
  }
  return { point: route[route.length - 1], index: route.length - 1 };
}

export function remainingRoute(route, progressMeters) {
  const current = pointAtDistance(route, progressMeters);
  if (!current) return [];
  return [current.point, ...route.slice(current.index)];
}

export function makeCirclePolygon(point, radiusMeters) {
  const latitudeDelta = radiusMeters / 111_320;
  const longitudeDelta = latitudeDelta / Math.cos(point[1] * Math.PI / 180);
  const ring = [];
  for (let index = 0; index < 32; index += 1) {
    const angle = index * Math.PI * 2 / 32;
    ring.push([
      point[0] + Math.cos(angle) * longitudeDelta,
      point[1] + Math.sin(angle) * latitudeDelta
    ]);
  }
  ring.push(ring[0]);
  return ring;
}

export function segmentAtDistance(route, distance) {
  if (route.length < 2) return null;
  if (distance <= 0) return { start: route[0], end: route[1] };
  let travelled = 0;
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1];
    const end = route[index];
    const segmentLength = distanceMeters(start, end);
    if (travelled + segmentLength >= distance) {
      return { start, end };
    }
    travelled += segmentLength;
  }
  return { start: route[route.length - 2], end: route[route.length - 1] };
}

export function makeCorridorPolygon(start, end, radiusMeters) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  
  const startLatCos = Math.cos(start[1] * Math.PI / 180);
  const endLatCos = Math.cos(end[1] * Math.PI / 180);
  
  const startMeters = [0, 0];
  const endMeters = [dx * 111_320 * startLatCos, dy * 111_320];
  const lengthMeters = Math.hypot(endMeters[0], endMeters[1]);
  
  if (lengthMeters === 0) return makeCirclePolygon(start, radiusMeters);
  
  const nx = -endMeters[1] / lengthMeters;
  const ny = endMeters[0] / lengthMeters;
  
  const offsetLngStart = nx * radiusMeters / (111_320 * startLatCos);
  const offsetLatStart = ny * radiusMeters / 111_320;
  const offsetLngEnd = nx * radiusMeters / (111_320 * endLatCos);
  const offsetLatEnd = ny * radiusMeters / 111_320;
  
  return [
    [start[0] + offsetLngStart, start[1] + offsetLatStart],
    [end[0] + offsetLngEnd, end[1] + offsetLatEnd],
    [end[0] - offsetLngEnd, end[1] - offsetLatEnd],
    [start[0] - offsetLngStart, start[1] - offsetLatStart],
    [start[0] + offsetLngStart, start[1] + offsetLatStart]
  ];
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  const ring = polygon.length > 1
    && polygon[0][0] === polygon[polygon.length - 1][0]
    && polygon[0][1] === polygon[polygon.length - 1][1]
    ? polygon.slice(0, -1)
    : polygon;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x, y] = ring[index];
    const [previousX, previousY] = ring[previous];
    if ((y > point[1]) !== (previousY > point[1])
      && point[0] < ((previousX - x) * (point[1] - y)) / (previousY - y) + x) {
      inside = !inside;
    }
  }
  return inside;
}

function cross(first, second) {
  return first[0] * second[1] - first[1] * second[0];
}

function segmentIntersectionFraction(start, end, edgeStart, edgeEnd) {
  const direction = [end[0] - start[0], end[1] - start[1]];
  const edge = [edgeEnd[0] - edgeStart[0], edgeEnd[1] - edgeStart[1]];
  const offset = [edgeStart[0] - start[0], edgeStart[1] - start[1]];
  const denominator = cross(direction, edge);
  if (Math.abs(denominator) < 1e-14) return null;
  const fraction = cross(offset, edge) / denominator;
  const edgeFraction = cross(offset, direction) / denominator;
  return fraction >= 0 && fraction <= 1 && edgeFraction >= 0 && edgeFraction <= 1
    ? fraction
    : null;
}

export function firstPolygonIntersectionFraction(start, end, polygon) {
  if (pointInPolygon(start, polygon)) return 0;
  let firstIntersection = null;
  for (let index = 1; index < polygon.length; index += 1) {
    const fraction = segmentIntersectionFraction(start, end, polygon[index - 1], polygon[index]);
    if (fraction !== null && (firstIntersection === null || fraction < firstIntersection)) {
      firstIntersection = fraction;
    }
  }
  return firstIntersection;
}

export function routeIntersectsPolygon(route, polygon, fromProgressMeters = 0) {
  if (route.length < 2 || polygon.length < 4) return false;
  const current = pointAtDistance(route, fromProgressMeters);
  if (!current) return false;
  if (pointInPolygon(current.point, polygon)) return true;

  let travelled = 0;
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1];
    const end = route[index];
    const segmentLength = distanceMeters(start, end);
    const segmentEnd = travelled + segmentLength;
    if (segmentEnd > fromProgressMeters) {
      const segmentStartPoint = travelled < fromProgressMeters
        ? pointAtDistance([start, end], fromProgressMeters - travelled).point
        : start;
      if (firstPolygonIntersectionFraction(segmentStartPoint, end, polygon) !== null
        || pointInPolygon(end, polygon)) return true;
    }
    travelled = segmentEnd;
  }
  return false;
}

export function advanceAlongRoute(route, progressMeters, distanceToAdvance, polygon, stopBufferMeters = 2) {
  const routeLength = distanceAlongRoute(route);
  const startProgress = Math.min(progressMeters, routeLength);
  const targetProgress = Math.min(startProgress + distanceToAdvance, routeLength);
  let travelled = 0;

  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1];
    const end = route[index];
    const segmentLength = distanceMeters(start, end);
    const segmentEnd = travelled + segmentLength;
    if (segmentEnd > startProgress && travelled < targetProgress) {
      const segmentStartDistance = Math.max(startProgress, travelled);
      const segmentEndDistance = Math.min(targetProgress, segmentEnd);
      const startPoint = pointAtDistance([start, end], segmentStartDistance - travelled).point;
      const endPoint = pointAtDistance([start, end], segmentEndDistance - travelled).point;
      const fraction = firstPolygonIntersectionFraction(startPoint, endPoint, polygon);
      if (fraction !== null) {
        const coveredDistance = segmentEndDistance - segmentStartDistance;
        const safeProgress = Math.max(
          startProgress,
          segmentStartDistance + fraction * coveredDistance - stopBufferMeters
        );
        return {
          progressMeters: safeProgress,
          point: pointAtDistance(route, safeProgress).point,
          blocked: true
        };
      }
      if (pointInPolygon(endPoint, polygon)) {
        return {
          progressMeters: segmentEndDistance,
          point: pointAtDistance(route, segmentEndDistance).point,
          blocked: true
        };
      }
    }
    travelled = segmentEnd;
  }

  return {
    progressMeters: targetProgress,
    point: pointAtDistance(route, targetProgress).point,
    blocked: false
  };
}

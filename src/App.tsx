import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import MapView, { type MapStyleKey } from "./components/MapView";
import { createRoadBlock } from "./data";
import { useLiveLocation } from "./hooks/useLiveLocation";
import {
  createNearbyRoadBlock,
  createDemoTrafficJams,
  createDemoVehicles,
  createDemoTruck,
  getNearbyIncidents,
  getRoute,
  rerouteVehicle,
  searchPlaces,
  type AlternativePlan
} from "./services/backend";
import {
  advanceAlongRoute,
  distanceAlongRoute,
  distanceMeters,
  makeCirclePolygon,
  pointAtDistance,
  remainingRoute,
  routeIntersectsPolygon
} from "./roadBlockGeometry.js";
import type { Destination, RoadEvent, UserLocation, Vehicle } from "./types";

const ROAD_BLOCK_RADIUS_METERS = 150;

type VehicleAlert = {
  id: string;
  obstacleId: string;
  vehicleId: string;
  vehicleName: string;
  title: string;
  timestamp: number;
};

function formatDuration(seconds: number) {
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

function readDestination(feature: unknown): Destination | null {
  if (typeof feature !== "object" || feature === null) return null;
  const result = feature as {
    geometry?: { coordinates?: unknown };
    properties?: Record<string, unknown>;
  };
  const coordinates = result.geometry?.coordinates;
  if (!Array.isArray(coordinates)
    || typeof coordinates[0] !== "number"
    || typeof coordinates[1] !== "number") return null;
  const parts = [result.properties?.name, result.properties?.street, result.properties?.city, result.properties?.state, result.properties?.country]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  const label = [...new Set(parts)].join(", ");
  return label ? { label, coordinates: [coordinates[0], coordinates[1]] } : null;
}

export default function App() {
  const gps = useLiveLocation();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleStatus, setVehicleStatus] = useState("Normal navigation mode");
  const [demoFleetEnabled, setDemoFleetEnabled] = useState(false);
  const [obstacles, setObstacles] = useState<RoadEvent[]>([]);
  const [incidentSearchLocation, setIncidentSearchLocation] = useState<UserLocation | null>(null);
  const [alerts, setAlerts] = useState<VehicleAlert[]>([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [placementMode, setPlacementMode] = useState(false);
  const [obstacleMessage, setObstacleMessage] = useState("");
  const [routeMessage, setRouteMessage] = useState("");
  const [routeError, setRouteError] = useState("");
  const [mapMode, setMapMode] = useState<"live" | "roads">("live");
  const [mapStyle, setMapStyle] = useState<MapStyleKey>("streets");
  const [recommendations, setRecommendations] = useState<Partial<Record<string, AlternativePlan>>>({});
  const [recommendationLoading, setRecommendationLoading] = useState<Record<string, boolean>>({});
  const [destinationQuery, setDestinationQuery] = useState("");
  const [destination, setDestination] = useState<Destination | null>(null);
  const [searchResults, setSearchResults] = useState<Destination[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "error">("idle");
  const [searchError, setSearchError] = useState("");
  const [destinationRoute, setDestinationRoute] = useState<[number, number][] | null>(null);
  const [destinationRouteInfo, setDestinationRouteInfo] = useState("");
  const [locateSignal, setLocateSignal] = useState(0);
  const alertedObstacleIds = useRef(new Set<string>());
  const reroutingVehicles = useRef(new Set<string>());
  const vehiclesRef = useRef(vehicles);
  const obstaclesRef = useRef(obstacles);
  const timersRef = useRef(new Set<AbortController>());

  vehiclesRef.current = vehicles;
  obstaclesRef.current = obstacles;

  const selectedVehicle = useMemo(
    () => vehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? vehicles[0] ?? null,
    [selectedVehicleId, vehicles]
  );
  const selectedPlan = selectedVehicle ? recommendations[selectedVehicle.id] : undefined;
  const recommendedRoute = selectedPlan?.recommendation
    ? selectedPlan.routes.find((route) => route.id === selectedPlan.recommendation)?.coordinates ?? null
    : null;
  const alternativeRoutes = selectedPlan?.routes ?? [];
  const currentRoute = destinationRoute ?? selectedVehicle?.routeCoordinates ?? null;

  const placeRoadBlock = useCallback(async (
    location: UserLocation,
    candidates = vehiclesRef.current
  ) => {
    const controller = new AbortController();
    timersRef.current.add(controller);
    setObstacleMessage("Finding and snapping a road block near your location…");
    try {
      const obstacle = await createNearbyRoadBlock(location, candidates, controller.signal);
      if (controller.signal.aborted) return;
      alertedObstacleIds.current.clear();
      reroutingVehicles.current.clear();
      setRecommendations({});
      setObstacles((current) => [
        ...current.filter((event) => event.source !== "Demo road block"),
        obstacle
      ]);
      setObstacleMessage(`Road block placed ${obstacle.distance} ahead on ${obstacle.road}.`);
    } catch (error) {
      if (!controller.signal.aborted) {
        setObstacleMessage(error instanceof Error ? error.message : "Could not place a road block.");
      }
    } finally {
      timersRef.current.delete(controller);
    }
  }, []);

  useEffect(() => {
    const location = gps.location;
    if (!location || !demoFleetEnabled || vehicles.length > 0) return;
    const controller = new AbortController();
    timersRef.current.add(controller);
    setVehicleStatus("Building road routes for demo fleet…");
    void createDemoVehicles(location, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setVehicles(result.vehicles);
      setSelectedVehicleId(result.vehicles[0]?.id ?? null);
      setVehicleStatus(`${result.created} demo vehicles active`);
      void placeRoadBlock(location, result.vehicles);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setVehicleStatus(error instanceof Error ? error.message : "Could not create demo vehicles.");
    }).finally(() => timersRef.current.delete(controller));
    return () => {
      controller.abort();
      timersRef.current.delete(controller);
    };
  }, [gps.location, placeRoadBlock, vehicles.length, demoFleetEnabled]);

  useEffect(() => () => {
    for (const controller of timersRef.current) controller.abort();
    timersRef.current.clear();
  }, []);

  const requestSafeReroute = useCallback((vehicle: Vehicle, obstacle: RoadEvent) => {
    const key = `${vehicle.id}:${obstacle.id}`;
    if (reroutingVehicles.current.has(key)) return;
    reroutingVehicles.current.add(key);
    setRecommendationLoading((current) => ({ ...current, [vehicle.id]: true }));
    setRouteError("");
    const controller = new AbortController();
    timersRef.current.add(controller);
    const destinationPoint = vehicle.routeCoordinates[vehicle.routeCoordinates.length - 1];
    const polygon = obstacle.polygon ?? makeCirclePolygon(
      [obstacle.lng, obstacle.lat],
      obstacle.radiusMeters || ROAD_BLOCK_RADIUS_METERS
    );

    void rerouteVehicle([vehicle.lng, vehicle.lat], destinationPoint, polygon, controller.signal)
      .then((plan) => {
        if (controller.signal.aborted) return;
        if (vehicle.id === "DEMO-TRUCK") {
          setSelectedVehicleId("DEMO-TRUCK");
        }
        setRecommendations((current) => ({ ...current, [vehicle.id]: plan }));
        if (plan.wait || !plan.recommendation) return;
        const route = plan.routes.find((candidate) => candidate.id === plan.recommendation);
        if (!route) {
          throw new Error("The routing response failed the road block safety check.");
        }
        const updated = vehiclesRef.current.map((item) => item.id === vehicle.id
          ? {
            ...item,
            status: "Rerouted" as const,
            previousRouteCoordinates: remainingRoute(item.routeCoordinates, item.progressMeters),
            routeCoordinates: route.coordinates,
            progressMeters: 0,
            lng: route.coordinates[0][0],
            lat: route.coordinates[0][1],
            etaSeconds: route.durationSeconds,
            speedKph: Math.max(item.speedKph, 32),
            riskObstacleId: undefined,
            bypassedObstacleId: obstacle.id
          }
          : item);
        vehiclesRef.current = updated;
        setVehicles(updated);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const errorMessage = error instanceof Error ? error.message : "Could not calculate a safe route.";
          setRecommendations((current) => ({
            ...current,
            [vehicle.id]: {
              id: "error",
              routes: [],
              recommendation: null,
              wait: true,
              reason: errorMessage,
              reasonSource: "template",
              baselineDurationSeconds: null
            }
          }));
        }
      })
      .finally(() => {
        timersRef.current.delete(controller);
        setRecommendationLoading((current) => ({ ...current, [vehicle.id]: false }));
        setTimeout(() => reroutingVehicles.current.delete(key), 2500);
      });
  }, []);

  useEffect(() => {
    if (!vehicles.length) return;
    let previous = performance.now();
    let frameId: number;
    let lastRender = previous;

    const tick = () => {
      frameId = window.requestAnimationFrame(tick);
      const now = performance.now();
      const elapsedSeconds = Math.min((now - previous) / 1000, 1);
      previous = now;
      
      const blockedVehicles: { vehicle: Vehicle; obstacle: RoadEvent }[] = [];
      const updated = vehiclesRef.current.map((vehicle) => {
        if (!vehicle.routeCoordinates || vehicle.routeCoordinates.length < 2) {
          return vehicle;
        }

        const activeBlockKey = vehicle.riskObstacleId
          ? `${vehicle.id}:${vehicle.riskObstacleId}`
          : "";
        if (activeBlockKey && reroutingVehicles.current.has(activeBlockKey)) return vehicle;

        const obstacle = obstaclesRef.current.find((candidate) => {
          if (
            candidate.source !== "Demo road block" &&
            candidate.source !== "Demo road obstacle" &&
            candidate.source !== "Road block" &&
            !candidate.id.startsWith("demo-truck-block")
          ) return false;
          if (vehicle.bypassedObstacleId === candidate.id) return false;
          const polygon = candidate.polygon ?? makeCirclePolygon(
            [candidate.lng, candidate.lat],
            candidate.radiusMeters || ROAD_BLOCK_RADIUS_METERS
          );
          return routeIntersectsPolygon(vehicle.routeCoordinates, polygon, vehicle.progressMeters);
        });
        if (!obstacle) {
          const nextProgress = vehicle.progressMeters + vehicle.speedKph / 3.6 * elapsedSeconds;
          const routeLength = distanceAlongRoute(vehicle.routeCoordinates);
          const finished = nextProgress >= routeLength;
          if (finished && vehicle.id === "DEMO-TRUCK") {
            const location = pointAtDistance(vehicle.routeCoordinates, routeLength);
            return {
              ...vehicle,
              status: "Delivered",
              riskObstacleId: undefined,
              progressMeters: routeLength,
              lng: location ? location.point[0] : vehicle.lng,
              lat: location ? location.point[1] : vehicle.lat
            };
          }
          const location = pointAtDistance(vehicle.routeCoordinates, nextProgress);
          if (!location) return vehicle;
          return {
            ...vehicle,
            status: vehicle.status === "At risk" || vehicle.status === "Blocked ahead" ? (vehicle.id === "DEMO-TRUCK" ? "Moving" : "On route") : (vehicle.status === "Starting" ? "Moving" : vehicle.status),
            riskObstacleId: undefined,
            bypassedObstacleId: vehicle.progressMeters > 150 ? undefined : vehicle.bypassedObstacleId,
            progressMeters: Math.min(nextProgress, routeLength),
            lng: location.point[0],
            lat: location.point[1]
          };
        }

        const polygon = obstacle.polygon ?? makeCirclePolygon(
          [obstacle.lng, obstacle.lat],
          obstacle.radiusMeters || ROAD_BLOCK_RADIUS_METERS
        );
        const movement = advanceAlongRoute(
          vehicle.routeCoordinates,
          vehicle.progressMeters,
          vehicle.speedKph / 3.6 * elapsedSeconds,
          polygon,
          95
        );
        const atRisk = {
          ...vehicle,
          status: vehicle.id === "DEMO-TRUCK" ? "Blocked ahead" : "At risk",
          riskObstacleId: obstacle.id,
          progressMeters: movement.progressMeters,
          lng: movement.point ? movement.point[0] : vehicle.lng,
          lat: movement.point ? movement.point[1] : vehicle.lat
        };
        const key = `${vehicle.id}:${obstacle.id}`;
        if (!reroutingVehicles.current.has(key)) {
          blockedVehicles.push({ vehicle: atRisk, obstacle });
        }
        if (!alertedObstacleIds.current.has(obstacle.id)) {
          alertedObstacleIds.current.add(obstacle.id);
          setSelectedVehicleId((current) => current ?? vehicle.id);
          setAlerts((current) => [{
            id: `${obstacle.id}:${vehicle.id}`,
            obstacleId: obstacle.id,
            vehicleId: vehicle.id,
            vehicleName: vehicle.name,
            title: `${vehicle.name} at risk · ${obstacle.title}`,
            timestamp: Date.now()
          }, ...current]);
        }
        return atRisk;
      });
      
      vehiclesRef.current = updated;
      
      // Throttle React state updates to ~15fps so React doesn't choke,
      // but vehiclesRef is updated at 60fps for MapView to pull from directly if needed.
      // Wait, MapView is reactive to `vehicles` state. If we want 60fps rendering, we must call setVehicles.
      setVehicles(updated);

      for (const { vehicle, obstacle } of blockedVehicles) {
        requestSafeReroute(vehicle, obstacle);
      }
    };
    
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [requestSafeReroute, vehicles.length]);

  useEffect(() => {
    const location = gps.location;
    if (!location) {
      setIncidentSearchLocation(null);
      return;
    }
    setIncidentSearchLocation((current) => {
      if (!current || distanceMeters(
        [current.longitude, current.latitude],
        [location.longitude, location.latitude]
      ) >= 1_000) return location;
      return current;
    });
  }, [gps.location]);

  useEffect(() => {
    if (!incidentSearchLocation) return;
    let cancelled = false;
    const controller = new AbortController();
    timersRef.current.add(controller);

    const refresh = async () => {
      try {
        const result = await getNearbyIncidents(incidentSearchLocation, controller.signal);
        if (!cancelled && result.configured) {
          setObstacles((current) => {
            const simulated = current.filter((obstacle) => obstacle.simulated);
            return [...simulated, ...result.incidents];
          });
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          setObstacleMessage(error instanceof Error ? error.message : "Live incident feed could not be reached.");
        }
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      controller.abort();
      timersRef.current.delete(controller);
    };
  }, [incidentSearchLocation]);

  useEffect(() => {
    if (!incidentSearchLocation || !demoFleetEnabled) return;
    const controller = new AbortController();
    timersRef.current.add(controller);
    void createDemoTrafficJams(incidentSearchLocation, controller.signal)
      .then(({ jams, obstacles: nearbyObstacles }) => {
        if (controller.signal.aborted) return;
        setObstacles((current) => [
          ...current.filter((event) => event.source !== "Demo traffic jam"
            && event.source !== "Demo road obstacle"),
          ...jams,
          ...nearbyObstacles
        ]);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setObstacleMessage(error instanceof Error ? error.message : "Could not place demo traffic jams.");
        }
      })
      .finally(() => timersRef.current.delete(controller));
    return () => {
      controller.abort();
      timersRef.current.delete(controller);
    };
  }, [incidentSearchLocation, demoFleetEnabled]);

  const addRoadBlock = useCallback(() => {
    if (!gps.location) {
      setObstacleMessage("Enable live location before adding a road block.");
      return;
    }
    void placeRoadBlock(gps.location);
  }, [gps.location, placeRoadBlock]);



  const searchDestination = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!destinationQuery.trim()) {
      setSearchError("Enter an address or place to search.");
      return;
    }
    setSearchStatus("loading");
    setSearchError("");
    try {
      const result = await searchPlaces(destinationQuery.trim(), gps.location);
      const places = (result.features ?? [])
        .map(readDestination)
        .filter((place): place is Destination => place !== null);
      if (!places.length) throw new Error("No matching places found.");
      setSearchResults(places);
      setSearchStatus("idle");
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Place search failed.");
      setSearchStatus("error");
    }
  };

  const chooseDestination = useCallback(async (place: Destination) => {
    setDestination(place);
    setDestinationQuery(place.label);
    setSearchResults([]);
    setDestinationRoute(null);
    setRouteError("");
    const loc = gps.location;
    if (!loc) {
      gps.start();
      setDestinationRouteInfo("Reading your location to plan driving route…");
      return;
    }
    try {
      setDestinationRouteInfo("Calculating road route…");
      const result = await getRoute(
        [loc.longitude, loc.latitude],
        place.coordinates,
        obstaclesRef.current
      );
      setDestinationRoute(result.routes[0]?.coordinates ?? null);
      const route = result.routes[0];
      setDestinationRouteInfo(route
        ? `${(route.distanceMeters / 1000).toFixed(1)} km · ${formatDuration(route.durationSeconds)}`
        : "No road route was returned.");
      setRouteError("");
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Could not calculate a road route.");
      setDestinationRouteInfo("");
    }
  }, [gps]);

  const pickMahendraCollege = useCallback(() => {
    const mahendra: Destination = {
      label: "Mahendra Institute of Technology, Mallasamudram, Tamil Nadu, India",
      coordinates: [78.0038689, 11.477873]
    };
    void chooseDestination(mahendra);
  }, [chooseDestination]);

  useEffect(() => {
    const loc = gps.location;
    if (destination && loc && !destinationRoute) {
      void (async () => {
        try {
          setDestinationRouteInfo("Calculating road route…");
          const result = await getRoute(
            [loc.longitude, loc.latitude],
            destination.coordinates,
            obstaclesRef.current
          );
          setDestinationRoute(result.routes[0]?.coordinates ?? null);
          const route = result.routes[0];
          setDestinationRouteInfo(route
            ? `${(route.distanceMeters / 1000).toFixed(1)} km · ${formatDuration(route.durationSeconds)}`
            : "No road route was returned.");
          setRouteError("");
        } catch (error) {
          setRouteError(error instanceof Error ? error.message : "Could not calculate a road route.");
        }
      })();
    }
  }, [destination, gps.location, destinationRoute]);

  const toggleDemoFleet = useCallback(() => {
    if (demoFleetEnabled) {
      setDemoFleetEnabled(false);
      setVehicles([]);
      setSelectedVehicleId(null);
      setObstacles((current) => current.filter((event) => event.source !== "Demo road block" && event.source !== "Demo traffic jam" && event.source !== "Demo road obstacle"));
      setAlerts([]);
      setVehicleStatus("Normal navigation mode");
    } else {
      if (!gps.location) {
        gps.start();
        setVehicleStatus("Requesting location to start demo fleet…");
      }
      setDemoFleetEnabled(true);
    }
  }, [demoFleetEnabled, gps]);

  const startDemoTruck = useCallback(() => {
    const location = gps.location;
    if (!location) {
      gps.start();
      setVehicleStatus("Requesting location to start demo truck…");
      return;
    }
    const controller = new AbortController();
    timersRef.current.add(controller);
    setVehicleStatus("Spawning demo truck and obstacle…");
    setVehicles((current) => {
      const others = current.filter((v) => v.id !== "DEMO-TRUCK");
      return [{
        id: "DEMO-TRUCK",
        name: "DEMO TRUCK",
        status: "Starting",
        speedKph: 0,
        etaSeconds: 0,
        load: "8.2 / 12 t",
        lng: location.longitude,
        lat: location.latitude,
        routeCoordinates: [],
        progressMeters: 0,
        source: "Demo truck",
        deliveries: 3
      }, ...others];
    });
    setSelectedVehicleId("DEMO-TRUCK");

    void createDemoTruck(location, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setVehicles((current) => {
          const others = current.filter((v) => v.id !== "DEMO-TRUCK");
          return [result.truck, ...others];
        });
        setSelectedVehicleId("DEMO-TRUCK");
        setObstacles((current) => {
          const others = current.filter((o) => o.id !== result.obstacle.id && !o.id.startsWith("demo-truck-block"));
          return [...others, result.obstacle];
        });
        setVehicleStatus("Demo truck active");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const errorMessage = error instanceof Error ? error.message : "Could not create demo truck.";
          setVehicleStatus(errorMessage);
          setVehicles((current) => current.filter((v) => v.id !== "DEMO-TRUCK"));
          setSelectedVehicleId((current) => current === "DEMO-TRUCK" ? null : current);
          alert(errorMessage);
        }
      })
      .finally(() => timersRef.current.delete(controller));
  }, [gps]);

  const applyRecommendedRoute = () => {
    if (!selectedVehicle || !selectedPlan?.recommendation) return;
    const route = selectedPlan.routes.find((candidate) => candidate.id === selectedPlan.recommendation);
    if (!route || selectedPlan.wait) return;
    const updated = vehiclesRef.current.map((vehicle) => vehicle.id === selectedVehicle.id
      ? {
        ...vehicle,
        previousRouteCoordinates: remainingRoute(vehicle.routeCoordinates, vehicle.progressMeters),
        routeCoordinates: route.coordinates,
        progressMeters: 0,
        lng: route.coordinates[0][0],
        lat: route.coordinates[0][1],
        status: "Rerouted",
        etaSeconds: route.durationSeconds,
        riskObstacleId: undefined
      }
      : vehicle);
    vehiclesRef.current = updated;
    setVehicles(updated);
    setRecommendations((current) => ({ ...current, [selectedVehicle.id]: undefined }));
    setRouteError("");
  };

  const locate = () => {
    setMapMode("live");
    if (gps.location) setLocateSignal((value) => value + 1);
    else gps.start();
  };

  const handleMapEvent = useCallback((event: RoadEvent) => {
    setObstacleMessage(`${event.title} · ${event.source}`);
  }, []);

  const selectedAlternative = selectedPlan?.routes.find((route) => route.id === selectedPlan.recommendation);

  return <div className="app wayfi-app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">W</span><div><strong>Wayfi</strong><small>ROUTERESQ CONTROL TOWER</small></div></div>
      <div className="header-spacer" />
      <div className={`gps-status ${gps.status === "live" ? "connected" : ""}`} title={gps.error || vehicleStatus}>
        <span className="gps-status-dot" />{gps.status === "live" ? "GPS LIVE" : gps.status === "requesting" ? "LOCATING…" : "GPS OFF"}
      </div>
      <button className="locate-icon-button" type="button" onClick={locate} aria-label={gps.location ? "Center map on my location" : "Enable live location"} title="Locate me">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3" /></svg>
      </button>
    </header>

    <main className="control-tower">
      <aside className="control-panel">
        <section className="destination-panel">
          <div className="panel-heading compact">
            <div>
              <span className="eyebrow">DESTINATION NAVIGATION</span>
              <h1>Route planner</h1>
            </div>
            {destination && (
              <button
                type="button"
                className="clear-destination-btn"
                onClick={() => {
                  setDestination(null);
                  setDestinationRoute(null);
                  setDestinationRouteInfo("");
                  setDestinationQuery("");
                }}
              >
                Clear
              </button>
            )}
          </div>

          <form className="destination-search" onSubmit={(event) => {
            void searchDestination(event);
          }}>
            <label className="visually-hidden" htmlFor="destination-search">Search destination</label>
            <input
              id="destination-search"
              value={destinationQuery}
              onChange={(event) => setDestinationQuery(event.target.value)}
              placeholder="Search destination, college, or place"
              autoComplete="off"
            />
            <button type="submit" disabled={searchStatus === "loading"}>
              {searchStatus === "loading" ? "…" : "Search"}
            </button>
          </form>

          <div className="destination-presets">
            <button
              type="button"
              className="quick-preset-chip"
              onClick={pickMahendraCollege}
              title="Quick test route to Mahendra Institute of Technology"
            >
              📍 Mahendra Institute of Technology
            </button>
          </div>

          {searchError && <p className="inline-message error-message" role="alert">{searchError}</p>}
          {searchResults.map((place) => (
            <button
              className="place-result"
              type="button"
              key={`${place.label}-${place.coordinates.join(",")}`}
              onClick={() => void chooseDestination(place)}
            >
              {place.label}
            </button>
          ))}
          {destination && (
            <div className="destination-active-card">
              <div className="dest-name">📍 {destination.label.split(",")[0]}</div>
              <div className="dest-address">{destination.label}</div>
              {destinationRouteInfo ? (
                <div className="dest-stats">
                  <strong>{destinationRouteInfo}</strong>
                </div>
              ) : (
                <p className="inline-message">Calculating road route…</p>
              )}
            </div>
          )}
          {routeError && <p className="inline-message error-message" role="alert">{routeError}</p>}
        </section>

        <section className="obstacle-controls">
          <div className="panel-heading compact">
            <div><span className="eyebrow">ROAD HAZARDS</span><h2>Active alerts</h2></div>
            <span className="count">{obstacles.length}</span>
          </div>
          <div className="obstacle-actions">
            <button
              type="button"
              className="small-action secondary"
              disabled={!gps.location}
              onClick={addRoadBlock}
            >
              Add road block
            </button>
          </div>
          {obstacleMessage && <p className="inline-message" role="status">{obstacleMessage}</p>}
          <div className="alert-list">
            {obstacles.length === 0 && (
              <p className="empty-state small">No active road obstacles on map.</p>
            )}
            {obstacles.slice().reverse().map((obstacle) => {
              const relatedAlert = alerts.find((alert) => alert.obstacleId === obstacle.id);
              return (
                <article className="alert-item" key={obstacle.id}>
                  <span className="alert-symbol">!</span>
                  <div>
                    <strong>{obstacle.title}</strong>
                    <small>{relatedAlert ? `${relatedAlert.vehicleName} at risk` : obstacle.road}</small>
                    <small>{obstacle.source} · radius {obstacle.radiusMeters} m</small>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="demo-fleet-toggle-panel">
          <div className="panel-heading compact">
            <div>
              <span className="eyebrow">SIMULATION</span>
              <h2>Demo fleet (TX vehicles)</h2>
            </div>
            <div className="fleet-controls" style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                className="toggle-fleet-btn secondary"
                onClick={startDemoTruck}
              >
                Start demo truck
              </button>
              <button
                type="button"
                className={`toggle-fleet-btn ${demoFleetEnabled ? "active" : ""}`}
                onClick={toggleDemoFleet}
              >
                {demoFleetEnabled ? "Stop Fleet" : "Enable Fleet"}
              </button>
            </div>
          </div>
          <p className="panel-subtitle">
            {demoFleetEnabled
              ? "Fleet simulation running (TX-01, TX-03, TX-07)."
              : "Demo fleet is disabled. Map is in normal clean navigation mode."}
          </p>

          {vehicles.length > 0 && (
            <div className="vehicle-card-list">
              {vehicles.sort((a, b) => (a.id === "DEMO-TRUCK" ? -1 : b.id === "DEMO-TRUCK" ? 1 : 0)).map((vehicle) => (
                <button
                  type="button"
                  className={`vehicle-card ${selectedVehicle?.id === vehicle.id ? "selected" : ""} ${vehicle.status === "At risk" || vehicle.status === "Blocked ahead" ? "risk" : ""}`}
                  key={vehicle.id}
                  onClick={() => setSelectedVehicleId(vehicle.id)}
                >
                  <div className="vehicle-card-heading">
                    <strong>{vehicle.name}</strong>
                    <span className={`vehicle-state ${vehicle.status.toLowerCase().replace(/ /g, "-")}`}>{vehicle.status}</span>
                  </div>
                  <div className="vehicle-card-meta">
                    {vehicle.status === "Delivered" ? (
                      <span>3 deliveries completed</span>
                    ) : (
                      <>
                        <span>ETA {formatDuration(vehicle.etaSeconds)}</span>
                        <span>{Math.round(vehicle.speedKph)} km/h</span>
                      </>
                    )}
                    {vehicle.load && <span>Load: {vehicle.load}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}

          {(demoFleetEnabled || vehicles.length > 0) && selectedPlan && selectedVehicle && (
            <div className="suggestion-panel">
              <div className="panel-heading compact">
                <div>
                  <span className="eyebrow">ROUTE ADVISOR · {selectedVehicle.name}</span>
                  <h3>{selectedPlan.wait ? "Wait for clearance" : selectedVehicle.status.startsWith("Rerouted") ? "Safe route applied" : "Best alternative"}</h3>
                  {selectedVehicle.startRoadName && selectedVehicle.destRoadName && (
                    <div style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "4px" }}>
                      From {selectedVehicle.startRoadName} to {selectedVehicle.destRoadName}
                    </div>
                  )}
                </div>
              </div>
              {recommendationLoading[selectedVehicle.id] ? (
                <p className="inline-message">Checking up to 3 road alternatives…</p>
              ) : (
                <>
                  <p className="suggestion-reason">{selectedPlan.reason}</p>
                  <span className="reason-source">
                    {selectedPlan.reasonSource === "gemini" ? "AI wording · route selected by routing engine" : "Template guidance"}
                  </span>
                  <div className="alternative-list">
                    {selectedPlan.routes.map((route) => (
                      <div className={`alternative-row ${route.id === selectedPlan.recommendation ? "best" : ""}`} key={route.id}>
                        <span>
                          {route.id === selectedPlan.recommendation ? "Fastest safe" : "Safe alternative"} · {route.extraTimeSeconds >= 0 ? "+" : ""}{Math.round(route.extraTimeSeconds / 60)} min vs fastest
                        </span>
                        <strong>{(route.distanceMeters / 1000).toFixed(1)} km · {formatDuration(route.durationSeconds)}</strong>
                      </div>
                    ))}
                  </div>
                  {selectedPlan.recommendation && selectedVehicle.status !== "Rerouted" && (
                    <button type="button" className="primary-action" onClick={applyRecommendedRoute}>
                      Apply route
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </aside>

      <section className={`map-panel control-map`}>
        <div className="map-overlay top">
          <div className="map-overlay-group">
            <button type="button" className={`map-mode-chip ${mapMode === "live" ? "active" : ""}`} onClick={() => setMapMode("live")}>LIVE OVERLAYS</button>
            <button type="button" className={`map-mode-chip road ${mapMode === "roads" ? "active" : ""}`} onClick={() => setMapMode("roads")}>CLEAN ROADS</button>
          </div>
          <div className="map-overlay-divider" />
          <div className="google-style-group" role="group" aria-label="Map style selection">
            <button
              type="button"
              className={`google-style-btn ${mapStyle === "streets" ? "active" : ""}`}
              onClick={() => setMapStyle("streets")}
              title="Google Streets vector styling with 3D buildings"
            >
              <span>🗺️</span> <span>Streets</span>
            </button>
            <button
              type="button"
              className={`google-style-btn ${mapStyle === "satellite" ? "active" : ""}`}
              onClick={() => setMapStyle("satellite")}
              title="Satellite imagery with 3D buildings and road overlays"
            >
              <span>🛰️</span> <span>Satellite</span>
            </button>
            <button
              type="button"
              className={`google-style-btn ${mapStyle === "light" ? "active" : ""}`}
              onClick={() => setMapStyle("light")}
              title="Light minimalist canvas"
            >
              <span>⚪</span> <span>Light</span>
            </button>
          </div>
        </div>
        <MapView
          vehicles={vehicles}
          events={obstacles}
          userLocation={gps.location}
          centerOnUserSignal={locateSignal}
          selectedVehicleId={selectedVehicle?.id ?? null}
          currentRoute={currentRoute}
          recommendedRoute={recommendedRoute}
          recommendedRouteId={selectedPlan?.recommendation ?? null}
          alternativeRoutes={alternativeRoutes}
          liveOverlays={mapMode === "live"}
          onSelectVehicle={setSelectedVehicleId}
          onEvent={handleMapEvent}
          mapStyle={mapStyle}
          onMapStyleChange={setMapStyle}
          destination={destination}
        />
        <div className="map-legend"><span><i className="legend-dot current" /> Current road</span><span><i className="legend-dot recommendation" /> Rerouted road</span><span><i className="legend-dot obstacle" /> Road block · 150 m</span></div>

      </section>
    </main>

    <footer className="control-footer">
      <span>{gps.status === "live" ? `GPS · ±${Math.round(gps.location?.accuracy ?? 0)} m` : gps.error || "Location permission required"}</span>
      <span>{demoFleetEnabled ? "SIMULATION MODE · Demo fleet active" : "NORMAL NAVIGATION MODE · Stable map"}</span>
      <span>{alerts.length} alert{alerts.length === 1 ? "" : "s"}</span>
    </footer>
  </div>;
}

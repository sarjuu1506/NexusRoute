import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import type { Destination, RoadEvent, RouteAlternative, UserLocation, Vehicle } from "../types";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_API_KEY || "LQTybYHKY6IqrTD2Xzne";

export type MapStyleKey = "streets" | "satellite" | "light";

export const MAP_STYLES: Record<MapStyleKey, { name: string; icon: string; url: string; has3D: boolean; description: string }> = {
  streets: {
    name: "Google Streets",
    icon: "🗺️",
    url: `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`,
    has3D: true,
    description: "Google Maps vector aesthetic with 3D buildings & road hierarchy"
  },
  satellite: {
    name: "Satellite",
    icon: "🛰️",
    url: `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`,
    has3D: true,
    description: "High-resolution satellite imagery with 3D buildings & road overlays"
  },
  light: {
    name: "Light Minimal",
    icon: "⚪",
    url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    has3D: false,
    description: "Minimalist high-contrast map"
  }
};

type Props = {
  vehicles: Vehicle[];
  events: RoadEvent[];
  userLocation: UserLocation | null;
  centerOnUserSignal: number;
  selectedVehicleId: string | null;
  currentRoute: [number, number][] | null;
  recommendedRoute: [number, number][] | null;
  recommendedRouteId: string | null;
  alternativeRoutes: RouteAlternative[];
  liveOverlays: boolean;


  onSelectVehicle: (id: string) => void;
  onEvent: (event: RoadEvent) => void;
  mapStyle?: MapStyleKey;
  onMapStyleChange?: (style: MapStyleKey) => void;
  destination?: Destination | null;
};

function obstacleCircle(event: RoadEvent) {
  const latitudeDelta = event.radiusMeters / 111_320;
  const longitudeDelta = latitudeDelta / Math.cos(event.lat * Math.PI / 180);
  const coordinates: [number, number][] = [];
  for (let index = 0; index <= 32; index += 1) {
    const angle = index * Math.PI * 2 / 32;
    coordinates.push([
      event.lng + Math.cos(angle) * longitudeDelta,
      event.lat + Math.sin(angle) * latitudeDelta
    ]);
  }
  return coordinates;
}

function setupBuildingLayers(map: MapLibreMap, show3D: boolean) {
  if (!map.isStyleLoaded()) return;

  // 1. Google Maps-style 2D building footprints
  if (map.getLayer("Building")) {
    try {
      map.setPaintProperty("Building", "fill-color", "#dce3ea");
      map.setPaintProperty("Building", "fill-opacity", 0.75);
      map.setPaintProperty("Building", "fill-outline-color", "#b0bcc8");
    } catch {
      // ignore
    }
  }

  // 2. Hide default low-opacity MapTiler 3D building layer to prevent conflicts
  if (map.getLayer("Building 3D")) {
    try {
      map.setLayoutProperty("Building 3D", "visibility", "none");
    } catch {
      // ignore
    }
  }

  // 3. Check for vector planet source
  if (!map.getSource("maptiler_planet")) return;

  // 4. Add high-definition custom 3D building extrusions
  if (!map.getLayer("wayfi-3d-buildings")) {
    try {
      const layers = map.getStyle().layers || [];
      const firstSymbol = layers.find((l) => l.type === "symbol");
      const beforeId = firstSymbol ? firstSymbol.id : undefined;

      map.addLayer(
        {
          id: "wayfi-3d-buildings",
          type: "fill-extrusion",
          source: "maptiler_planet",
          "source-layer": "building",
          minzoom: 13,
          layout: {
            visibility: show3D ? "visible" : "none"
          },
          paint: {
            "fill-extrusion-color": [
              "interpolate",
              ["linear"],
              ["coalesce", ["get", "render_height"], 0],
              0, "#eff3f6",
              25, "#e2e8f0",
              60, "#cbd5e1",
              120, "#94a3b8",
              250, "#64748b"
            ],
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], 12],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": 0.88,
            "fill-extrusion-vertical-gradient": true
          },
          filter: ["!has", "hide_3d"]
        },
        beforeId
      );
    } catch (err) {
      console.warn("Could not register 3D building layer:", err);
    }
  } else {
    try {
      map.setLayoutProperty("wayfi-3d-buildings", "visibility", show3D ? "visible" : "none");
    } catch {
      // ignore
    }
  }
}

function setupMapLayers(map: MapLibreMap) {
  if (!map || !map.getStyle()) return;

  // 1. Route lines
  if (!map.getSource("wayfi-routes")) {
    map.addSource("wayfi-routes", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "wayfi-fleet-routes",
      type: "line",
      source: "wayfi-routes",
      filter: ["==", ["get", "routeType"], "fleet"],
      paint: { "line-color": "#94a3b8", "line-width": 2, "line-opacity": 0.55 }
    });
    map.addLayer({
      id: "wayfi-current-route",
      type: "line",
      source: "wayfi-routes",
      filter: ["==", ["get", "routeType"], "current"],
      paint: { "line-color": "#1e293b", "line-width": 4.5, "line-opacity": 0.95 }
    });
    map.addLayer({
      id: "wayfi-old-route",
      type: "line",
      source: "wayfi-routes",
      filter: ["==", ["get", "routeType"], "old"],
      paint: {
        "line-color": "#64748b",
        "line-width": 2,
        "line-opacity": 0.75,
        "line-dasharray": [2, 2]
      }
    });
    map.addLayer({
      id: "wayfi-active-route",
      type: "line",
      source: "wayfi-routes",
      filter: ["==", ["get", "routeType"], "active"],
      paint: { "line-color": "#0ea5e9", "line-width": 6, "line-opacity": 0.98 }
    });
    map.addLayer({
      id: "wayfi-active-teal-route",
      type: "line",
      source: "wayfi-routes",
      filter: ["==", ["get", "routeType"], "active-teal"],
      paint: { "line-color": "#0d9488", "line-width": 6, "line-opacity": 0.98 }
    });
    map.addLayer({
      id: "wayfi-alternative-route",
      type: "line",
      source: "wayfi-routes",
      filter: ["==", ["get", "routeType"], "alternative"],
      paint: {
        "line-color": "#64748b",
        "line-width": 3,
        "line-opacity": 0.75,
        "line-dasharray": [2, 2]
      }
    });
    map.addLayer({
      id: "wayfi-recommended-route",
      type: "line",
      source: "wayfi-routes",
      filter: ["==", ["get", "routeType"], "recommended"],
      paint: { "line-color": "#059669", "line-width": 6, "line-opacity": 0.98 }
    });
  }

  // 2. Vehicles and Demo Truck (teal #14b8a6, radius 10, stroke 3px white)
  if (!map.getSource("wayfi-vehicles")) {
    map.addSource("wayfi-vehicles", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });

    map.addLayer({
      id: "wayfi-vehicles-circle",
      type: "circle",
      source: "wayfi-vehicles",
      paint: {
        "circle-radius": [
          "case",
          ["==", ["get", "id"], "DEMO-TRUCK"], 10,
          ["==", ["get", "selected"], true], 11,
          9
        ],
        "circle-color": [
          "case",
          ["==", ["get", "id"], "DEMO-TRUCK"], "#14b8a6",
          ["match", ["get", "status"],
            "At risk", "#ef4444",
            "Blocked ahead", "#ef4444",
            "Rerouted", "#0ea5e9",
            "Rerouted via alternative", "#0ea5e9",
            "Delivered", "#10b981",
            "#1e293b"
          ]
        ],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3,
        "circle-opacity": 1
      }
    });

    // Vehicles label symbol layer (no icon-image, DEMO TRUCK text for demo truck)
    map.addLayer({
      id: "wayfi-vehicles-label",
      type: "symbol",
      source: "wayfi-vehicles",
      layout: {
        "text-field": [
          "case",
          ["==", ["get", "id"], "DEMO-TRUCK"], "DEMO TRUCK",
          ["concat", ["get", "name"], " · Demo"]
        ],
        "text-offset": [0, 1.6],
        "text-anchor": "top",
        "text-size": 12,
        "text-allow-overlap": true,
        "text-ignore-placement": true
      },
      paint: {
        "text-color": [
          "case",
          ["==", ["get", "id"], "DEMO-TRUCK"], "#0d9488",
          "#1e293b"
        ],
        "text-halo-color": "#ffffff",
        "text-halo-width": 2
      }
    });
  }

  // 3. Road-block / Obstacle zones (Placed ABOVE the truck layer)
  if (!map.getSource("wayfi-obstacle-zones")) {
    map.addSource("wayfi-obstacle-zones", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "wayfi-obstacle-zone-fill",
      type: "fill",
      source: "wayfi-obstacle-zones",
      paint: {
        "fill-color": [
          "match", ["get", "kind"],
          "jam", "#f97316",
          "obstacle", "#8b5cf6",
          "#ef4444"
        ],
        "fill-opacity": 0.22
      }
    });
    map.addLayer({
      id: "wayfi-obstacle-zone-outline",
      type: "line",
      source: "wayfi-obstacle-zones",
      paint: {
        "line-color": [
          "match", ["get", "kind"],
          "jam", "#ea580c",
          "obstacle", "#7c3aed",
          "#dc2626"
        ],
        "line-width": 2.5,
        "line-dasharray": [2, 2]
      }
    });
  }

  // 4. Incident / Event markers (Placed ABOVE road-block layers)
  if (!map.getSource("wayfi-events")) {
    map.addSource("wayfi-events", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "wayfi-events-circle",
      type: "circle",
      source: "wayfi-events",
      paint: {
        "circle-radius": 12,
        "circle-color": [
          "match", ["get", "source"],
          "Demo traffic jam", "#ea580c",
          "Demo road obstacle", "#7c3aed",
          "#dc2626"
        ],
        "circle-stroke-width": 2
      }
    });
    map.addLayer({
      id: "wayfi-events-label",
      type: "symbol",
      source: "wayfi-events",
      layout: {
        "text-field": ["get", "title"],
        "text-offset": [0, 1.5],
        "text-anchor": "top",
        "text-size": 12
      },
      paint: {
        "text-color": "#1e293b",
        "text-halo-color": "#ffffff",
        "text-halo-width": 2
      }
    });
  }
}

export default function MapView({
  vehicles,
  events,
  userLocation,
  centerOnUserSignal,
  selectedVehicleId,
  currentRoute,
  recommendedRoute,
  recommendedRouteId,
  alternativeRoutes,
  liveOverlays,


  onSelectVehicle,
  onEvent,
  mapStyle = "streets",
  onMapStyleChange,
  destination
}: Props) {
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const liveMarker = useRef<maplibregl.Marker | null>(null);
  const destinationMarker = useRef<maplibregl.Marker | null>(null);
  const demoTruckMarker = useRef<maplibregl.Marker | null>(null);

  // Guards against camera hijacking and visual resets
  const hasLocatedInitialFix = useRef(false);
  const userHasInteracted = useRef(false);
  const lastSelectedVehicleRef = useRef<string | null>(null);
  const lastFramedDestinationRef = useRef<string | null>(null);

  const [buildings3D, setBuildings3D] = useState(false);
  const buildings3DRef = useRef(buildings3D);
  buildings3DRef.current = buildings3D;

  const [mapPitch, setMapPitch] = useState(0);

  const initialStyleUrl = MAP_STYLES[mapStyle]?.url || MAP_STYLES.streets.url;
  const currentStyleUrlRef = useRef<string>(initialStyleUrl);

  const latestProps = useRef({ onSelectVehicle, onEvent });
  latestProps.current = { onSelectVehicle, onEvent };

  const latestUserLocation = useRef(userLocation);
  latestUserLocation.current = userLocation;

  const selectedRoute = vehicles.find((vehicle) => vehicle.id === selectedVehicleId)?.routeCoordinates;

  // Extract a stable key for route geometry so we don't re-render GeoJSON when vehicles simply progress
  const routeGeometryKey = useMemo(() => {
    return [
      liveOverlays ? "1" : "0",
      selectedVehicleId ?? "",
      recommendedRouteId ?? "",
      currentRoute ? currentRoute.length : 0,
      recommendedRoute ? recommendedRoute.length : 0,
      alternativeRoutes.map((r) => `${r.id}:${r.coordinates.length}`).join(";"),
      vehicles.map((v) => `${v.id}:${v.status}:${v.routeCoordinates.length}:${v.previousRouteCoordinates?.length ?? 0}`).join(";"),
      events.map((e) => `${e.id}:${e.lng.toFixed(5)}:${e.lat.toFixed(5)}`).join(";")
    ].join("|");
  }, [alternativeRoutes, currentRoute, events, liveOverlays, recommendedRoute, recommendedRouteId, selectedVehicleId, vehicles]);

  const renderRoutes = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.getStyle()) return;

    const routeFeatures = [
      ...(liveOverlays ? vehicles.flatMap((vehicle) => [
        ...(vehicle.previousRouteCoordinates && vehicle.previousRouteCoordinates.length > 1 ? [{
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: vehicle.previousRouteCoordinates },
          properties: { routeType: "old" }
        }] : []),
        ...(vehicle.routeCoordinates.length > 1 ? [{
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: vehicle.routeCoordinates },
          properties: {
            routeType: vehicle.status.startsWith("Rerouted")
              ? (vehicle.id === "DEMO-TRUCK" ? "active-teal" : "active")
              : vehicle.id === selectedVehicleId ? "current" : "fleet"
          }
        }] : [])
      ]) : []),
      ...(liveOverlays && currentRoute && currentRoute.length > 1
        && !vehicles.some((vehicle) => vehicle.id === selectedVehicleId && vehicle.routeCoordinates === currentRoute)
        ? [{
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: currentRoute },
        properties: { routeType: "current" }
      }] : []),
      ...(liveOverlays ? alternativeRoutes : [])
        .filter((route) => route.id !== recommendedRouteId && route.coordinates.length > 1)
        .map((route) => ({
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: route.coordinates },
          properties: { routeType: "alternative" }
        })),
      ...(liveOverlays && recommendedRoute && recommendedRoute.length > 1 ? [{
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: recommendedRoute },
        properties: { routeType: "recommended" }
      }] : [])
    ];

    const routeData = {
      type: "FeatureCollection" as const,
      features: routeFeatures
    };

    setupMapLayers(map);

    const source = map.getSource("wayfi-routes") as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(routeData);
    }

    const obstacleFeatures = (liveOverlays ? events : []).map((event) => ({
      type: "Feature" as const,
      geometry: { type: "Polygon" as const, coordinates: [event.polygon ?? obstacleCircle(event)] },
      properties: {
        kind: event.source === "Demo traffic jam"
          ? "jam"
          : event.source === "Demo road obstacle" ? "obstacle" : "block"
      }
    }));
    const obstacleData = {
      type: "FeatureCollection" as const,
      features: obstacleFeatures
    };
    const obstacleSource = map.getSource("wayfi-obstacle-zones") as maplibregl.GeoJSONSource | undefined;
    if (obstacleSource) {
      obstacleSource.setData(obstacleData);
    }
  }, [alternativeRoutes, currentRoute, events, liveOverlays, recommendedRoute, recommendedRouteId, selectedVehicleId, vehicles]);

  const renderRoutesRef = useRef(renderRoutes);
  renderRoutesRef.current = renderRoutes;

  // Initialize Map
  useEffect(() => {
    if (!container.current) return;
    const initialCenter: [number, number] = userLocation
      ? [userLocation.longitude, userLocation.latitude]
      : [77.5946, 12.9716];

    const map = new maplibregl.Map({
      container: container.current,
      style: initialStyleUrl,
      center: initialCenter,
      zoom: userLocation ? 14.5 : 13.5,
      pitch: 0,
      bearing: 0,
      maxPitch: 75,
      pitchWithRotate: true,
      dragRotate: true,
      touchPitch: true
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    // Track user manual interaction: once the user pans, zooms, rotates, or pitches,
    // do NOT hijack the camera on background vehicle/obstacle updates!
    const onUserInteraction = () => {
      userHasInteracted.current = true;
    };
    map.on("dragstart", onUserInteraction);
    map.on("rotatestart", onUserInteraction);
    map.on("pitchstart", onUserInteraction);
    map.on("wheel", onUserInteraction);
    map.on("touchstart", onUserInteraction);



    for (const layerId of ["wayfi-vehicles-circle", "wayfi-demo-truck-circle"]) {
      map.on("click", layerId, (e) => {
        e.originalEvent.stopPropagation();
        userHasInteracted.current = false;
        if (e.features && e.features[0].properties) {
          latestProps.current.onSelectVehicle(e.features[0].properties.id);
        }
      });
      map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ''; });
    }

    map.on("click", "wayfi-events-circle", (e) => {
      e.originalEvent.stopPropagation();
      if (e.features && e.features[0].properties) {
        latestProps.current.onEvent(e.features[0].properties as unknown as RoadEvent);
      }
    });
    map.on("mouseenter", "wayfi-events-circle", () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on("mouseleave", "wayfi-events-circle", () => { map.getCanvas().style.cursor = ''; });

    map.on("pitch", () => {
      setMapPitch(Math.round(map.getPitch()));
    });

    map.on("styleimagemissing", (e) => {
      const id = e.id;
      if (!map.hasImage(id)) {
        const width = 1;
        const height = 1;
        const data = new Uint8Array(4);
        map.addImage(id, { width, height, data }, { sdf: true });
      }
    });

    const onMapReady = () => {
      setupBuildingLayers(map, buildings3DRef.current);
      setupMapLayers(map);
      renderRoutesRef.current();
    };

    map.on("load", onMapReady);
    map.on("style.load", onMapReady);
    map.on("styledata", onMapReady);

    map.on("error", (e) => {
      const msg = typeof e.error?.message === "string" ? e.error.message : String(e || "");
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) return;
      console.warn("MapLibre notice:", msg);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      liveMarker.current = null;
      if (destinationMarker.current) {
        destinationMarker.current.remove();
        destinationMarker.current = null;
      }
      if (demoTruckMarker.current) {
        demoTruckMarker.current.remove();
        demoTruckMarker.current = null;
      }
    };
  }, []);

  // Update style when prop changes - PRESERVING exact camera state so it NEVER resets!
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const targetUrl = MAP_STYLES[mapStyle]?.url;
    if (!targetUrl || currentStyleUrlRef.current === targetUrl) return;

    currentStyleUrlRef.current = targetUrl;

    // Capture user's exact camera view
    const camera = {
      center: map.getCenter(),
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing()
    };

    map.setStyle(targetUrl);

    map.once("style.load", () => {
      // Restore camera immediately: no reset, no jumping!
      map.jumpTo(camera);
      setupBuildingLayers(map, buildings3DRef.current);
      setupMapLayers(map);
      renderRoutesRef.current();
    });
  }, [mapStyle]);

  // Sync routes GeoJSON ONLY when actual geometry or status changes (NOT on every 250ms movement tick!)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded()) {
      renderRoutes();
    } else {
      map.once("load", renderRoutes);
    }
  }, [routeGeometryKey, renderRoutes]);

  // Sync vehicles GeoJSON (updated via setData on each frame) AND render failsafe DOM marker for DEMO-TRUCK
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getStyle()) return;

    if (!map.getSource("wayfi-vehicles")) {
      setupMapLayers(map);
    }

    const validVehicles = vehicles.filter(
      (v) => Number.isFinite(v.lng) && Number.isFinite(v.lat)
    );

    const vehicleFeatures = validVehicles.map((vehicle) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [vehicle.lng, vehicle.lat] },
      properties: {
        id: vehicle.id,
        name: vehicle.name,
        status: vehicle.status,
        selected: vehicle.id === selectedVehicleId
      }
    }));
    
    const source = map.getSource("wayfi-vehicles") as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData({ type: "FeatureCollection", features: vehicleFeatures });
      try {
        if (map.getLayer("wayfi-vehicles-circle")) map.moveLayer("wayfi-vehicles-circle");
        if (map.getLayer("wayfi-vehicles-label")) map.moveLayer("wayfi-vehicles-label");
      } catch {
        // ignore
      }
    }

    // HTML DOM Marker for DEMO-TRUCK (guaranteed visual indicator on top of canvas)
    const demoTruck = validVehicles.find((v) => v.id === "DEMO-TRUCK");
    if (demoTruck) {
      const position: [number, number] = [demoTruck.lng, demoTruck.lat];
      if (!demoTruckMarker.current) {
        const el = document.createElement("div");
        el.className = "demo-truck-marker";
        el.innerHTML = `
          <div class="demo-truck-pulse"></div>
          <div class="demo-truck-dot">🚚</div>
          <div class="demo-truck-badge">DEMO TRUCK</div>
        `;
        el.onclick = (e) => {
          e.stopPropagation();
          latestProps.current.onSelectVehicle("DEMO-TRUCK");
        };
        demoTruckMarker.current = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat(position)
          .addTo(map);
      } else {
        demoTruckMarker.current.setLngLat(position);
      }
      demoTruckMarker.current.getElement().style.display = liveOverlays ? "" : "none";
    } else if (demoTruckMarker.current) {
      demoTruckMarker.current.remove();
      demoTruckMarker.current = null;
    }
  }, [liveOverlays, selectedVehicleId, vehicles]);

  // Sync events/obstacles GeoJSON (updated via setData)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getStyle()) return;

    const eventFeatures = events.map((event) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [event.lng, event.lat] },
      properties: {
        id: event.id,
        title: event.title,
        source: event.source
      }
    }));

    const source = map.getSource("wayfi-events") as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData({ type: "FeatureCollection", features: eventFeatures });
    }
  }, [events]);

  // Toggle visibility of overlay layers without thrashing on each frame
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getStyle()) return;

    const visibility = liveOverlays ? "visible" : "none";
    const overlayLayers = [
      "wayfi-vehicles-circle",
      "wayfi-vehicles-label",
      "wayfi-events-circle",
      "wayfi-events-label"
    ];
    for (const layerId of overlayLayers) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", visibility);
      }
    }
  }, [liveOverlays]);

  // Live user location marker - only swoops ONCE on the very first GPS lock!
  // Subsequent GPS watcher ticks only move the dot icon and NEVER pull the camera away!
  useEffect(() => {
    if (!userLocation) return;
    const map = mapRef.current;
    if (!map) return;
    const position: [number, number] = [userLocation.longitude, userLocation.latitude];
    if (!liveMarker.current) {
      const element = document.createElement("div");
      element.className = "live-location-marker";
      element.innerHTML = '<span class="live-location-pulse"></span><span class="live-location-dot"></span>';
      liveMarker.current = new maplibregl.Marker({ element })
        .setLngLat(position)
        .setPopup(new maplibregl.Popup().setText("Your live device location"))
        .addTo(map);

      // Only fly on the very first GPS lock if the user hasn't already explored manually
      if (!userHasInteracted.current && !hasLocatedInitialFix.current) {
        hasLocatedInitialFix.current = true;
        map.flyTo({ center: position, zoom: 15, duration: 1_000 });
      }
    } else {
      liveMarker.current.setLngLat(position);
    }
    liveMarker.current.getElement().style.display = liveOverlays ? "" : "none";
  }, [liveOverlays, userLocation]);

  // Explicit Re-center on user signal (User clicked "Locate me" button)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !userLocation || centerOnUserSignal === 0) return;
    // Explicit user action: reset interaction flag and fly smoothly, PRESERVING user pitch & bearing!
    userHasInteracted.current = false;
    map.flyTo({
      center: [userLocation.longitude, userLocation.latitude],
      zoom: Math.max(map.getZoom(), 14),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      duration: 800
    });
  }, [centerOnUserSignal, userLocation]);

  // Destination marker and one-shot framing when destination is chosen
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!destination) {
      lastFramedDestinationRef.current = null;
      if (destinationMarker.current) {
        destinationMarker.current.remove();
        destinationMarker.current = null;
      }
      return;
    }

    if (!destinationMarker.current) {
      const element = document.createElement("div");
      element.className = "destination-map-marker";
      element.innerHTML = `
        <div class="destination-marker-pin"></div>
        <div class="destination-marker-label">${destination.label.split(",")[0]}</div>
      `;
      destinationMarker.current = new maplibregl.Marker({ element, anchor: "bottom" })
        .setLngLat(destination.coordinates)
        .addTo(map);
    } else {
      destinationMarker.current.setLngLat(destination.coordinates);
      const label = destinationMarker.current.getElement().querySelector(".destination-marker-label");
      if (label) label.textContent = destination.label.split(",")[0];
    }

    // Frame destination ONLY ONCE when a new destination or route is calculated
    const destKey = `${destination.coordinates.join(",")}:${currentRoute ? currentRoute.length : 0}`;
    if (lastFramedDestinationRef.current === destKey) return;
    lastFramedDestinationRef.current = destKey;

    userHasInteracted.current = false;
    const bounds = new maplibregl.LngLatBounds().extend(destination.coordinates);
    const loc = latestUserLocation.current;
    if (loc) {
      bounds.extend([loc.longitude, loc.latitude]);
    }
    if (currentRoute && currentRoute.length > 1) {
      for (const pt of currentRoute) bounds.extend(pt);
    }

    const fitDestination = () => {
      map.fitBounds(bounds, {
        padding: { top: 90, right: 90, bottom: 90, left: 90 },
        pitch: map.getPitch(),
        duration: 800
      });
    };

    if (map.isStyleLoaded()) fitDestination();
    else map.once("load", fitDestination);
  }, [destination, currentRoute]);

  // One-time fit bounds for demo truck and its route after "Start demo truck" (with 60 px padding)
  const lastFramedTruckRouteRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const truck = vehicles.find((v) => v.id === "DEMO-TRUCK");
    if (!truck || !truck.routeCoordinates || truck.routeCoordinates.length < 2) {
      if (!truck) {
        lastFramedTruckRouteRef.current = null;
      }
      return;
    }

    const startPt = truck.routeCoordinates[0];
    const endPt = truck.routeCoordinates[truck.routeCoordinates.length - 1];
    const truckRouteKey = `${truck.routeCoordinates.length}:${startPt[0]},${startPt[1]}:${endPt[0]},${endPt[1]}`;

    if (lastFramedTruckRouteRef.current === truckRouteKey) return;
    lastFramedTruckRouteRef.current = truckRouteKey;

    userHasInteracted.current = false;
    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([truck.lng, truck.lat]);
    for (const coord of truck.routeCoordinates) {
      bounds.extend(coord);
    }

    const fitTruck = () => {
      map.fitBounds(bounds, {
        padding: 60,
        pitch: map.getPitch(),
        duration: 800
      });
    };

    try {
      fitTruck();
    } catch {
      // ignore
    }
  }, [vehicles]);


  // 3D Tilt button handler - toggles between 2D (pitch 0) and 3D (pitch 55) smoothly
  const toggle3D = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const pitch = map.getPitch();
    if (pitch > 15) {
      map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    } else {
      const currentBearing = map.getBearing();
      map.easeTo({
        pitch: 55,
        bearing: currentBearing === 0 ? -12 : currentBearing,
        duration: 900
      });
      if (!buildings3D) {
        setBuildings3D(true);
        setupBuildingLayers(map, true);
      }
    }
  }, [buildings3D]);

  // Toggle 3D buildings layer
  const toggleBuildings = useCallback(() => {
    setBuildings3D((prev) => {
      const next = !prev;
      const map = mapRef.current;
      if (map) setupBuildingLayers(map, next);
      return next;
    });
  }, []);

  return (
    <div className="map-view-wrapper">
      <div ref={container} className="map-canvas" />

      {/* Floating 3D Controls at top right underneath zoom */}
      <div className="google-map-floating-3d">
        <button
          type="button"
          className={`google-3d-btn ${mapPitch > 15 ? "tilted" : ""}`}
          onClick={toggle3D}
          title={mapPitch > 15 ? "Switch to flat 2D top-down view" : "Tilt camera into 3D Google perspective"}
          aria-label={mapPitch > 15 ? "Switch to 2D view" : "Switch to 3D view"}
        >
          <span className="btn-cube-icon">📐</span>
          <span className="btn-label">{mapPitch > 15 ? "2D" : "3D"}</span>
          {mapPitch > 15 && <span className="pitch-badge">{mapPitch}°</span>}
        </button>

        {MAP_STYLES[mapStyle]?.has3D && (
          <button
            type="button"
            className={`google-buildings-chip ${buildings3D ? "active" : ""}`}
            onClick={toggleBuildings}
            title="Toggle 3D building extrusions on/off"
          >
            <span>🏢 3D Buildings</span>
            <span className={`chip-status ${buildings3D ? "on" : "off"}`}>
              {buildings3D ? "ON" : "OFF"}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

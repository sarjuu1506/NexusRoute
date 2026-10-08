# RouteResQ

RouteResQ is a map-first logistics disruption control tower.

## Run
```bash
npm install
npm run dev
```
Open the HTTPS deployment (or localhost) and press **Locate me**. Browser geolocation requires a secure context; `localhost` is normally allowed.

## Live GPS and the demo fleet
The app uses one `navigator.geolocation.watchPosition()` watcher with high accuracy, 5-second cache age and a 15-second timeout. A single MapLibre marker is updated with `setLngLat()`; the map only recenters on the first valid fix.

After location permission is granted, the backend requests road routes around that live position and creates three clearly labeled demo vehicles along the returned route geometry. Vehicle starts are kept near the live location so the nearby road-block demo can be shown. The vehicles advance smoothly along their routes at their displayed road speeds; they are demo data, not connected to real trackers.
Demo trip targets are kept about 1.5 km from the live location, and selecting or rerouting a vehicle frames that local route together with the live position.

On startup, Wayfi road-snaps one **Road block** onto a demo vehicle's route 300–800 m from the live location. **Add road block** replaces it with a newly snapped nearby block; **Add obstacle** lets an operator tap a map point to road-snap a block. Each block is represented by a 150 m polygon. Vehicles stop just before intersecting its boundary, request up to three OpenRouteService alternatives, and resume only on the quickest returned route verified not to intersect the polygon. If none passes verification, the vehicle stays stopped and the panel recommends waiting.

The demo also places exactly three small traffic-jam indicators and three separate road obstacles ahead of the live location using nearby TomTom road routes. Demo obstacles are distinct from jams and can trigger the vehicle road-block safety flow. The map frames the initial set once and does not refit on later location or incident refreshes, preserving manual pan and zoom.

## Road map and obstacle-aware routing
- The map uses a CARTO street-map style with OpenStreetMap road data and attribution.
- Search for and select a destination to request a road route from the backend.
- TomTom's reported traffic incident feed is searched within 5 km of the live location and refreshed every minute. It does not detect camera-visible debris or hazards absent from TomTom.
- All provider requests are served by the same-origin `/api` backend; provider credentials are read server-side from `.env` (`ORS_API_KEY`, `TOMTOM_API_KEY`, `GEMINI_API_KEY`) and are not exposed as frontend `VITE_` variables.
- Set the server-only values in `.env` using `.env.example` as a guide. Run `npm run dev` for the Vite development server with its private API middleware; build with `npm run build`, then run `npm start` to serve the build and API together.
- If Gemini is not configured or unavailable, a deterministic template explains the chosen route. The base map remains the existing CARTO/OpenStreetMap style.

## Architecture
- React + TypeScript + Vite
- MapLibre GL JS
- Real browser/device GPS
- Separate fleet, event and user-location state
- Fleet movement and road blocks are demo-only; GPS and map tiles are live, while route, snap, traffic incidents and optional explanation are provided by configured server-side services.

This standalone package is a complete runnable source project built around the RouteResQ product specification; it is not a Hatchable export.

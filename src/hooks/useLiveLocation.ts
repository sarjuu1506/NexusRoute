import { useCallback, useEffect, useRef, useState } from "react";
import type { UserLocation } from "../types";

type Status = "idle"|"requesting"|"live"|"denied"|"unavailable"|"timeout"|"error";

export function useLiveLocation() {
  const [location,setLocation] = useState<UserLocation|null>(null);
  const [status,setStatus] = useState<Status>("idle");
  const [error,setError] = useState<string>("");
  const watchId = useRef<number|null>(null);
  const firstFix = useRef(true);

  const stop = useCallback(() => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setStatus("unavailable"); setError("Location unavailable"); return;
    }
    if (watchId.current !== null) return;
    setStatus("requesting"); setError("");
    watchId.current = navigator.geolocation.watchPosition(
      p => {
        setLocation({
          latitude:p.coords.latitude,
          longitude:p.coords.longitude,
          accuracy:p.coords.accuracy,
          timestamp:p.timestamp
        });
        setStatus("live"); setError("");
      },
      e => {
        if (e.code === 1) { setStatus("denied"); setError("Location permission denied"); }
        else if (e.code === 2) { setStatus("unavailable"); setError("Location unavailable"); }
        else if (e.code === 3) { setStatus("timeout"); setError("Location request timed out"); }
        else { setStatus("error"); setError("Unable to read device location"); }
      },
      {enableHighAccuracy:true, maximumAge:5000, timeout:15000}
    );
  }, []);

  useEffect(() => () => stop(), [stop]);

  return {location,status,error,start,stop,firstFix};
}
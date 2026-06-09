export interface GeoState {
  lat: number;
  lng: number;
  altitude: number;       // metres above sea level
  temperature: number;    // °C
  windSpeed: number;      // km/h
  windDirection: number;  // degrees
  cloudCover: number;     // 0-100
  humidity: number;       // 0-100
  weatherCode: number;    // WMO code
}

type Subscriber = (state: GeoState) => void;

const DEFAULT_STATE: GeoState = {
  lat: 0,
  lng: 0,
  altitude: 0,
  temperature: 0,
  windSpeed: 0,
  windDirection: 0,
  cloudCover: 0,
  humidity: 0,
  weatherCode: 0,
};

const SIGNIFICANT_DISTANCE_M = 100;
const WEATHER_POLL_MS = 120_000;

function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class GeoStateManager {
  private state: GeoState = { ...DEFAULT_STATE };
  private subscribers = new Set<Subscriber>();

  private watchId: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  // Fetch guards
  private fetchInFlight = false;
  private pendingFetch: { lat: number; lng: number } | null = null;
  private lastFetchedLat: number | null = null;
  private lastFetchedLng: number | null = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    cb({ ...this.state }); // immediate snapshot
    return () => this.subscribers.delete(cb);
  }

  getState(): GeoState {
    return { ...this.state };
  }

  start(): void {
    this.stopped = false;

    if (!('geolocation' in navigator)) return;

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.onPosition(pos),
      () => { /* permission denied or unavailable — keep last state */ },
      { enableHighAccuracy: true, maximumAge: 5_000 },
    );

    // Time-based weather re-poll; elevation only re-fetches on significant moves
    this.pollTimer = setInterval(() => {
      if (!this.stopped && (this.state.lat !== 0 || this.state.lng !== 0)) {
        void this.fetchWeather(this.state.lat, this.state.lng);
      }
    }, WEATHER_POLL_MS);
  }

  stop(): void {
    this.stopped = true;

    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Reset fetch state so the next start() treats the first position as fresh
    this.fetchInFlight = false;
    this.pendingFetch = null;
    this.lastFetchedLat = null;
    this.lastFetchedLng = null;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private emit(): void {
    const snapshot = { ...this.state };
    this.subscribers.forEach((cb) => cb(snapshot));
  }

  private patch(partial: Partial<GeoState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private onPosition(pos: GeolocationPosition): void {
    if (this.stopped) return;
    const { latitude: lat, longitude: lng } = pos.coords;
    this.patch({ lat, lng });

    if (this.isSignificantMove(lat, lng)) {
      this.triggerFetch(lat, lng);
    }
  }

  private isSignificantMove(lat: number, lng: number): boolean {
    if (this.lastFetchedLat === null || this.lastFetchedLng === null) return true;
    return (
      haversineMetres(this.lastFetchedLat, this.lastFetchedLng, lat, lng) >=
      SIGNIFICANT_DISTANCE_M
    );
  }

  // Queue at most one pending fetch so we don't pile up concurrent requests
  private triggerFetch(lat: number, lng: number): void {
    if (this.fetchInFlight) {
      this.pendingFetch = { lat, lng };
      return;
    }
    void this.runFetch(lat, lng);
  }

  private async runFetch(lat: number, lng: number): Promise<void> {
    this.fetchInFlight = true;
    this.lastFetchedLat = lat;
    this.lastFetchedLng = lng;

    await this.fetchWeather(lat, lng);

    this.fetchInFlight = false;

    // Drain any significant move that arrived while we were fetching
    if (this.pendingFetch) {
      const { lat: pLat, lng: pLng } = this.pendingFetch;
      this.pendingFetch = null;
      void this.runFetch(pLat, pLng);
    }
  }

  private async fetchWeather(lat: number, lng: number): Promise<void> {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover,relative_humidity_2m,weather_code`;

    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = (await res.json()) as {
        elevation: number;
        current: {
          temperature_2m: number;
          wind_speed_10m: number;
          wind_direction_10m: number;
          cloud_cover: number;
          relative_humidity_2m: number;
          weather_code: number;
        };
      };
      if (this.stopped) return;
      const c = data.current;
      this.patch({
        altitude: data.elevation ?? this.state.altitude,
        temperature: c.temperature_2m ?? this.state.temperature,
        windSpeed: c.wind_speed_10m ?? this.state.windSpeed,
        windDirection: c.wind_direction_10m ?? this.state.windDirection,
        cloudCover: c.cloud_cover ?? this.state.cloudCover,
        humidity: c.relative_humidity_2m ?? this.state.humidity,
        weatherCode: c.weather_code ?? this.state.weatherCode,
      });
    } catch {
      // network error — keep last known values
    }
  }
}

export const geoState = new GeoStateManager();

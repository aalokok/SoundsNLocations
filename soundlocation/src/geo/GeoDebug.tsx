import { useEffect, useState } from 'react';
import { geoState, type GeoState } from './geoState';

function compassDir(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

const mono: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 11,
  lineHeight: 1.7,
  color: 'rgba(255,255,255,0.55)',
  pointerEvents: 'none',
  userSelect: 'none',
}

export default function GeoDebug() {
  const [s, setState] = useState<GeoState>(geoState.getState());

  useEffect(() => { return geoState.subscribe(setState); }, []);

  const loc = s.lat !== 0 || s.lng !== 0;

  return (
    <div style={{ position: 'fixed', bottom: 16, left: 16, zIndex: 9999, ...mono }}>
      <div>{loc ? `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}` : '—'}</div>
      <div>{s.altitude.toFixed(0)} m · {s.temperature.toFixed(1)} °C</div>
      <div>{s.windSpeed.toFixed(1)} km/h {compassDir(s.windDirection)} · {s.cloudCover}% cloud</div>
      <div>{s.humidity}% humidity · WMO {s.weatherCode}</div>
    </div>
  );
}

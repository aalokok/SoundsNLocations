import { useEffect, useState } from 'react';
import { geoState, type GeoState } from './geoState';

const STYLES: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    bottom: '16px',
    left: '16px',
    zIndex: 9999,
    background: 'rgba(0, 0, 0, 0.75)',
    backdropFilter: 'blur(6px)',
    color: '#e2e8f0',
    fontFamily: '"Courier New", Courier, monospace',
    fontSize: '11px',
    lineHeight: '1.6',
    padding: '10px 14px',
    borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.1)',
    minWidth: '220px',
    pointerEvents: 'none',
    userSelect: 'none',
  },
  title: {
    display: 'block',
    color: '#7dd3fc',
    fontWeight: 'bold',
    letterSpacing: '0.12em',
    marginBottom: '6px',
    fontSize: '10px',
    textTransform: 'uppercase' as const,
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '16px',
  },
  label: {
    color: '#94a3b8',
  },
  value: {
    color: '#f1f5f9',
    textAlign: 'right' as const,
  },
};

interface RowProps {
  label: string;
  value: string;
}

function Row({ label, value }: RowProps) {
  return (
    <div style={STYLES.row}>
      <span style={STYLES.label}>{label}</span>
      <span style={STYLES.value}>{value}</span>
    </div>
  );
}

function compassDir(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

export default function GeoDebug() {
  const [state, setState] = useState<GeoState>(geoState.getState());

  useEffect(() => {
    return geoState.subscribe(setState);
  }, []);

  const hasLocation = state.lat !== 0 || state.lng !== 0;

  return (
    <div style={STYLES.overlay}>
      <span style={STYLES.title}>⬡ geo state</span>
      <Row label="lat" value={hasLocation ? state.lat.toFixed(5) : '—'} />
      <Row label="lng" value={hasLocation ? state.lng.toFixed(5) : '—'} />
      <Row label="altitude" value={`${state.altitude.toFixed(0)} m`} />
      <Row label="temp" value={`${state.temperature.toFixed(1)} °C`} />
      <Row
        label="wind"
        value={`${state.windSpeed.toFixed(1)} km/h ${compassDir(state.windDirection)}`}
      />
      <Row label="cloud" value={`${state.cloudCover} %`} />
      <Row label="humidity" value={`${state.humidity} %`} />
      <Row label="WMO code" value={String(state.weatherCode)} />
    </div>
  );
}

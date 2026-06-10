import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { geoState } from '../geo/geoState'

// ── Constants ─────────────────────────────────────────────────────────────────

const GRID_SIZE  = 20          // 20×20 = 400 elevation samples
const GRID_SPAN  = 0.05          // ±0.05° (~±5.5 km at mid-latitudes)
const V_SCALE    = 1.2
const REFETCH_M  = 500           // re-fetch only after moving 500 m
const BATCH_SIZE = 50            // 8 batches for 400 points (50×8)
const BATCH_DELAY_MS = 5_000     // 5 s between batch requests

// Module-level guards — survive React StrictMode remount
let _fetchInFlight = false
let _gridCenterLat: number | null = null
let _gridCenterLng: number | null = null

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000
  const toR = (d: number) => (d * Math.PI) / 180
  const dLat = toR(lat2 - lat1)
  const dLng = toR(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── Shaders ───────────────────────────────────────────────────────────────────

const vertexShader = /* glsl */ `
  varying float vElevation;
  varying vec3  vNormal;
  varying vec2  vUv;

  void main() {
    vElevation = position.z;
    vNormal    = normalize(normalMatrix * normal);
    vUv        = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform float u_time;
  uniform float u_temperature; // °C  (-20 → 40)
  uniform float u_altitude;    // m above sea level (user's GPS elevation)
  uniform float u_windSpeed;   // km/h (0 → 120)
  uniform float u_cloudCover;  // 0-100
  uniform float u_humidity;    // 0-100

  varying float vElevation;
  varying vec3  vNormal;
  varying vec2  vUv;

  const float V_SCALE = ${V_SCALE.toFixed(2)};

  // ── Value noise + fBm ────────────────────────────────────────────────────

  float hash2(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i),              hash2(i + vec2(1.0, 0.0)), u.x),
      mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    vec2  shift = vec2(1.7, 9.2);
    for (int i = 0; i < 6; i++) {
      v += a * vnoise(p);
      p  = p * 2.1 + shift;
      a *= 0.5;
    }
    return v;
  }

  // ── 5-stop elevation gradient ────────────────────────────────────────────
  //   0.00 = deep ocean navy
  //   0.25 = midnight blue
  //   0.50 = teal
  //   0.75 = mint green
  //   1.00 = brilliant near-white

  vec3 elevGradient(float h) {
    vec3 c0 = vec3(0.01, 0.04, 0.18);
    vec3 c1 = vec3(0.03, 0.18, 0.60);
    vec3 c2 = vec3(0.00, 0.62, 0.68);
    vec3 c3 = vec3(0.18, 0.90, 0.68);
    vec3 c4 = vec3(0.88, 0.96, 1.00);

    if      (h < 0.25) return mix(c0, c1, h / 0.25);
    else if (h < 0.50) return mix(c1, c2, (h - 0.25) / 0.25);
    else if (h < 0.75) return mix(c2, c3, (h - 0.50) / 0.25);
    else               return mix(c3, c4, (h - 0.75) / 0.25);
  }

  void main() {
    float h = clamp(vElevation / V_SCALE, 0.0, 1.0);

    // ── Base elevation colour ───────────────────────────────────────────────
    vec3 color = elevGradient(h);

    // ── Temperature tint ────────────────────────────────────────────────────
    // Cold (-20°C) pulls the palette blue; warm (40°C) pushes it amber-gold.
    float temp01   = clamp((u_temperature + 20.0) / 60.0, 0.0, 1.0);
    float tempBias = (temp01 - 0.5) * 0.55;
    color += vec3(tempBias * 0.70, tempBias * 0.05, -tempBias * 0.55);
    color  = clamp(color, 0.0, 1.0);

    // ── Directional lighting via normals ────────────────────────────────────
    // Using interpolated normals along wireframe edges gives subtle depth —
    // lines facing the sun glow, lines in shadow stay cool.
    vec3  sunDir  = normalize(vec3(0.75, 0.35, 1.0));
    float diffuse = max(dot(normalize(vNormal), sunDir), 0.0);
    float light   = 0.30 + diffuse * 0.70;
    color *= light;

    // ── Procedural noise detail ─────────────────────────────────────────────
    // Amplitude and drift speed scale with wind speed so high wind = chaotic.
    float windNorm = clamp(u_windSpeed / 80.0, 0.0, 1.0);
    float noiseAmp = 0.10 + windNorm * 0.32;
    float noiseDrift = u_time * (0.06 + windNorm * 0.20);

    // Two noise layers: slow large-form + faster fine detail
    float n1 = fbm(vUv * 5.0  + vec2(noiseDrift, 0.0));
    float n2 = fbm(vUv * 14.0 + vec2(0.0, noiseDrift * 1.4));
    float noiseVal = mix(n1, n2, 0.35) * 2.0 - 1.0; // centred at 0
    color += color * noiseVal * noiseAmp;

    // ── Rising scan pulse ───────────────────────────────────────────────────
    // A wave that climbs from valley to peak, suppressed at the flat floor.
    float pulse = sin(h * 7.0 * 3.14159 - u_time * 1.5) * 0.5 + 0.5;
    color += elevGradient(h) * pulse * h * 0.18;

    // ── Cloud cover ─────────────────────────────────────────────────────────
    // Desaturates toward greyscale and dims; 100% cloud = flat dim grey.
    float cloudNorm = u_cloudCover / 100.0;
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, vec3(lum * 0.65 + 0.06), cloudNorm * 0.65);
    color *= 1.0 - cloudNorm * 0.30;

    // ── Humidity valley haze ────────────────────────────────────────────────
    float humidNorm = u_humidity / 100.0;
    color = mix(color, vec3(0.07, 0.10, 0.20), humidNorm * (1.0 - h) * 0.42);

    // ── Altitude atmosphere ─────────────────────────────────────────────────
    // u_altitude is the user's real GPS elevation (e.g. 56 m in Montreal).
    // Low altitude (near sea level) = dense atmosphere, blue-grey haze over
    // the whole scene.  High altitude (>1000 m) = thin air, vivid and bright.
    float alt01 = clamp(u_altitude / 1000.0, 0.0, 1.0);
    // Atmospheric scatter: more at low altitude, fades out by ~1000 m
    float scatter = (1.0 - alt01) * 0.35;
    color = mix(color, vec3(0.10, 0.14, 0.30), scatter);
    // Clarity boost at high altitude: saturate and brighten
    color *= 1.0 + alt01 * 0.25;

    // ── "You are here" radial glow at mesh centre ───────────────────────────
    // The centre of the mesh (vUv == 0.5) is the user's GPS position.
    // A pulsing ring marks it, whose brightness scales with altitude.
    vec2  d      = vUv - vec2(0.5);
    float dist   = length(d);
    // Concentric rings that expand outward over time
    float ring   = sin(dist * 40.0 - u_time * 2.5) * 0.5 + 0.5;
    float radial = smoothstep(0.25, 0.0, dist) * ring * (0.15 + alt01 * 0.25);
    color += vec3(0.4, 0.85, 1.0) * radial;

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`

// ── Component ─────────────────────────────────────────────────────────────────

export default function GeoVisuals() {
  const mountRef   = useRef<HTMLDivElement>(null)
  const fetchRef   = useRef<((lat: number, lng: number) => void) | null>(null)

  const [debugLat, setDebugLat] = useState('')
  const [debugLng, setDebugLng] = useState('')
  const [fetching, setFetching] = useState(false)

  function handleDebugFetch() {
    const lat = parseFloat(debugLat)
    const lng = parseFloat(debugLng)
    if (isNaN(lat) || isNaN(lng)) return
    fetchRef.current?.(lat, lng)
  }

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let alive = true

    // ── Scene ─────────────────────────────────────────────────────────────
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x020408)

    const camera = new THREE.PerspectiveCamera(
      55, window.innerWidth / window.innerHeight, 0.1, 100,
    )
    camera.position.set(0, -3.8, 3.6)
    camera.lookAt(0, 0.3, 0.4)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    mount.appendChild(renderer.domElement)

    // ── Geometry: 19×19 segments → 20×20 vertices ───────────────────────────
    const SEGS     = GRID_SIZE - 1
    const geometry = new THREE.PlaneGeometry(5, 5, SEGS, SEGS)

    const uniforms = {
      u_time:        { value: 0.0 },
      u_temperature: { value: 20.0 },
      u_altitude:    { value: 0.0 },
      u_windSpeed:   { value: 0.0 },
      u_cloudCover:  { value: 0.0 },
      u_humidity:    { value: 50.0 },
    }

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
      wireframe: true,
    })

    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)

    // ── Per-vertex animation + elevation fetch ────────────────────────────
    const TOTAL       = GRID_SIZE * GRID_SIZE
    const ANIM_DUR    = 2.2
    const MAX_STAGGER = 0.6

    const targetZ   = new Float32Array(TOTAL)
    const fromZ     = new Float32Array(TOTAL)
    const animStart = new Float32Array(TOTAL)
    const stagger   = Float32Array.from({ length: TOTAL }, () => Math.random() * MAX_STAGGER)
    const positions = geometry.attributes.position as THREE.BufferAttribute

    function easeOutCubic(t: number) { return 1 - (1 - t) ** 3 }

    const clock = new THREE.Clock()

    async function fetchAndApplyGrid(lat: number, lng: number) {
      if (_fetchInFlight || !alive) return
      _fetchInFlight   = true
      _gridCenterLat   = lat
      _gridCenterLng   = lng
      setFetching(true)

      const lats: string[] = []
      const lngs: string[] = []
      for (let row = 0; row < GRID_SIZE; row++) {
        for (let col = 0; col < GRID_SIZE; col++) {
          lats.push((lat + (0.5 - row / SEGS) * 2 * GRID_SPAN).toFixed(6))
          lngs.push((lng + (col / SEGS - 0.5) * 2 * GRID_SPAN).toFixed(6))
        }
      }

      try {
        const total    = lats.length
        const allElevs = new Array<number>(total).fill(0)
        const loaded   = new Array<boolean>(total).fill(false)
        let gMin = Infinity
        let gMax = -Infinity

        function applyLoaded() {
          const range = Math.max(gMax - gMin, 1)
          const now   = clock.getElapsedTime()
          for (let k = 0; k < total; k++) {
            if (!loaded[k]) continue
            const newTarget = ((allElevs[k] - gMin) / range) * V_SCALE
            if (Math.abs(newTarget - targetZ[k]) > 0.001) {
              fromZ[k]     = positions.getZ(k)
              animStart[k] = now + stagger[k]
              targetZ[k]   = newTarget
            }
          }
        }

        for (let i = 0; i < total; i += BATCH_SIZE) {
          if (!alive) { _fetchInFlight = false; return }

          const bLats = lats.slice(i, i + BATCH_SIZE).join(',')
          const bLngs = lngs.slice(i, i + BATCH_SIZE).join(',')
          try {
            const r = await fetch(`/api/elevation?latitude=${bLats}&longitude=${bLngs}`)
            if (r.ok) {
              const d = (await r.json()) as { elevation: number[] }
              d.elevation.forEach((e, j) => {
                const idx = i + j
                allElevs[idx] = e
                loaded[idx]   = true
                if (e < gMin) gMin = e
                if (e > gMax) gMax = e
              })
              applyLoaded()
            }
          } catch { /* skip batch */ }

          if (i + BATCH_SIZE < total) {
            await new Promise<void>(resolve => setTimeout(resolve, BATCH_DELAY_MS))
          }
        }
      } catch { /* keep current geometry */ }
      _fetchInFlight = false
      setFetching(false)
    }

    fetchRef.current = (lat, lng) => {
      _gridCenterLat = null // force re-fetch for manual debug
      void fetchAndApplyGrid(lat, lng)
    }

    let isInitialSnapshot = true

    const unsub = geoState.subscribe((state) => {
      uniforms.u_temperature.value = state.temperature
      uniforms.u_altitude.value    = state.altitude
      uniforms.u_windSpeed.value   = state.windSpeed
      uniforms.u_cloudCover.value  = state.cloudCover
      uniforms.u_humidity.value    = state.humidity

      if (isInitialSnapshot) {
        isInitialSnapshot = false
        if (state.lat !== 0 || state.lng !== 0) {
          setDebugLat(prev => prev === '' ? state.lat.toFixed(5) : prev)
          setDebugLng(prev => prev === '' ? state.lng.toFixed(5) : prev)
          if (_gridCenterLat === null && !_fetchInFlight) void fetchAndApplyGrid(state.lat, state.lng)
        }
        return
      }

      if (state.lat === 0 && state.lng === 0) return

      setDebugLat(prev => prev === '' ? state.lat.toFixed(5) : prev)
      setDebugLng(prev => prev === '' ? state.lng.toFixed(5) : prev)

      const needsGrid =
        _gridCenterLat === null ||
        haversineM(_gridCenterLat, _gridCenterLng!, state.lat, state.lng) > REFETCH_M
      if (needsGrid) void fetchAndApplyGrid(state.lat, state.lng)
    })

    // ── Resize ────────────────────────────────────────────────────────────
    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', onResize)

    // ── Animation loop ────────────────────────────────────────────────────
    let rafId: number
    const ROTATION_PERIOD = 120

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      const t = clock.getElapsedTime()
      uniforms.u_time.value = t
      mesh.rotation.z = (t / ROTATION_PERIOD) * Math.PI * 2

      let dirty = false
      for (let i = 0; i < TOTAL; i++) {
        const tgt = targetZ[i]
        const cur = positions.getZ(i)
        if (cur === tgt) continue
        const elapsed = t - animStart[i]
        if (elapsed <= 0) continue
        const progress = Math.min(elapsed / ANIM_DUR, 1.0)
        positions.setZ(i, fromZ[i] + (tgt - fromZ[i]) * easeOutCubic(progress))
        dirty = true
      }
      if (dirty) {
        positions.needsUpdate = true
        geometry.computeVertexNormals()
      }

      renderer.render(scene, camera)
    }
    tick()

    return () => {
      alive = false
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
      unsub()
      renderer.dispose()
      geometry.dispose()
      material.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [])

  const bare: React.CSSProperties = {
    fontFamily: 'monospace',
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
    background: 'none',
    border: 'none',
    outline: 'none',
    padding: 0,
    width: 120,
  }

  return (
    <>
      <div ref={mountRef} style={{ position: 'fixed', inset: 0, zIndex: 0 }} />

      <div style={{
        position: 'fixed', bottom: 16, right: 16, zIndex: 100,
        fontFamily: 'monospace', fontSize: 11,
        color: 'rgba(255,255,255,0.45)',
        display: 'flex', flexDirection: 'column', gap: 4,
        alignItems: 'flex-end',
      }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="number" step="0.001" value={debugLat}
            onChange={e => setDebugLat(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleDebugFetch()}
            placeholder="lat"
            style={bare}
          />
          <input
            type="number" step="0.001" value={debugLng}
            onChange={e => setDebugLng(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleDebugFetch()}
            placeholder="lng"
            style={bare}
          />
        </div>
        <button
          onClick={handleDebugFetch} disabled={fetching}
          style={{ ...bare, width: 'auto', cursor: fetching ? 'default' : 'pointer', opacity: fetching ? 0.3 : 1 }}
        >
          {fetching ? 'fetching…' : 'fetch ↵'}
        </button>
      </div>
    </>
  )
}

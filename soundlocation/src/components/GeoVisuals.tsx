import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { geoState } from '../geo/geoState'

// ── Constants ─────────────────────────────────────────────────────────────────

const GRID_SIZE  = 30          // 30×30 = 900 elevation samples
const GRID_SPAN  = 0.10        // ±0.10° around centre (≈ ±11 km at mid-latitudes)
const V_SCALE    = 1.2         // scene units — peaks sit 1.2 units above valleys
const REFETCH_M  = 5000        // only re-fetch after moving 5 km
const COOLDOWN_S = 90          // minimum seconds between any two fetch attempts

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

    // ── Geometry: 29×29 segments → 30×30 vertices ─────────────────────────
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

    // ── Elevation grid fetch ──────────────────────────────────────────────
    const TOTAL    = GRID_SIZE * GRID_SIZE
    const targetZ  = new Float32Array(TOTAL)   // desired heights; lerped toward in tick
    const LERP_SPD = 0.028                     // per-frame factor — ~1.5 s to settle
    const positions = geometry.attributes.position as THREE.BufferAttribute

    let gridCenterLat: number | null = null
    let gridCenterLng: number | null = null
    let fetchInFlight = false
    let lastFetchEnd   = 0

    async function fetchAndApplyGrid(lat: number, lng: number) {
      const now = Date.now()
      if (fetchInFlight || !alive) return
      if (now - lastFetchEnd < COOLDOWN_S * 1000) return
      fetchInFlight = true
      setFetching(true)
      gridCenterLat = lat
      gridCenterLng = lng

      // Vertex order matches PlaneGeometry:
      //   row=0 → top (+Y, northernmost lat)  col=0 → left (-X, westernmost lng)
      const lats: string[] = []
      const lngs: string[] = []
      for (let row = 0; row < GRID_SIZE; row++) {
        for (let col = 0; col < GRID_SIZE; col++) {
          lats.push((lat + (0.5 - row / SEGS) * 2 * GRID_SPAN).toFixed(6))
          lngs.push((lng + (col / SEGS - 0.5) * 2 * GRID_SPAN).toFixed(6))
        }
      }

      try {
        // One chunk every 13 s → full 30×30 grid builds over ~2 minutes.
        // Each chunk is applied immediately so the terrain grows in real-time.
        const CHUNK      = 100
        const CHUNK_DELAY = 13_000 // ms
        const total       = lats.length
        const allElevs    = new Array<number>(total).fill(0)
        const loaded      = new Array<boolean>(total).fill(false)
        let   gMin        = Infinity
        let   gMax        = -Infinity

        function applyLoaded() {
          // Write into targetZ — the tick loop will lerp positions toward these
          const range = Math.max(gMax - gMin, 1)
          for (let k = 0; k < total; k++) {
            if (loaded[k]) {
              targetZ[k] = ((allElevs[k] - gMin) / range) * V_SCALE
            }
          }
        }

        for (let i = 0; i < total; i += CHUNK) {
          if (!alive) { fetchInFlight = false; return }

          const bLats = lats.slice(i, i + CHUNK).join(',')
          const bLngs = lngs.slice(i, i + CHUNK).join(',')
          try {
            const r = await fetch(`/api/elevation?latitude=${bLats}&longitude=${bLngs}`)
            if (r.ok) {
              const d = (await r.json()) as { elevation: number[] }
              d.elevation.forEach((e, j) => {
                allElevs[i + j] = e
                loaded[i + j]   = true
                if (e < gMin) gMin = e
                if (e > gMax) gMax = e
              })
              applyLoaded()  // update mesh immediately with what we have so far
            }
          } catch { /* skip chunk */ }

          if (i + CHUNK < total) {
            await new Promise<void>(resolve => setTimeout(resolve, CHUNK_DELAY))
          }
        }
      } catch { /* keep current geometry on network failure */ }
      fetchInFlight = false
      lastFetchEnd  = Date.now()
      setFetching(false)
    }

    fetchRef.current = (lat, lng) => {
      lastFetchEnd = 0 // bypass cooldown for manual debug fetches
      void fetchAndApplyGrid(lat, lng)
    }

    // ── Geo state subscription ────────────────────────────────────────────
    const unsub = geoState.subscribe((state) => {
      uniforms.u_temperature.value = state.temperature
      uniforms.u_altitude.value    = state.altitude
      uniforms.u_windSpeed.value   = state.windSpeed
      uniforms.u_cloudCover.value  = state.cloudCover
      uniforms.u_humidity.value    = state.humidity

      if (state.lat === 0 && state.lng === 0) return

      // Keep debug inputs in sync with real GPS position
      setDebugLat(prev => prev === '' ? state.lat.toFixed(5) : prev)
      setDebugLng(prev => prev === '' ? state.lng.toFixed(5) : prev)

      const needsGrid =
        gridCenterLat === null ||
        haversineM(gridCenterLat, gridCenterLng!, state.lat, state.lng) > REFETCH_M
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
    const clock = new THREE.Clock()
    const ROTATION_PERIOD = 120  // seconds per full Z revolution
    const SNAP_THRESHOLD  = 5e-4 // stop lerping below this distance

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      const t = clock.getElapsedTime()
      uniforms.u_time.value = t
      mesh.rotation.z = (t / ROTATION_PERIOD) * Math.PI * 2

      // Lerp each vertex toward its target height
      let dirty = false
      for (let i = 0; i < TOTAL; i++) {
        const cur = positions.getZ(i)
        const tgt = targetZ[i]
        const diff = tgt - cur
        if (Math.abs(diff) > SNAP_THRESHOLD) {
          positions.setZ(i, cur + diff * LERP_SPD)
          dirty = true
        } else if (cur !== tgt) {
          positions.setZ(i, tgt)
          dirty = true
        }
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

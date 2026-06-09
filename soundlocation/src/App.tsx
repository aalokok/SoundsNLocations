import { useEffect, useState } from 'react'
import { geoState, type GeoState } from './geo/geoState'

function App() {
  const [state, setState] = useState<GeoState>(geoState.getState())

  useEffect(() => {
    geoState.start()
    const unsub = geoState.subscribe(setState)
    return () => {
      unsub()
      geoState.stop()
    }
  }, [])

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '100svh',
      padding: '40px 24px',
    }}>
      <pre style={{
        background: '#111118',
        color: '#e2e8f0',
        fontFamily: '"Courier New", Courier, monospace',
        fontSize: '14px',
        lineHeight: '1.8',
        padding: '32px 40px',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.08)',
        userSelect: 'text',
        margin: 0,
      }}>
        {JSON.stringify(state, null, 2)}
      </pre>
    </div>
  )
}

export default App

import { useEffect } from 'react'
import { geoState } from './geo/geoState'
import GeoVisuals from './components/GeoVisuals'
import GeoDebug from './geo/GeoDebug'

function App() {
  useEffect(() => {
    geoState.start()
    return () => geoState.stop()
  }, [])

  return (
    <>
      <GeoVisuals />
      <GeoDebug />
    </>
  )
}

export default App

export const config = { runtime: 'edge' }

export default async function handler(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const latitude  = searchParams.get('latitude')
  const longitude = searchParams.get('longitude')

  if (!latitude || !longitude) {
    return new Response(JSON.stringify({ error: 'Missing latitude or longitude' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const upstream =
    `https://api.open-meteo.com/v1/elevation` +
    `?latitude=${latitude}&longitude=${longitude}`

  const res  = await fetch(upstream)
  const body = await res.text()

  return new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, s-maxage=3600',
    },
  })
}

export const rooms = {
  living:  { x: -2.8, z: 1.9, w: 5.3, d: 5.0, floor: '#b9856c', wall: '#dbb29e' },
  kitchen: { x: 2.2, z: 1.9, w: 4.4, d: 5.0, floor: '#889a9e', wall: '#c6d1cb' },
  study:   { x: -2.8, z: -3.1, w: 5.3, d: 4.6, floor: '#a295b0', wall: '#d3c5df' },
  balcony: { x: 2.2, z: -2.0, w: 4.4, d: 2.4, floor: '#9f9a85', wall: '#d1c8a6', open: true },
  garden:  { x: 6.9, z: -0.4, w: 4.6, d: 9.6, floor: '#759783', wall: '#9eb5a1', open: true },
}

export function homeSceneState(data, now = Date.now()) {
  const status = data?.status
  if (!status || !Number.isSafeInteger(status.at) || status.at > now || now - status.at >= 3_600_000) return null
  const { place, doing } = status
  if (typeof place !== 'string' || typeof doing !== 'string' || (place !== 'outside' && !Object.hasOwn(rooms, place))) return null
  const places = data.places ?? {}
  const activities = data.activities ?? {}
  if (!Object.hasOwn(places, place) || !Object.hasOwn(activities, doing) ||
    typeof places[place] !== 'string' || typeof activities[doing] !== 'string') return null
  return { place, label: `${places[place]} · ${activities[doing]}`, marker: place === 'outside' ? null : place }
}

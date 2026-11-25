// 她的家：只做判断、不碰 DOM 和 WebGL 的部分。scene.js 只负责把这里算好的结果贴到页面上，
// 所以发布、换房间、收回、过期、在外面、读取失败、WebGL 不可用、窄窗口都能在 Node 里用假时钟验收。
// 这个文件由 dsh-qqbot-services/index.js 的 sceneAssets 白名单直接发给浏览器，不能 import 白名单外的文件。

export const rooms = {
  living:  { x: -2.8, z: 1.9, w: 5.3, d: 5.0, floor: '#b9856c', wall: '#dbb29e' },
  kitchen: { x: 2.2, z: 1.9, w: 4.4, d: 5.0, floor: '#889a9e', wall: '#c6d1cb' },
  study:   { x: -2.8, z: -3.1, w: 5.3, d: 4.6, floor: '#a295b0', wall: '#d3c5df' },
  balcony: { x: 2.2, z: -2.0, w: 4.4, d: 2.4, floor: '#9f9a85', wall: '#d1c8a6', open: true },
  garden:  { x: 6.9, z: -0.4, w: 4.6, d: 9.6, floor: '#759783', wall: '#9eb5a1', open: true },
}

// 与 dsh-linmengyao-memory/home-status.js 的公开时长一致（测试核对两边相等）
export const homeStatusLifetime = 3_600_000

const poses = {
  resting: 'sit', reading: 'book', cooking: 'work', tidying: 'work', zoningOut: 'idle', walking: 'walk',
}

export function poseForActivity(activity) {
  return typeof activity === 'string' && Object.hasOwn(poses, activity) ? poses[activity] : null
}

export function homeSceneState(data, now = Date.now()) {
  const status = data?.status
  if (!status || !Number.isSafeInteger(status.at) || status.at > now || now - status.at >= homeStatusLifetime) return null
  const { place, doing } = status
  if (typeof place !== 'string' || typeof doing !== 'string' || (place !== 'outside' && !Object.hasOwn(rooms, place))) return null
  const places = data.places ?? {}
  const activities = data.activities ?? {}
  if (!Object.hasOwn(places, place) || !Object.hasOwn(activities, doing) ||
    typeof places[place] !== 'string' || typeof activities[doing] !== 'string') return null
  return { place, label: `${places[place]} · ${activities[doing]}`, marker: place === 'outside' ? null : place }
}

/**
 * 页面这一刻该显示什么。只看她当前公开的那一条：标记画在她公开的房间，动作由公开活动决定，
 * 没有公开、过期、在外面或读不到时不画人，不猜位置，也不自己在房间之间走动。
 * @param {unknown} data `/api/qqbot-services/home` 的响应；读取失败时传 null 并给 unavailable
 * @param {number} now
 * @param {boolean} [unavailable] 这次没读到（网络错、503、坏响应）
 */
export function homeView(data, now, unavailable = false) {
  // 响应不是对象（被截断、代理改写）算读不到，不算「没有公开」
  if (data === null || typeof data !== 'object' || Array.isArray(data)) unavailable = true
  const snapshot = unavailable ? null : homeSceneState(data, now)
  const room = snapshot?.marker ? rooms[snapshot.marker] : null
  return {
    text: snapshot?.label ?? (unavailable ? '暂时读不到公开状态。' : '她现在没有公开状态。'),
    marker: room ? snapshot.marker : null,
    position: room ? { x: room.x, z: room.z } : null,
    pose: room ? poseForActivity(data.status.doing) : null,
    // 到点自己撤下：距离过期还有多久（毫秒），没有公开就是 null
    expiresIn: snapshot ? Math.max(0, data.status.at + homeStatusLifetime - now) : null,
  }
}

// ---- 渲染器与窗口尺寸 ----

/** 建 WebGL 渲染器；设备不支持（three 会抛错）就返回 null，页面改走文字回退。 */
export function chooseRenderer(create) {
  try { return create() ?? null }
  catch { return null }
}

/** WebGL 不可用时只留状态文字和回退说明，视角按钮没有用处就藏起来。 */
export function sceneChrome(hasRenderer) {
  return { fallbackHidden: hasRenderer, navHidden: !hasRenderer }
}

export const defaultView = Object.freeze({ angle: Math.PI * 0.28, elevation: 0.69, zoom: 1 })
export const sceneCenter = Object.freeze({ x: 1.9, y: 0.2, z: -0.1 })
const cameraRadius = 24

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
export const clampZoom = zoom => clamp(zoom, 0.72, 1.8)
export const clampElevation = elevation => clamp(elevation, 0.32, 1.3)

/** 容器尺寸为 0（隐藏的标签页、折叠的 iframe）时按 1 像素算，避免除零；像素比最多 2。 */
export function viewportSize(clientWidth, clientHeight, devicePixelRatio = 1) {
  const size = value => (Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1)
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  return { width: size(clientWidth), height: size(clientHeight), pixelRatio: Math.min(ratio, 2) }
}

/**
 * 正交相机的视野。窄窗口按宽度留够 22 个单位（整座房子的对角线约 18.8），
 * 宽窗口按高度留 14.3 个单位，所以默认视角下任何比例的窗口都能看到整座房子。
 */
export function cameraFrustum(width, height, zoom = 1) {
  const aspect = width / height
  const span = Math.max(14.3, 22 / aspect) / zoom
  return { left: -span * aspect / 2, right: span * aspect / 2, top: span / 2, bottom: -span / 2 }
}

export function cameraPosition(angle, elevation) {
  return {
    x: sceneCenter.x + Math.cos(angle) * cameraRadius * Math.cos(elevation),
    y: sceneCenter.y + Math.sin(elevation) * cameraRadius,
    z: sceneCenter.z + Math.sin(angle) * cameraRadius * Math.cos(elevation),
  }
}

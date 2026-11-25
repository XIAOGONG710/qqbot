import * as THREE from './three.module.min.js'
import { box, furniture, makeLabel } from './furniture.js'
import {
  cameraFrustum, cameraPosition, chooseRenderer, clampElevation, clampZoom, defaultView, homeView, rooms, sceneCenter, sceneChrome,
  viewportSize,
} from './state.js'
import { createHouseAvatar } from './avatar.js'

const container = document.getElementById('scene')
const statusLine = document.getElementById('status')
const fallback = document.getElementById('fallback')
// 判断都在 state.js（chooseRenderer、homeView、cameraFrustum…），这里只把结果贴到页面上
const renderer = chooseRenderer(() => new THREE.WebGLRenderer({ antialias: true, alpha: true }))
const chrome = sceneChrome(Boolean(renderer))
fallback.hidden = chrome.fallbackHidden
document.querySelector('nav').hidden = chrome.navHidden

const scene = new THREE.Scene()
const house = new THREE.Group()
scene.add(house)
scene.add(new THREE.HemisphereLight(0xe9efff, 0x71554b, 2.1))
const key = new THREE.DirectionalLight(0xffecc8, 1.65)
key.position.set(-5, 14, 8)
scene.add(key)

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
let { angle, elevation, zoom } = defaultView
const center = new THREE.Vector3(sceneCenter.x, sceneCenter.y, sceneCenter.z)
let width = 1
let height = 1
let labelsBuilt = false

function render() {
  if (!renderer) return
  Object.assign(camera, cameraFrustum(width, height, zoom))
  camera.updateProjectionMatrix()
  const { x, y, z } = cameraPosition(angle, elevation)
  camera.position.set(x, y, z)
  camera.lookAt(center)
  renderer.render(scene, camera)
}

const matte = color => new THREE.MeshLambertMaterial({ color })
const timber = matte('#785a4d')
const foliage = matte('#4c815f')
const marker = new THREE.Group()
const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.43, 32), new THREE.MeshBasicMaterial({ color: 0xffedb3, side: THREE.DoubleSide }))
ring.rotation.x = -Math.PI / 2
ring.position.y = 0.05
const avatar = createHouseAvatar()
avatar.root.rotation.y = Math.PI / 4
marker.add(ring, avatar.root)
marker.visible = false
house.add(marker)

function buildHouse() {
  house.add(box(15.4, 0.31, 10.8, matte('#484b61'), 1.9, -0.28, -0.45))
  const tiles = matte('#b9ab97')
  for (let i = 0; i < 6; i++) house.add(box(0.65, 0.055, 0.41, tiles, 4.61, -0.11, -2.1 + i * 0.54))
  for (const [id, room] of Object.entries(rooms)) {
    const { x, z, w, d, floor, wall, open } = room
    const block = new THREE.Group()
    block.position.set(x, 0, z)
    block.add(box(w, 0.15, d, matte(floor), 0, -0.08, 0))
    const wallMaterial = matte(wall)
    if (!open) {
      block.add(box(w, 1.27, 0.12, wallMaterial, 0, 0.63, -d / 2))
      block.add(box(0.12, 0.83, d, wallMaterial, -w / 2, 0.42, 0))
    } else if (id === 'balcony') {
      block.add(box(w, 0.38, 0.12, wallMaterial, 0, 0.19, -d / 2))
      block.add(box(0.12, 0.38, d, wallMaterial, w / 2, 0.19, 0))
    }
    block.add(furniture(id))
    if (id === 'garden' || id === 'balcony') {
      const spots = id === 'garden' ? [[-1.35, -2.5], [1.1, -1.2], [1.2, 2.65]] : [[1.15, -0.5], [-1.25, -0.42]]
      for (const [px, pz] of spots) {
        block.add(box(0.16, 0.58, 0.16, timber, px, 0.29, pz))
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.51, 1), foliage)
        crown.position.set(px, 0.89, pz)
        block.add(crown)
      }
    }
    house.add(block)
  }
}

let animation
let expiration
function show(data, unavailable = false) {
  const view = homeView(data, Date.now(), unavailable)
  statusLine.textContent = view.text
  marker.visible = Boolean(view.position)
  if (view.position) marker.position.set(view.position.x, 0, view.position.z)
  cancelAnimationFrame(animation)
  clearTimeout(expiration)
  // 到点重新判断一次：计时器提前触发也只会再排一次，不会把过期的状态留在页面上
  if (view.expiresIn !== null) expiration = setTimeout(() => show(data), view.expiresIn)
  const { pose } = view
  if (renderer && pose) {
    const animate = time => {
      avatar.frame(pose, time / 1000)
      render()
      animation = requestAnimationFrame(animate)
    }
    animation = requestAnimationFrame(animate)
  }
  render()
}

let activeRequest
let pollTimer
let closed = false
async function refresh() {
  if (closed) return
  const controller = new AbortController()
  activeRequest = controller
  try {
    const response = await fetch('/api/qqbot-services/home', {
      cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    })
    if (!response.ok) throw Error()
    const data = await response.json()
    if (closed) return
    if (renderer && !labelsBuilt && data?.places) {
      for (const [id, room] of Object.entries(rooms)) {
        if (!Object.hasOwn(data.places, id) || typeof data.places[id] !== 'string') continue
        const label = makeLabel(data.places[id], '#edf4ff', room.w)
        label.position.set(room.x, 0.65, room.z + room.d / 2 - 0.25)
        house.add(label)
      }
      labelsBuilt = true
    }
    show(data)
  } catch {
    if (!closed) show(null, true)
  }
  finally { if (!closed) pollTimer = setTimeout(refresh, 5000) }
}

if (renderer) {
  renderer.domElement.setAttribute('aria-hidden', 'true')
  container.append(renderer.domElement)
  buildHouse()
  const fit = () => {
    const size = viewportSize(container.clientWidth, container.clientHeight, devicePixelRatio)
    width = size.width
    height = size.height
    renderer.setPixelRatio(size.pixelRatio)
    renderer.setSize(width, height)
    render()
  }
  const resize = new ResizeObserver(fit)
  resize.observe(container)
  fit()
  let drag
  container.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return
    drag = { x: event.clientX, y: event.clientY }
    container.setPointerCapture(event.pointerId)
  })
  container.addEventListener('pointermove', event => {
    if (!drag || !event.isPrimary) return
    angle -= (event.clientX - drag.x) * 0.009
    elevation = clampElevation(elevation + (event.clientY - drag.y) * 0.007)
    drag = { x: event.clientX, y: event.clientY }
    render()
  })
  container.addEventListener('lostpointercapture', () => { drag = undefined })
  const adjustZoom = scale => { zoom = clampZoom(zoom * scale); render() }
  container.addEventListener('wheel', event => { event.preventDefault(); adjustZoom(Math.exp(-event.deltaY * 0.001)) }, { passive: false })
  document.getElementById('rotate').onclick = () => { angle += Math.PI / 4; render() }
  document.getElementById('zoom-in').onclick = () => adjustZoom(1.18)
  document.getElementById('zoom-out').onclick = () => adjustZoom(1 / 1.18)
  document.getElementById('reset').onclick = () => { ({ angle, elevation, zoom } = defaultView); render() }
  addEventListener('pagehide', () => { resize.disconnect(); renderer.dispose() }, { once: true })
}

addEventListener('pagehide', () => {
  closed = true
  activeRequest?.abort()
  clearTimeout(expiration)
  clearTimeout(pollTimer)
  cancelAnimationFrame(animation)
}, { once: true })
void refresh()

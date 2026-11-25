import * as THREE from './three.module.min.js'

// 活动到动作的对应放在 state.js，Node 里不用加载 three 也能测
export { poseForActivity } from './state.js'

export function createHouseAvatar() {
  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)
  const coat = new THREE.MeshLambertMaterial({ color: 0xa487c7 })
  const pants = new THREE.MeshLambertMaterial({ color: 0x4b4566 })
  const skin = new THREE.MeshLambertMaterial({ color: 0xf0be9c })
  const hair = new THREE.MeshLambertMaterial({ color: 0x42334d })
  const bookMaterial = new THREE.MeshLambertMaterial({ color: 0x498f84 })
  const add = (parent, geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }
  add(body, new THREE.CapsuleGeometry(0.215, 0.29, 4, 8), coat, 0, 1.01, 0)
  add(body, new THREE.SphereGeometry(0.19, 10, 8), skin, 0, 1.5, 0.025)
  add(body, new THREE.SphereGeometry(0.199, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.63), hair, 0, 1.53, 0.011)
  const arms = [], legs = []
  for (const side of [-1, 1]) {
    const arm = new THREE.Group()
    const leg = new THREE.Group()
    arm.position.set(side * 0.22, 1.2, 0)
    leg.position.set(side * 0.09, 0.71, 0)
    add(arm, new THREE.CapsuleGeometry(0.055, 0.26, 4, 7), coat, 0, -0.15, 0)
    add(arm, new THREE.SphereGeometry(0.061, 6, 5), skin, 0, -0.32, 0)
    add(leg, new THREE.CapsuleGeometry(0.07, 0.45, 4, 7), pants, 0, -0.27, 0)
    add(leg, new THREE.BoxGeometry(0.15, 0.09, 0.23), pants, 0, -0.59, 0.055)
    body.add(arm, leg)
    arms.push(arm)
    legs.push(leg)
  }
  const book = add(body, new THREE.BoxGeometry(0.36, 0.04, 0.22), bookMaterial, 0, 1.05, 0.31)
  book.rotation.x = 0.4

  function frame(pose, time) {
    const cadence = Math.sin(time * (pose === 'walk' ? 6 : 2.2))
    body.position.y = pose === 'sit' ? -0.42 : pose === 'walk' ? Math.abs(cadence) * 0.052 : Math.sin(time * 1.5) * 0.012
    book.visible = pose === 'book'
    arms.forEach((arm, i) => {
      const phase = i === 0 ? 1 : -1
      arm.rotation.x = pose === 'book' ? -1.05 : pose === 'work' ? -0.63 + cadence * phase * 0.18
        : pose === 'walk' ? -cadence * phase * 0.38 : 0
      arm.rotation.z = phase * -0.09
    })
    legs.forEach((leg, i) => {
      leg.rotation.x = pose === 'sit' ? -1.28 : pose === 'walk' ? cadence * (i === 0 ? 1 : -1) * 0.43 : 0
    })
  }
  return { root, frame }
}

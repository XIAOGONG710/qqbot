// Furniture shapes, box geometry and room labels adapted from Lingxi's MIT-licensed space-page.js.
import * as THREE from './three.module.min.js'

const MATERIAL = {
  wood: new THREE.MeshLambertMaterial({ color: '#b98365' }),
  dark: new THREE.MeshLambertMaterial({ color: '#634662' }),
  cloth: new THREE.MeshLambertMaterial({ color: '#916c98' }),
  white: new THREE.MeshLambertMaterial({ color: '#e6d9cb' }),
  metal: new THREE.MeshLambertMaterial({ color: '#7998a4' }),
  stone: new THREE.MeshLambertMaterial({ color: '#526a77' }),
}

export function box(w, h, d, mat, x, y, z){
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

export function makeLabel(text, color, maxW){
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(7,9,13,0.8)'; g.fillRect(0, 0, 256, 64);
  g.strokeStyle = 'rgba(140,170,220,0.32)'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 253, 61);
  g.fillStyle = color; g.font = '600 30px system-ui, "Microsoft YaHei", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  const w = Math.max(1.1, Math.min(2.2, maxW * 0.62));
  s.scale.set(w, w / 4, 1);
  return s;
}

export function furniture(id) {
  const g = new THREE.Group();
  switch (id) {
    case 'living':
      g.add(box(2.45, 0.025, 1.75, MATERIAL.white, 0, 0.015, -0.1));
      g.add(box(3.1, 0.52, 1.0, MATERIAL.cloth, 0, 0.26, -1.9));
      g.add(box(3.1, 0.6, 0.26, MATERIAL.cloth, 0, 0.7, -2.4));
      g.add(box(1.25, 0.36, 0.7, MATERIAL.wood, 0, 0.18, -0.4));
      g.add(box(0.7, 0.34, 0.5, MATERIAL.white, 1.95, 0.17, -0.5));
      break;
    case 'kitchen':
      g.add(box(2.7, 0.88, 0.62, MATERIAL.stone, 0, 0.44, -1.9));
      g.add(box(0.72, 1.75, 0.72, MATERIAL.metal, -1.7, 0.87, -1.95));
      g.add(box(2.7, 0.06, 0.62, MATERIAL.white, 0, 0.9, -1.9));      // 台面
      break;
    case 'study':
      g.add(box(1.9, 0.74, 0.78, MATERIAL.wood, 0, 0.37, -1.5));
      g.add(box(1.1, 1.75, 0.09, MATERIAL.dark, 1.8, 0.88, -2.03));
      for (const level of [0.25, 0.7, 1.15, 1.63]) g.add(box(1.1, 0.055, 0.31, MATERIAL.dark, 1.8, level, -1.88));
      for (const [index, material] of [MATERIAL.cloth, MATERIAL.white, MATERIAL.wood, MATERIAL.stone].entries()) {
        const height = 0.23 + (index % 2) * 0.09;
        g.add(box(0.14, height, 0.20, material, 1.43 + 0.18 * index, 1.18 + height / 2, -1.84));
      }
      g.add(box(0.5, 0.45, 0.5, MATERIAL.cloth, 0, 0.22, -0.75));     // 椅子
      break;
    case 'balcony':
      g.add(box(1.5, 0.4, 0.6, MATERIAL.wood, 0, 0.2, -0.4));
      break;
    case 'garden':
      g.add(box(1.4, 0.44, 0.55, MATERIAL.wood, 0, 0.22, 1.1));
      break;
  }
  return g;
}

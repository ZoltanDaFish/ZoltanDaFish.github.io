// Drag-to-rotate wireframe of a model's real polygon edges (quads, not triangles).
// models/*.bin: uint32 vertex count, uint32 edge count, int16 xyz per vertex
// (normalised to -1..1), padding to 4 bytes, then uint16 vertex pairs per edge.
// 'three' resolves through the page's import map
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

for (const canvas of document.querySelectorAll('canvas[data-wire]')) {
  const buf = await (await fetch(canvas.dataset.wire)).arrayBuffer();
  const [nv, ne] = new Uint32Array(buf, 0, 2);
  const q = new Int16Array(buf, 8, nv * 3);
  const edges = new Uint16Array(buf, 8 + Math.ceil(nv * 6 / 4) * 4, ne * 2);

  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = q[i] / 32767;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(edges, 1));

  const scene = new THREE.Scene();
  scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.45 })));

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(2.0, 1.1, 2.5);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

  // rotate only: no zoom or pan, so scrolling the page still scrolls the page
  const controls = new OrbitControls(camera, canvas);
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.enableDamping = true;

  function size() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  // draw only while something is moving
  let frame = 0;
  function render() {
    frame = 0;
    if (controls.update()) frame = requestAnimationFrame(render);
    renderer.render(scene, camera);
  }
  controls.addEventListener('change', () => { if (!frame) frame = requestAnimationFrame(render); });
  new ResizeObserver(() => { size(); render(); }).observe(canvas);
}

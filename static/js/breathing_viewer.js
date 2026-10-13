// Interactive breathing-airway viewer.
// Loads static/breathing/manifest.json + <case>.bin (see scripts/build_breathing_viewer.py)
// and plays the SeqX2Y respiratory motion on the airway mesh, with the planned scope
// path carried along by the tissue. Dots under the canvas switch between airways.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

const ROOT = 'static/breathing/';
const TISSUE = new THREE.Color('#e9a9a3');
const PATH_COLOR = '#0e7490';

// ColorBrewer RdPu: pale where the airway barely moves, deep purple where it moves most
const RDPU = ['#fff7f3', '#fde0dd', '#fcc5c0', '#fa9fb5', '#f768a1', '#dd3497', '#ae017e', '#7a0177', '#49006a']
  .map(c => new THREE.Color(c));
function rdpu(t, out) {
  const x = Math.min(Math.max(t, 0), 1) * (RDPU.length - 1);
  const i = Math.min(Math.floor(x), RDPU.length - 2);
  return out.copy(RDPU[i]).lerp(RDPU[i + 1], x - i);
}

function parseCase(info, buf) {
  const V = info.vertices, F = info.faces, P = info.path_points;
  const C = info.cycles, PH = info.phases;
  let off = 0;
  const take = (Type, n) => { const a = new Type(buf, off, n); off += n * Type.BYTES_PER_ELEMENT; return a; };
  const qpos = take(Int16Array, V * 3);
  const faces = take(Uint16Array, F * 3);
  const qpath = take(Int16Array, P * 3);
  const pathVid = take(Uint16Array, P);
  const qdisp = take(Int8Array, C * PH * V * 3);
  const rest = new Float32Array(V * 3);
  for (let k = 0; k < V * 3; k++) rest[k] = qpos[k] * info.pos_scale;
  const pathRest = new Float32Array(P * 3);
  for (let k = 0; k < P * 3; k++) pathRest[k] = qpath[k] * info.pos_scale;
  return { info, rest, faces, pathRest, pathVid, qdisp };
}

class BreathingViewer {
  constructor(root) {
    this.root = root;
    this.canvasWrap = root.querySelector('.bv-canvas');
    this.ui = {
      play: root.querySelector('[data-bv=play]'),
      time: root.querySelector('[data-bv=time]'),
      timeLabel: root.querySelector('[data-bv=time-label]'),
      magnify: root.querySelector('[data-bv=magnify]'),
      magnifyLabel: root.querySelector('[data-bv=magnify-label]'),
      color: root.querySelector('[data-bv=color]'),
      path: root.querySelector('[data-bv=path]'),
      reset: root.querySelector('[data-bv=reset]'),
      dots: root.querySelector('.bv-dots'),
      prev: root.querySelector('[data-bv=prev]'),
      next: root.querySelector('[data-bv=next]'),
      caption: root.querySelector('[data-bv=caption]'),
      legendMax: root.querySelector('[data-bv=legend-max]'),
      status: root.querySelector('.bv-status'),
    };
    this.cache = new Map();
    this.playing = true;
    this.visible = true;
    this.frame = 0;
    this.pathT = 0;
    this.magnify = parseFloat(this.ui.magnify.value);
    this.tmpColor = new THREE.Color();
  }

  async init() {
    this.manifest = await (await fetch(ROOT + 'manifest.json')).json();
    // shared color scale so airways are comparable; most tissue moves well under this
    this.vmax = 6;
    this.ui.legendMax.textContent = `≥ ${this.vmax} mm`;
    this.setupThree();
    this.setupUI();
    await this.show(0);
    this.ui.status.hidden = true;
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  setupThree() {
    const w = this.canvasWrap.clientWidth, h = this.canvasWrap.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.canvasWrap.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, w / h, 1, 5000);
    this.camera.up.set(0, 0, 1);  // CT z (cranial) is up
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x886666, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(-1, -2, 2);
    this.camera.add(key);
    this.scene.add(this.camera);

    this.geometry = new THREE.BufferGeometry();
    // back faces first, then front faces: cheap order-independent-looking transparency
    const common = { vertexColors: true, transparent: true, opacity: 0.62, depthWrite: false, roughness: 0.55, metalness: 0.0 };
    this.back = new THREE.Mesh(this.geometry, new THREE.MeshStandardMaterial({ ...common, side: THREE.BackSide }));
    this.front = new THREE.Mesh(this.geometry, new THREE.MeshStandardMaterial({ ...common, side: THREE.FrontSide }));
    this.back.renderOrder = 1;
    this.front.renderOrder = 3;
    this.scene.add(this.back, this.front);

    this.lineGeom = new LineGeometry();
    this.lineMat = new LineMaterial({ color: PATH_COLOR, linewidth: 3, worldUnits: false, depthTest: false, transparent: true, opacity: 0.95 });
    this.lineMat.resolution.set(w, h);
    this.line = new Line2(this.lineGeom, this.lineMat);
    this.line.renderOrder = 2;
    this.scene.add(this.line);

    this.tip = new THREE.Mesh(new THREE.SphereGeometry(3.2, 20, 14),
      new THREE.MeshBasicMaterial({ color: '#f8fafc', depthTest: false }));
    const ring = new THREE.Mesh(new THREE.SphereGeometry(4.4, 20, 14),
      new THREE.MeshBasicMaterial({ color: PATH_COLOR, depthTest: false }));
    ring.renderOrder = 4;
    this.tip.renderOrder = 5;
    this.tipGroup = new THREE.Group();
    this.tipGroup.add(ring, this.tip);
    this.scene.add(this.tipGroup);

    new ResizeObserver(() => this.resize()).observe(this.canvasWrap);
    new IntersectionObserver(es => { this.visible = es[0].isIntersecting; }, { threshold: 0.05 })
      .observe(this.canvasWrap);
  }

  resize() {
    const w = this.canvasWrap.clientWidth, h = this.canvasWrap.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.lineMat.resolution.set(w, h);
  }

  setupUI() {
    this.manifest.cases.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'bv-dot';
      b.type = 'button';
      b.setAttribute('aria-label', `Airway ${i + 1}`);
      b.addEventListener('click', () => this.show(i));
      this.ui.dots.appendChild(b);
    });
    const n = this.manifest.cases.length;
    this.ui.prev.addEventListener('click', () => this.show((this.index - 1 + n) % n));
    this.ui.next.addEventListener('click', () => this.show((this.index + 1) % n));
    this.ui.play.addEventListener('click', () => this.setPlaying(!this.playing));
    this.ui.time.addEventListener('input', () => {
      this.setPlaying(false);
      this.frame = parseInt(this.ui.time.value, 10);
      this.update();
    });
    this.ui.magnify.addEventListener('input', () => {
      this.magnify = parseFloat(this.ui.magnify.value);
      this.ui.magnifyLabel.textContent = `${this.magnify}×`;
      this.update();
    });
    this.ui.color.addEventListener('change', () => this.update());
    this.ui.path.addEventListener('change', () => {
      this.line.visible = this.tipGroup.visible = this.ui.path.checked;
    });
    this.ui.reset.addEventListener('click', () => this.resetView());
    this.root.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft') this.ui.prev.click();
      if (e.key === 'ArrowRight') this.ui.next.click();
    });
  }

  setPlaying(p) {
    this.playing = p;
    this.ui.play.innerHTML = p ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    this.ui.play.setAttribute('aria-label', p ? 'Pause' : 'Play');
  }

  async load(i) {
    if (!this.cache.has(i)) {
      const info = this.manifest.cases[i];
      const buf = await (await fetch(`${ROOT}${info.case}.bin`)).arrayBuffer();
      this.cache.set(i, parseCase(info, buf));
    }
    return this.cache.get(i);
  }

  async show(i) {
    this.index = i;
    [...this.ui.dots.children].forEach((d, k) => d.classList.toggle('is-active', k === i));
    const data = await this.load(i);
    if (this.index !== i) return;  // a later click won
    this.data = data;
    const { info } = data;
    const V = info.vertices;
    this.pos = new Float32Array(V * 3);
    this.col = new Float32Array(V * 3);
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(data.faces, 1));
    this.back.geometry = this.geometry;
    this.front.geometry = this.geometry;
    this.pathPos = new Float32Array(info.path_points * 3);

    this.cycleStart = [];
    let acc = 0;
    for (const n of info.cycle_frames) { this.cycleStart.push(acc); acc += n; }
    this.totalFrames = acc;
    this.ui.time.max = String(acc - 1);
    this.frame = 0;
    this.pathT = 0;

    const ext = info.extent_mm;
    this.ui.caption.textContent =
      `Airway ${i + 1} of ${this.manifest.cases.length} · ${ext[0].toFixed(0)}×${ext[1].toFixed(0)}×${ext[2].toFixed(0)} mm · ` +
      `${info.cycles} breaths, ${(acc / info.fps).toFixed(1)} s · peak motion ${info.disp_p99_mm.toFixed(1)} mm`;
    this.update();
    this.geometry.computeBoundingSphere();
    this.resetView();
  }

  resetView() {
    const bs = this.geometry.boundingSphere;
    const r = bs.radius, c = bs.center;
    const d = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.95;
    this.camera.position.set(c.x, c.y - d, c.z + r * 0.08);  // anterior view, like a coronal CT slice
    this.controls.target.copy(c);
    this.controls.update();
  }

  update() {
    const { info, rest, qdisp, pathRest, pathVid } = this.data;
    const V = info.vertices, PH = info.phases;
    // which cycle / phase pair this frame falls in
    let c = this.cycleStart.length - 1;
    while (c > 0 && this.frame < this.cycleStart[c]) c--;
    const n = info.cycle_frames[c];
    const p = n > 1 ? (this.frame - this.cycleStart[c]) * (PH - 1) / (n - 1) : 0;
    const a = Math.min(Math.floor(p), PH - 2), t = p - a;
    const o0 = ((c * PH + a) * V) * 3, o1 = ((c * PH + a + 1) * V) * 3;
    const s = info.disp_scale, m = this.magnify;
    const byMotion = this.ui.color.checked;
    const pos = this.pos, col = this.col, tmp = this.tmpColor;
    for (let v = 0; v < V; v++) {
      const k = v * 3;
      const dx = ((1 - t) * qdisp[o0 + k] + t * qdisp[o1 + k]) * s;
      const dy = ((1 - t) * qdisp[o0 + k + 1] + t * qdisp[o1 + k + 1]) * s;
      const dz = ((1 - t) * qdisp[o0 + k + 2] + t * qdisp[o1 + k + 2]) * s;
      pos[k] = rest[k] + m * dx;
      pos[k + 1] = rest[k + 1] + m * dy;
      pos[k + 2] = rest[k + 2] + m * dz;
      if (byMotion) rdpu(Math.sqrt(dx * dx + dy * dy + dz * dz) / this.vmax, tmp);
      else tmp.copy(TISSUE);
      col[k] = tmp.r; col[k + 1] = tmp.g; col[k + 2] = tmp.b;
    }
    for (let q = 0; q < info.path_points; q++) {
      const k = q * 3, vk = pathVid[q] * 3;
      this.pathPos[k] = pathRest[k] + (pos[vk] - rest[vk]);
      this.pathPos[k + 1] = pathRest[k + 1] + (pos[vk + 1] - rest[vk + 1]);
      this.pathPos[k + 2] = pathRest[k + 2] + (pos[vk + 2] - rest[vk + 2]);
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.lineGeom.setPositions(this.pathPos);

    // scope tip travels the planned path at its real pace
    const u = (this.pathT % 1) * (info.path_points - 1);
    const q0 = Math.floor(u), q1 = Math.min(q0 + 1, info.path_points - 1), w = u - q0;
    this.tipGroup.position.set(
      (1 - w) * this.pathPos[q0 * 3] + w * this.pathPos[q1 * 3],
      (1 - w) * this.pathPos[q0 * 3 + 1] + w * this.pathPos[q1 * 3 + 1],
      (1 - w) * this.pathPos[q0 * 3 + 2] + w * this.pathPos[q1 * 3 + 2]);

    this.ui.time.value = String(this.frame);
    this.ui.timeLabel.textContent = `${(this.frame / info.fps).toFixed(1)} s`;
  }

  tick() {
    const dt = this.clock.getDelta();
    if (!this.visible) return;
    if (this.playing && this.data) {
      const info = this.data.info;
      this.acc = (this.acc || 0) + dt * info.fps;
      const steps = Math.floor(this.acc);
      if (steps > 0) {
        this.acc -= steps;
        this.frame = (this.frame + steps) % this.totalFrames;
        this.pathT += steps / info.traj_frames;
        this.update();
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

const root = document.getElementById('breathing-viewer');
if (root) {
  const viewer = new BreathingViewer(root);
  viewer.init().catch(err => {
    console.error(err);
    root.classList.add('bv-failed');
    root.querySelector('.bv-status').textContent =
      'The 3D viewer needs WebGL and must be served over http(s); showing a pre-rendered animation instead.';
    root.querySelector('.bv-fallback')?.play().catch(() => {});
  });
}

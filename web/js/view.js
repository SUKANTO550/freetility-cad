// FreeTility CAD - 3D viewport (three.js): orthographic camera, touch / mouse
// gestures, view cube, body / sketch / plane display and picking.

import * as THREE from '../lib/three.module.min.js';

const D = 5000;   // camera distance from target

export function createView(host, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'gl';
  host.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2 * D);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(0.4, 0.7, 1);
  camera.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-0.6, -0.3, 0.4);
  camera.add(fill);

  const groups = {
    planes: new THREE.Group(), body: new THREE.Group(), sketches: new THREE.Group(),
    preview: new THREE.Group(), hi: new THREE.Group(), origin: new THREE.Group(),
  };
  for (const g of Object.values(groups)) scene.add(g);

  // view state
  const st = {
    target: new THREE.Vector3(0, 0, 0),
    q: new THREE.Quaternion(),
    scale: 0.25,             // world units per CSS pixel
    w: 1, h: 1,
    lockRotate: false,
    display: 'edges',        // shaded | edges | wire
    anim: null,
  };
  const listeners = [];
  let needs = true;

  // ------------------------------------------------------------ camera
  function applyCamera() {
    const off = new THREE.Vector3(0, 0, D).applyQuaternion(st.q);
    camera.position.copy(st.target).add(off);
    camera.up.set(0, 1, 0).applyQuaternion(st.q);
    camera.lookAt(st.target);
    const hw = st.w * st.scale / 2, hh = st.h * st.scale / 2;
    camera.left = -hw; camera.right = hw; camera.top = hh; camera.bottom = -hh;
    camera.near = 1; camera.far = 2 * D;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  function resize() {
    const r = host.getBoundingClientRect();
    st.w = Math.max(1, r.width); st.h = Math.max(1, r.height);
    renderer.setSize(st.w, st.h, false);
    canvas.style.width = st.w + 'px'; canvas.style.height = st.h + 'px';
    changed();
  }
  new ResizeObserver(resize).observe(host);

  function changed() { needs = true; applyCamera(); for (const f of listeners) f(); }

  // ------------------------------------------------------------ render loop
  function loop(t) {
    requestAnimationFrame(loop);
    if (st.anim) {
      const a = st.anim, k = Math.min(1, (t - a.t0) / a.dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      st.q.slerpQuaternions(a.q0, a.q1, e);
      st.target.lerpVectors(a.p0, a.p1, e);
      st.scale = a.s0 + (a.s1 - a.s0) * e;
      changed();
      if (k >= 1) { st.anim = null; if (a.done) a.done(); }
    }
    if (!needs) return;
    draw();
  }
  function draw() {
    needs = false;
    applyCamera();
    renderer.setViewport(0, 0, st.w, st.h);
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.render(scene, camera);
    renderCube();
  }
  requestAnimationFrame(loop);

  // ------------------------------------------------------------ view cube
  const cubeScene = new THREE.Scene();
  const cubeCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
  const CUBE = 84;
  const faceDefs = [
    ['RIGHT', 'right'], ['LEFT', 'left'], ['TOP', 'top'], ['BOTTOM', 'bottom'], ['FRONT', 'front'], ['BACK', 'back'],
  ];
  const cubeMats = faceDefs.map(([label]) => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#f2f6f7'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#7a8e94'; g.lineWidth = 6; g.strokeRect(3, 3, 122, 122);
    g.fillStyle = '#20393f'; g.font = 'bold 26px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, 64, 66);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshBasicMaterial({ map: tex });
  });
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), cubeMats);
  cubeScene.add(cube);
  const axesHelper = new THREE.AxesHelper(1.5);
  axesHelper.position.set(-1.02, -1.02, -1.02);
  cubeScene.add(axesHelper);

  function cubeRect() { return { x: st.w - CUBE - 10, y: 10, w: CUBE, h: CUBE }; }
  function renderCube() {
    if (opts.noCube) return;
    const r = cubeRect();
    cubeCam.position.set(0, 0, 10).applyQuaternion(st.q);
    cubeCam.up.set(0, 1, 0).applyQuaternion(st.q);
    cubeCam.lookAt(0, 0, 0);
    renderer.setScissorTest(true);
    renderer.setScissor(r.x, st.h - r.y - r.h, r.w, r.h);
    renderer.setViewport(r.x, st.h - r.y - r.h, r.w, r.h);
    renderer.clearDepth();
    renderer.render(cubeScene, cubeCam);
    renderer.setScissorTest(false);
  }
  function cubeHit(x, y) {
    const r = cubeRect();
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((x - r.x) / r.w) * 2 - 1, -((y - r.y) / r.h) * 2 + 1), cubeCam);
    const hit = ray.intersectObject(cube)[0];
    if (!hit) return 'miss';
    return faceDefs[hit.face.materialIndex][1];
  }

  // ------------------------------------------------------------ standard views
  const VIEWS = {
    front: [0, 0, 0], back: [0, 180, 0], right: [0, 90, 0], left: [0, -90, 0],
    top: [-90, 0, 0], bottom: [90, 0, 0], iso: [-30, 45, 0], dimetric: [-20, 30, 0],
  };
  function viewQuat(name) {
    const [rx, ry] = VIEWS[name] || VIEWS.iso;
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(rx * Math.PI / 180, ry * Math.PI / 180, 0, 'YXZ'));
  }
  function animateTo(q1, p1, s1, done) {
    st.anim = { t0: performance.now(), dur: 380, q0: st.q.clone(), q1, p0: st.target.clone(), p1: p1 || st.target.clone(), s0: st.scale, s1: s1 || st.scale, done };
    needs = true;
  }

  // ------------------------------------------------------------ gestures
  const ptrs = new Map();
  let gest = null;   // { kind: 'tool'|'orbit'|'pan'|'pinch', ... }
  let tool = null;   // object with down/move/up/cancel(sx,sy,ev) and tap
  let onTap = null;
  let downAt = null;

  const local = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    const [x, y] = local(ev);
    ptrs.set(ev.pointerId, { x, y, x0: x, y0: y, button: ev.button });
    if (st.anim) st.anim = null;
    if (ptrs.size === 1) {
      downAt = { x, y, t: performance.now(), id: ev.pointerId, moved: false };
      if (cubeHit(x, y)) { gest = { kind: 'cube' }; return; }
      // SolidWorks mouse: middle drag rotates, Ctrl+middle or right drag pans, Shift+middle zooms
      if (ev.button === 1) { ev.preventDefault(); gest = { kind: ev.ctrlKey || st.lockRotate ? 'pan' : ev.shiftKey ? 'zoom' : 'orbit' }; if (downAt) downAt.moved = true; return; }
      if (ev.button === 2) { gest = { kind: 'pan' }; return; }
      if (tool && tool.down && tool.down(x, y, ev)) { gest = { kind: 'tool' }; return; }
      gest = { kind: st.lockRotate ? 'pan' : 'orbit' };
    } else if (ptrs.size === 2) {
      if (gest && gest.kind === 'tool' && tool && tool.cancel) tool.cancel();
      downAt = null;
      const [a, b] = [...ptrs.values()];
      gest = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    }
  });

  canvas.addEventListener('pointermove', (ev) => {
    const p = ptrs.get(ev.pointerId);
    const [x, y] = local(ev);
    if (!p) { if (tool && tool.hover) tool.hover(x, y, ev); return; }
    const dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y;
    if (downAt && Math.hypot(x - downAt.x, y - downAt.y) > 8) downAt.moved = true;
    if (!gest) return;
    if (gest.kind === 'tool') { tool && tool.move && tool.move(x, y, ev); return; }
    if (gest.kind === 'orbit') { if (downAt && !downAt.moved) return; orbit(dx, dy); return; }
    if (gest.kind === 'zoom') { zoomAt(st.w / 2, st.h / 2, Math.exp(dy * 0.006)); return; }
    if (gest.kind === 'pan') { pan(dx, dy); return; }
    if (gest.kind === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      pan(cx - gest.cx, cy - gest.cy);
      if (gest.d > 10 && d > 10) zoomAt(cx, cy, gest.d / d);
      gest.d = d; gest.cx = cx; gest.cy = cy;
    }
  });

  const end = (ev) => {
    const p = ptrs.get(ev.pointerId);
    if (!p) return;
    ptrs.delete(ev.pointerId);
    const [x, y] = local(ev);
    if (gest && gest.kind === 'tool' && ptrs.size === 0) {
      tool && tool.up && tool.up(x, y, ev);
      gest = null;
    } else if (gest && gest.kind === 'cube' && ptrs.size === 0) {
      const f = cubeHit(x, y);
      if (f && f !== 'miss' && downAt && !downAt.moved) setView(f);
      gest = null;
    } else if (ptrs.size === 0) {
      const tap = downAt && !downAt.moved && performance.now() - downAt.t < 600 && ev.type === 'pointerup';
      gest = null;
      if (tap && onTap) onTap(x, y, ev);
    } else if (ptrs.size === 1) {
      // lifted one finger of a pinch: continue as pan, never as a tool stroke
      gest = { kind: 'pan' };
    }
    if (ptrs.size === 0) downAt = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  canvas.addEventListener('auxclick', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [x, y] = local(ev);
    zoomAt(x, y, Math.exp(ev.deltaY * 0.0015));
  }, { passive: false });

  function orbit(dx, dy) {
    const k = 0.0085;
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * k);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(st.q);
    const pitch = new THREE.Quaternion().setFromAxisAngle(right, -dy * k);
    st.q.premultiply(pitch).premultiply(yaw).normalize();
    changed();
  }
  function pan(dx, dy) {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(st.q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(st.q);
    st.target.addScaledVector(right, -dx * st.scale).addScaledVector(up, dy * st.scale);
    changed();
  }
  function zoomAt(x, y, f) {
    const ns = Math.min(1e3, Math.max(1e-4, st.scale * f));
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(st.q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(st.q);
    const ox = x - st.w / 2, oy = st.h / 2 - y;
    st.target.addScaledVector(right, ox * (st.scale - ns)).addScaledVector(up, oy * (st.scale - ns));
    st.scale = ns;
    changed();
  }

  // ------------------------------------------------------------ projection helpers
  function toScreen(p) {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
    return [(v.x + 1) / 2 * st.w, (1 - v.y) / 2 * st.h];
  }
  function rayAt(x, y) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x / st.w * 2 - 1, -(y / st.h) * 2 + 1), camera);
    return ray;
  }
  function toPlane(x, y, pl) {
    const ray = rayAt(x, y).ray;
    const n = new THREE.Vector3(...pl.n), o = new THREE.Vector3(...pl.o);
    const den = ray.direction.dot(n);
    if (Math.abs(den) < 1e-9) return null;
    const t = o.clone().sub(ray.origin).dot(n) / den;
    const p = ray.origin.clone().addScaledVector(ray.direction, t).sub(o);
    return [p.dot(new THREE.Vector3(...pl.x)), p.dot(new THREE.Vector3(...pl.y))];
  }

  // ------------------------------------------------------------ body display
  let bodyData = null;   // { pos, idx, mesh, edges, adj }
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xb9c6cc, metalness: 0.18, roughness: 0.5, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1d2b30 });
  const wireMat = new THREE.LineBasicMaterial({ color: 0x23464f });

  function creased(pos, idx, angDeg = 32) {
    const nt = idx.length / 3;
    const fn = new Float32Array(nt * 3);
    const vt = new Map();
    for (let t = 0; t < nt; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
      fn[t * 3] = uy * wz - uz * wy; fn[t * 3 + 1] = uz * wx - ux * wz; fn[t * 3 + 2] = ux * wy - uy * wx;
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k];
        const key = pos[v * 3].toFixed(5) + ',' + pos[v * 3 + 1].toFixed(5) + ',' + pos[v * 3 + 2].toFixed(5);
        let l = vt.get(key); if (!l) vt.set(key, l = []); l.push(t);
      }
    }
    const cosT = Math.cos(angDeg * Math.PI / 180);
    const unit = (t) => { const x = fn[t * 3], y = fn[t * 3 + 1], z = fn[t * 3 + 2], l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
    const P = new Float32Array(nt * 9), N = new Float32Array(nt * 9);
    for (let t = 0; t < nt; t++) {
      const nf = unit(t);
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k];
        P.set([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], t * 9 + k * 3);
        const key = pos[v * 3].toFixed(5) + ',' + pos[v * 3 + 1].toFixed(5) + ',' + pos[v * 3 + 2].toFixed(5);
        let sx = 0, sy = 0, sz = 0;
        for (const o of vt.get(key)) {
          const no = unit(o);
          if (no[0] * nf[0] + no[1] * nf[1] + no[2] * nf[2] >= cosT) { sx += fn[o * 3]; sy += fn[o * 3 + 1]; sz += fn[o * 3 + 2]; }
        }
        const l = Math.hypot(sx, sy, sz) || 1;
        N.set([sx / l, sy / l, sz / l], t * 9 + k * 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    return g;
  }

  function clearGroup(g) {
    for (const c of [...g.children]) {
      g.remove(c);
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.map) o.material.map.dispose(); });
    }
  }

  function setBody(m) {
    clearGroup(groups.body);
    clearGroup(groups.hi);
    bodyData = null;
    if (m && m.idx.length) {
      const g = creased(m.pos, m.idx);
      const mesh = new THREE.Mesh(g, bodyMat);
      mesh.userData.kind = 'body';
      const ig = new THREE.BufferGeometry();
      ig.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      ig.setIndex(new THREE.BufferAttribute(m.idx, 1));
      let edges, segEdge = null;
      if (m.edges) {   // exact model edges from the B-rep kernel
        let n = 0;
        for (const e of m.edges) n += Math.max(0, e.pts.length / 3 - 1);
        const P = new Float32Array(n * 6);
        segEdge = new Uint32Array(n);
        let k = 0;
        m.edges.forEach((e, id) => {
          for (let i = 0; i + 1 < e.pts.length / 3; i++) {
            P.set(e.pts.subarray(i * 3, i * 3 + 6), k * 6);
            segEdge[k++] = id;
          }
        });
        const eg = new THREE.BufferGeometry();
        eg.setAttribute('position', new THREE.BufferAttribute(P, 3));
        edges = new THREE.LineSegments(eg, edgeMat);
        edges.userData.kind = 'edge';
      } else edges = new THREE.LineSegments(new THREE.EdgesGeometry(ig, 24), edgeMat);
      const wire = new THREE.LineSegments(new THREE.WireframeGeometry(ig), wireMat);
      ig.dispose();
      groups.body.add(mesh, edges, wire);
      bodyData = { pos: m.pos, idx: m.idx, mesh, edges, wire, adj: null, faceOf: m.faceOf || null, faceInfo: m.faceInfo || null, edgeList: m.edges || null, segEdge };
      applyDisplay();
    }
    needs = true;
  }

  function applyDisplay() {
    if (!bodyData) return;
    const d = st.display;
    bodyData.mesh.visible = d !== 'wire';
    bodyData.edges.visible = d === 'edges';
    bodyData.wire.visible = d === 'wire';
    bodyMat.transparent = !!st.ghost; bodyMat.opacity = st.ghost ? 0.35 : 1; bodyMat.depthWrite = !st.ghost;
    needs = true;
  }

  function setPreview(m, op) {
    clearGroup(groups.preview);
    if (m && m.idx.length) {
      const ig = new THREE.BufferGeometry();
      ig.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      ig.setIndex(new THREE.BufferAttribute(m.idx, 1));
      ig.computeVertexNormals();
      const col = op === 'cut' ? 0xe0533d : 0x14b8a6;
      const mesh = new THREE.Mesh(ig, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(ig, 24), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9 }));
      mesh.renderOrder = 5; edges.renderOrder = 6;
      groups.preview.add(mesh, edges);
    }
    needs = true;
  }

  // ------------------------------------------------------------ planes + origin
  const planeObjs = {};
  const PLANE_DEF = {
    front: { n: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] },
    top: { n: [0, 1, 0], x: [1, 0, 0], y: [0, 0, -1] },
    right: { n: [1, 0, 0], x: [0, 0, -1], y: [0, 1, 0] },
  };
  for (const name in PLANE_DEF) {
    const d = PLANE_DEF[name];
    const g = new THREE.PlaneGeometry(1, 1);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x4fb3c8, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }));
    const bd = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0x3a8fa3, transparent: true, opacity: 0.7 }));
    const grp = new THREE.Group();
    grp.add(m, bd);
    const mat = new THREE.Matrix4().makeBasis(new THREE.Vector3(...d.x), new THREE.Vector3(...d.y), new THREE.Vector3(...d.n));
    grp.quaternion.setFromRotationMatrix(mat);
    m.userData = { kind: 'plane', name };
    grp.userData = { name, fillMat: m.material, lineMat: bd.material };
    groups.planes.add(grp);
    planeObjs[name] = grp;
  }
  // origin triad
  {
    const mk = (dir, col) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...dir)]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color: col, depthTest: false }));
    };
    groups.origin.add(mk([1, 0, 0], 0xd9534f), mk([0, 1, 0], 0x3fa34d), mk([0, 0, 1], 0x3b6fd6));
    groups.origin.renderOrder = 10;
  }
  function sizePlanes(size) {
    for (const n in planeObjs) planeObjs[n].scale.set(size, size, size);
    groups.origin.scale.setScalar(size * 0.12);
    needs = true;
  }
  function highlightPlane(name) {
    for (const n in planeObjs) {
      const u = planeObjs[n].userData;
      u.fillMat.color.set(n === name ? 0x14b8a6 : 0x4fb3c8); u.fillMat.opacity = n === name ? 0.25 : 0.08;
      u.lineMat.color.set(n === name ? 0x0f766e : 0x3a8fa3);
    }
    needs = true;
  }

  // ------------------------------------------------------------ sketches (3D display)
  function setSketches(list) {
    clearGroup(groups.sketches);
    for (const s of list) {
      const g = new THREE.Group();
      g.userData = { kind: 'sketch', id: s.id };
      const pl = s.plane;
      const mat = new THREE.LineBasicMaterial({ color: s.color || 0x3b5bdb, depthTest: !s.onTop, transparent: true, opacity: s.opacity || 1 });
      const dmat = new THREE.LineDashedMaterial({ color: 0x7c8a90, dashSize: 2, gapSize: 1.4, depthTest: !s.onTop });
      for (const pl2 of s.polys) {
        const pts = pl2.pts.map(([u, v]) => new THREE.Vector3(
          pl.o[0] + pl.x[0] * u + pl.y[0] * v, pl.o[1] + pl.x[1] * u + pl.y[1] * v, pl.o[2] + pl.x[2] * u + pl.y[2] * v));
        if (pl2.closed) pts.push(pts[0]);
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(geo, pl2.cons ? dmat : mat);
        if (pl2.cons) line.computeLineDistances();
        line.userData = { kind: 'sketch', id: s.id };
        line.renderOrder = 3;
        g.add(line);
      }
      if (s.fill) {   // translucent region fill [{outer, holes}] for region picking
        for (const r of s.fill) {
          const shape = new THREE.Shape(r.outer.map(([u, v]) => new THREE.Vector2(u, v)));
          for (const h of r.holes) shape.holes.push(new THREE.Path(h.map(([u, v]) => new THREE.Vector2(u, v))));
          const geo = new THREE.ShapeGeometry(shape);
          const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: r.color || 0x14b8a6, transparent: true, opacity: r.opacity || 0.35, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
          m.matrixAutoUpdate = false;
          m.matrix.makeBasis(new THREE.Vector3(...pl.x), new THREE.Vector3(...pl.y), new THREE.Vector3(...pl.n)).setPosition(...pl.o);
          m.renderOrder = 4;
          g.add(m);
        }
      }
      groups.sketches.add(g);
    }
    needs = true;
  }

  // ------------------------------------------------------------ picking
  function pick(x, y, what = { body: true, planes: true, sketches: true }) {
    const ray = rayAt(x, y);
    ray.params.Line = { threshold: 8 * st.scale };
    const objs = [];
    if (what.sketches) objs.push(...groups.sketches.children.filter((g) => g.visible));
    if (what.body && bodyData && bodyData.mesh.visible) objs.push(bodyData.mesh);
    if (what.planes && groups.planes.visible) objs.push(...groups.planes.children.filter((g) => g.visible).map((g) => g.children[0]));
    if (what.edges && bodyData && bodyData.segEdge && bodyData.mesh.visible !== false) {
      // edges first, but only those in front of the body surface
      const er = rayAt(x, y);
      er.params.Line = { threshold: (what.edgeTol || 14) * st.scale };
      const eh = er.intersectObject(bodyData.edges, false);
      const fh = er.intersectObject(bodyData.mesh, false)[0];
      const front = fh ? fh.distance + 6 * st.scale : Infinity;
      const best = eh.filter((h) => h.distance <= front).sort((a, b) => a.distanceToRay - b.distanceToRay)[0];
      if (best) {
        const id = bodyData.segEdge[Math.floor(best.index / 2)];
        const e = bodyData.edgeList[id];
        return { kind: 'edge', id, mid: e.mid, dir: e.dir, point: best.point.toArray() };
      }
    }
    const hits = ray.intersectObjects(objs, true);
    // sketch lines win over faces when both are close
    for (const h of hits) if (h.object.userData.kind === 'sketch' && h.object.isLine) return { kind: 'sketch', id: h.object.userData.id };
    for (const h of hits) {
      const k = h.object.userData.kind;
      if (k === 'body') {
        const tri = h.faceIndex;
        const face = faceGroup(tri);
        return { kind: 'face', tri, point: h.point.toArray(), ...face };
      }
      if (k === 'plane') return { kind: 'plane', name: h.object.userData.name };
    }
    return null;
  }

  function triNormal(t) {
    const { pos, idx } = bodyData;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const u = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const w = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1;
    return { n: [n[0] / l, n[1] / l, n[2] / l], p: [pos[a], pos[a + 1], pos[a + 2]], area: l / 2 };
  }

  /** Connected coplanar triangles around tri t: a flat face. */
  function faceGroup(t) {
    const { pos, idx } = bodyData;
    if (bodyData.faceOf) {   // exact faces from the B-rep kernel
      const fid = bodyData.faceOf[t];
      if (!bodyData.faceTris) {
        bodyData.faceTris = [];
        bodyData.faceOf.forEach((f, i) => { (bodyData.faceTris[f] = bodyData.faceTris[f] || []).push(i); });
      }
      const fi = bodyData.faceInfo[fid];
      const tn = triNormal(t);
      return { faceId: fid, tris: bodyData.faceTris[fid], normal: fi.flat ? fi.n : tn.n, d: fi.flat ? fi.d : 0, flat: fi.flat, edges: fi.edges };
    }
    if (!bodyData.adj) {
      const key = (v) => pos[v * 3].toFixed(4) + ',' + pos[v * 3 + 1].toFixed(4) + ',' + pos[v * 3 + 2].toFixed(4);
      const vk = new Array(pos.length / 3);
      const canon = new Map();
      for (let v = 0; v < vk.length; v++) { const k = key(v); if (!canon.has(k)) canon.set(k, canon.size); vk[v] = canon.get(k); }
      const em = new Map();
      const nt = idx.length / 3;
      for (let i = 0; i < nt; i++) for (let k = 0; k < 3; k++) {
        const a = vk[idx[i * 3 + k]], b = vk[idx[i * 3 + (k + 1) % 3]];
        const ek = a < b ? a + '_' + b : b + '_' + a;
        let l = em.get(ek); if (!l) em.set(ek, l = []); l.push(i);
      }
      bodyData.adj = em; bodyData.vk = vk;
    }
    const t0 = triNormal(t);
    const d0 = t0.n[0] * t0.p[0] + t0.n[1] * t0.p[1] + t0.n[2] * t0.p[2];
    const seen = new Set([t]), stack = [t];
    const { vk, adj } = bodyData;
    let flat = true;
    while (stack.length) {
      const i = stack.pop();
      for (let k = 0; k < 3; k++) {
        const a = vk[idx[i * 3 + k]], b = vk[idx[i * 3 + (k + 1) % 3]];
        const ek = a < b ? a + '_' + b : b + '_' + a;
        for (const j of adj.get(ek) || []) {
          if (seen.has(j)) continue;
          const tj = triNormal(j);
          const dot = tj.n[0] * t0.n[0] + tj.n[1] * t0.n[1] + tj.n[2] * t0.n[2];
          const dj = t0.n[0] * tj.p[0] + t0.n[1] * tj.p[1] + t0.n[2] * tj.p[2];
          if (dot > 0.99999 && Math.abs(dj - d0) < 1e-3) { seen.add(j); stack.push(j); }
          else if (dot > 0.98) flat = false;   // gently curved neighbour: not a flat face
        }
      }
      if (seen.size > 200000) break;
    }
    return { tris: [...seen], normal: t0.n, d: d0, flat: flat || seen.size > 1 };
  }

  function highlightFace(face, color = 0x14b8a6) {
    for (const c of [...groups.hi.children]) if (c.userData.kind === 'facesel') { groups.hi.remove(c); c.geometry.dispose(); }
    if (face && bodyData) {
      const { pos, idx } = bodyData;
      const P = new Float32Array(face.tris.length * 9);
      face.tris.forEach((t, i) => {
        for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k] * 3; P[i * 9 + k * 3] = pos[v]; P[i * 9 + k * 3 + 1] = pos[v + 1]; P[i * 9 + k * 3 + 2] = pos[v + 2]; }
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.renderOrder = 4;
      m.userData.kind = 'facesel';
      groups.hi.add(m);
    }
    needs = true;
  }

  /** Thick overlay on edges (ids into the shown body, or into src.edges of another mesh). */
  function highlightEdges(ids, color = 0xf08c00, src) {
    for (const c of [...groups.hi.children]) if (c.userData.kind === 'edgehi') { groups.hi.remove(c); c.geometry.dispose(); }
    const list = src ? src.edges : bodyData && bodyData.edgeList;
    if (ids && ids.length && list) {
      const r = Math.max(0.02, 2.2 * st.scale);
      for (const id of ids) {
        const e = list[id];
        if (!e) continue;
        const path = new THREE.CurvePath();
        for (let i = 0; i + 1 < e.pts.length / 3; i++) {
          path.add(new THREE.LineCurve3(new THREE.Vector3(e.pts[i * 3], e.pts[i * 3 + 1], e.pts[i * 3 + 2]), new THREE.Vector3(e.pts[i * 3 + 3], e.pts[i * 3 + 4], e.pts[i * 3 + 5])));
        }
        if (!path.curves.length) continue;
        const tube = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(2, path.curves.length * 2), r, 6, false), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
        tube.userData.kind = 'edgehi';
        tube.renderOrder = 8;
        groups.hi.add(tube);
      }
    }
    needs = true;
  }
  /** Several faces at once (by face id), e.g. faces picked for a shell. */
  function highlightFaces(ids, color = 0xf08c00, src) {
    for (const c of [...groups.hi.children]) if (c.userData.kind === 'facehi') { groups.hi.remove(c); c.geometry.dispose(); }
    const m0 = src || bodyData;
    if (ids && ids.length && m0 && m0.faceOf) {
      const tris = [];
      m0.faceOf.forEach((f, i) => { if (ids.includes(f)) tris.push(i); });
      const { pos, idx } = m0;
      const P = new Float32Array(tris.length * 9);
      tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k] * 3; P.set([pos[v], pos[v + 1], pos[v + 2]], i * 9 + k * 3); } });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.userData.kind = 'facehi'; m.renderOrder = 4;
      groups.hi.add(m);
    }
    needs = true;
  }

  // ------------------------------------------------------------ framing
  function bounds() {
    const box = new THREE.Box3();
    if (bodyData) box.expandByObject(bodyData.mesh);
    for (const g of groups.sketches.children) box.expandByObject(g);
    for (const g of groups.preview.children) box.expandByObject(g);
    return box;
  }
  function fit(animate = true, extra) {
    const box = bounds();
    if (extra) for (const p of extra) box.expandByPoint(new THREE.Vector3(...p));
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
    const c = box.getCenter(new THREE.Vector3());
    // project the box corners on the view axes after the (target) rotation
    const q = st.anim ? st.anim.q1 : st.q;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q), up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    let w = 0, h = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
      w = Math.max(w, Math.abs(p.dot(right))); h = Math.max(h, Math.abs(p.dot(up)));
    }
    const s = Math.max((2 * w) / (st.w * 0.78), (2 * h) / (st.h * 0.7), 1e-3);
    if (animate || st.anim) animateTo(q.clone(), c, s); else { st.target.copy(c); st.scale = s; changed(); }
  }
  function setView(name, refit = true) {
    const q = viewQuat(name);
    animateTo(q, null, null);
    if (refit) fit(true);
  }
  /** Look straight at a sketch plane (x right, y up). */
  function normalTo(pl, center, scale) {
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...pl.x), new THREE.Vector3(...pl.y), new THREE.Vector3(...pl.n));
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    animateTo(q, center ? new THREE.Vector3(...center) : null, scale || null);
  }

  st.q.copy(viewQuat('iso'));
  resize();

  return {
    THREE, canvas, camera, st,
    set tool(t) { tool = t; }, get tool() { return tool; },
    set onTap(f) { onTap = f; },
    onChange: (f) => listeners.push(f),
    render: () => { needs = true; },
    resize,
    toScreen, toPlane, rayAt,
    pxSize: () => st.scale,
    setBody, setPreview, setSketches,
    sizePlanes, highlightPlane, showPlanes: (v) => { groups.planes.visible = !!v; groups.origin.visible = !!v; needs = true; },
    /** Per-plane visibility, e.g. {front: true, top: false, right: false}. */
    planeVisibility: (vis) => { for (const n in planeObjs) planeObjs[n].visible = vis[n] !== false; needs = true; },
    pick, highlightFace, highlightEdges, highlightFaces,
    edgeAt: (id) => (bodyData && bodyData.edgeList ? bodyData.edgeList[id] : null),
    faceInfoAt: (id) => (bodyData && bodyData.faceInfo ? bodyData.faceInfo[id] : null),
    fit, setView, normalTo, viewQuat, animateTo,
    lockRotate: (v) => { st.lockRotate = v; },
    setDisplay: (d) => { st.display = d; applyDisplay(); },
    setGhost: (g) => { st.ghost = g; applyDisplay(); },
    bodyBox: () => (bodyData ? new THREE.Box3().setFromObject(bodyData.mesh) : null),
    snapshot: (w = 360, h = 270) => {
      draw();
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#dfe7ea'; g.fillRect(0, 0, w, h);
      const sw = canvas.width, sh = canvas.height, k = Math.max(w / sw, h / sh);
      g.drawImage(canvas, (w - sw * k) / 2, (h - sh * k) / 2, sw * k, sh * k);
      return c.toDataURL('image/png');
    },
  };
}

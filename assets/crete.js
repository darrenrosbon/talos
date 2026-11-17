import * as THREE from './three.module.min.js';

// Crete in relief: terrain and sea-floor depth from AWS Terrain Tiles (open data).
// The marker laps the coast on a loop; the loop is a traced outline of the real coastline.

const W = 10;                       // world width of the land heightmap
const PAD_X = 95, PAD_Y = 75;       // depth map padding around the land crop, in depth-map pixels
const RELIEF = 2.5;
const LAP_MS = 12000;
const M_PER_UNIT = 1056 * 249.7 / W;

async function loadPixels(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return { data: g.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height, canvas: c };
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), k = 2 * r + 1;
  const cl = (v, m) => Math.min(m - 1, Math.max(0, v));
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + cl(x, w)];
    for (let x = 0; x < w; x++) { tmp[y * w + x] = sum / k; sum += src[y * w + cl(x + r + 1, w)] - src[y * w + cl(x - r, w)]; }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[cl(y, h) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = sum / k; sum += tmp[cl(y + r + 1, h) * w + x] - tmp[cl(y - r, h) * w + x]; }
  }
  return out;
}

function dataTexture(u8, w, h) {
  const t = new THREE.DataTexture(u8, w, h, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export async function start(container, onProgress) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(2);   // always supersample: the canvas is small, and it smooths the coast on 1x screens
  container.appendChild(renderer.domElement);

  const [hm, dp] = await Promise.all([
    loadPixels(new URL('./crete-height.png', import.meta.url)),
    loadPixels(new URL('./crete-depth.png', import.meta.url))
  ]);
  const cw = hm.w, ch = hm.h, hd = hm.data, H = W * ch / cw;

  const h8 = (x, y) => hd[(Math.max(0, Math.min(ch - 1, y)) * cw + Math.max(0, Math.min(cw - 1, x))) * 4];
  function sample(u, v) {
    const x = u * (cw - 1), y = (1 - v) * (ch - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    return (h8(x0, y0) * (1 - fx) + h8(x0 + 1, y0) * fx) * (1 - fy) + (h8(x0, y0 + 1) * (1 - fx) + h8(x0 + 1, y0 + 1) * fx) * fy;
  }

  // alpha mask so only land is drawn
  const maskC = document.createElement('canvas');
  maskC.width = cw; maskC.height = ch;
  const mg = maskC.getContext('2d'), md = mg.createImageData(cw, ch);
  for (let i = 0; i < cw * ch; i++) {
    const on = hd[i * 4] > 0 ? 255 : 0;
    md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = on; md.data[i * 4 + 3] = 255;
  }
  mg.putImageData(md, 0, 0);
  const alphaMap = new THREE.CanvasTexture(maskC);
  alphaMap.generateMipmaps = true;
  alphaMap.minFilter = THREE.LinearMipmapLinearFilter;
  alphaMap.anisotropy = renderer.capabilities.getMaxAnisotropy();

  // terrain
  const geo = new THREE.PlaneGeometry(W, H, 440, Math.round(440 * ch / cw));
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const col = new Float32Array(pos.count * 3);
  const lo = new THREE.Color('#2b2521'), hi = new THREE.Color('#efe6d8'), tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const s = sample(uv.getX(i), uv.getY(i));
    pos.setY(i, s / 255 * 2500 / M_PER_UNIT * RELIEF);
    tmp.copy(lo).lerp(hi, Math.pow(Math.min(1, s / 255 * 1.9), 0.8));
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const island = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0, alphaMap, alphaTest: 0.5, alphaToCoverage: true
  }));

  // coastline outline: largest landmass, dilated a few pixels, traced and smoothed
  let best = [];
  const seen = new Uint8Array(cw * ch);
  for (let s = 0; s < cw * ch; s++) {
    if (seen[s] || hd[s * 4] === 0) continue;
    const comp = [], stack = [s]; seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(); comp.push(i);
      const x = i % cw, y = (i / cw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const j = ny * cw + nx;
        if (!seen[j] && hd[j * 4] > 0) { seen[j] = 1; stack.push(j); }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  const R = 5, dil = new Uint8Array(cw * ch);
  for (const i of best) {
    const x = i % cw, y = (i / cw) | 0;
    if (hd[(i - 1) * 4] && hd[(i + 1) * 4] && hd[(i - cw) * 4] && hd[(i + cw) * 4]) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < cw && ny < ch) dil[ny * cw + nx] = 1;
    }
  }
  const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  let s0 = 0; while (!dil[s0]) s0++;
  const sx = s0 % cw, sy = (s0 / cw) | 0, trace = [[sx, sy]];
  { let x = sx, y = sy, back = 4, guard = 0;
    do {
      let moved = false;
      for (let k = 1; k <= 8; k++) {
        const d = (back + k) % 8, nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && dil[ny * cw + nx]) {
          const pd = (back + k - 1) % 8, qx = x + DIRS[pd][0] - nx, qy = y + DIRS[pd][1] - ny;
          back = DIRS.findIndex(([a, b]) => a === qx && b === qy);
          x = nx; y = ny; trace.push([nx, ny]); moved = true; break;
        }
      }
      if (!moved) break;
    } while ((x !== sx || y !== sy) && ++guard < 20000);
  }
  const ring = [], SM = 5, n0 = trace.length;
  for (let i = 0; i < n0; i += 3) {
    let ax = 0, az = 0;
    for (let k = -SM; k <= SM; k++) { const p = trace[(i + k + n0 * 4) % n0]; ax += p[0]; az += p[1]; }
    ring.push([(ax / (2 * SM + 1) / cw - 0.5) * W, (az / (2 * SM + 1) / ch - 0.5) * H]);
  }
  const seg = [0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    seg.push(seg[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = seg[seg.length - 1];
  function onRing(p) {
    const d = (((p % 1) + 1) % 1) * total;
    let i = 0; while (seg[i + 1] < d) i++;
    const a = ring[i], b = ring[(i + 1) % ring.length], f = (d - seg[i]) / (seg[i + 1] - seg[i]);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }

  // scene
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 3, 0.1, 100);
  camera.position.set(0, 5.5, 6.7);
  camera.lookAt(0, -0.1, 0);
  scene.add(new THREE.AmbientLight(0xfff2e6, 0.55));
  const sun = new THREE.DirectionalLight(0xfff0e0, 2.1);
  sun.position.set(-6, 3.2, -4);
  scene.add(sun);

  const group = new THREE.Group();
  group.add(island);

  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(Array.from({ length: 360 }, (_, i) => { const [x, z] = onRing(i / 360); return new THREE.Vector3(x, 0.02, z); })),
    new THREE.LineBasicMaterial({ color: 0xd8cfc3, transparent: true, opacity: 0.45 })
  );
  group.add(outline);

  const TRAIL = 60, tp = new Float32Array(TRAIL * 3), tc = new Float32Array(TRAIL * 3);
  for (let k = 0; k < TRAIL; k++) { const f = Math.pow(1 - k / TRAIL, 1.6); tc.set([0.9 * f, 0.17 * f, 0.17 * f], k * 3); }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(tp, 3));
  tg.setAttribute('color', new THREE.BufferAttribute(tc, 3));
  const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true }));
  trail.frustumCulled = false;
  group.add(trail);
  const dots = [0, 1, 2, 3, 4, 5].map((k) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.075 - k * 0.011, 16, 12), new THREE.MeshBasicMaterial({ color: 0xe62c2c, transparent: true, opacity: 1 - k * 0.17 }));
    group.add(m); return m;
  });

  // sea: real depth, pale shallows to near-black deeps, a contour every 250 m
  // depth is softened slightly so shelf edges grade instead of stepping
  const depthF = new Float32Array(dp.w * dp.h);
  for (let i = 0; i < depthF.length; i++) depthF[i] = dp.data[i * 4];
  const depthB = boxBlur(boxBlur(depthF, dp.w, dp.h, 2), dp.w, dp.h, 2);
  const depthU8 = new Uint8Array(depthB.length);
  for (let i = 0; i < depthB.length; i++) depthU8[i] = Math.round(depthB[i]);
  const depthTex = dataTexture(depthU8, dp.w, dp.h);

  // the sea fades out with distance from the coast, so it ends in a soft halo, not a cut-off shape
  const landF = new Float32Array(dp.w * dp.h);
  for (let y = 0; y < dp.h; y++) for (let x = 0; x < dp.w; x++) {
    const lx = (x - PAD_X) * 2, ly = (y - PAD_Y) * 2;
    if (lx >= 0 && ly >= 0 && lx < cw && ly < ch && hd[(ly * cw + lx) * 4] > 0) landF[y * dp.w + x] = 1;
  }
  const haloB = boxBlur(boxBlur(landF, dp.w, dp.h, 27), dp.w, dp.h, 27);
  const haloU8 = new Uint8Array(haloB.length);
  for (let i = 0; i < haloB.length; i++) haloU8[i] = Math.min(255, Math.round(haloB[i] * 255 * 2.6));
  const haloTex = dataTexture(haloU8, dp.w, dp.h);
  const pw = W * (cw + 2 * PAD_X * 2) / cw, ph = H * (ch + 2 * PAD_Y * 2) / ch;
  const seaGeo = new THREE.PlaneGeometry(pw, ph, 1, 1);
  seaGeo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { depth: { value: depthTex }, halo: { value: haloTex }, PW: { value: pw }, PH: { value: ph }, LW: { value: W }, LH: { value: H } },
    vertexShader: 'varying vec2 wp; void main(){ wp = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader:
      'uniform sampler2D depth; uniform sampler2D halo; uniform float PW; uniform float PH; uniform float LW; uniform float LH; varying vec2 wp;' +
      'void main(){' +
      ' vec2 uv = vec2(wp.x / PW + 0.5, wp.y / PH + 0.5);' +
      ' float d = texture2D(depth, uv).r;' +
      ' vec3 shal = vec3(0.27, 0.36, 0.41); vec3 deep = vec3(0.05, 0.07, 0.09);' +
      ' vec3 c = mix(shal, deep, pow(clamp(d * 3.0, 0.0, 1.0), 0.8));' +
      ' float k = d * 4000.0 / 250.0;' +
      ' float line = 1.0 - smoothstep(0.0, fwidth(k) * 1.6 + 0.001, min(fract(k), 1.0 - fract(k)));' +
      ' c += line * 0.06 * step(0.003, d);' +
      ' float h = texture2D(halo, uv).r;' +
      ' float a = smoothstep(0.03, 0.55, h) * smoothstep(1.0, 0.55, length((uv - 0.5) * 2.0));' +
      ' gl_FragColor = vec4(c, a * 0.88);' +
      '}'
  }));
  sea.position.y = -0.006;
  sea.renderOrder = -1;
  group.add(sea);
  scene.add(group);

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let visible = true, raf = 0, lastLabel = '';
  function frame(now) {
    const t = reduced ? 0.38 * LAP_MS : now;
    const lap = t / LAP_MS, p = lap % 1;
    group.rotation.y = reduced ? 0 : Math.sin(now / 9000) * 0.26;
    for (let k = 0; k < TRAIL; k++) { const [x, z] = onRing(p - k * 0.0014); tp.set([x, 0.03, z], k * 3); }
    tg.attributes.position.needsUpdate = true;
    dots.forEach((d, k) => { const [x, z] = onRing(p - k * 0.008); d.position.set(x, 0.06, z); });
    renderer.render(scene, camera);
    if (onProgress) {
      const label = ((Math.floor(lap) % 3) + 1) + '|' + Math.round(p * 100);
      if (label !== lastLabel) { lastLabel = label; onProgress((Math.floor(lap) % 3) + 1, Math.round(p * 100)); }
    }
  }
  function loop(now) { frame(now); raf = requestAnimationFrame(loop); }
  function run() { if (!raf && !reduced) raf = requestAnimationFrame(loop); }
  function pause() { cancelAnimationFrame(raf); raf = 0; }

  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible) { run(); if (reduced) frame(0); } else pause();
  }).observe(container);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else if (visible) run(); });
  frame(performance.now());
  run();
  return renderer;
}

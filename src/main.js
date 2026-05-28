import * as THREE from 'three'

const PLY_URL = '/scene.ply'
const VERTEX_STRIDE = 56

const state = { forward: false, backward: false, turnLeft: false, turnRight: false, loaded: false }

let camera, scene, renderer
let yaw = 0
let moveSpeed = 2
const ROT_SPEED = 1.8
let gaussianMesh = null
let sortData = null
let depthArray = null
let sortedIndices = null
let numPoints = 0
let needsSort = false
let lastTime = 0
let sortCount = 0

function initScene() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x333333)

  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000)

  renderer = new THREE.WebGLRenderer({ antialias: false })
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  document.getElementById('scene-container').appendChild(renderer.domElement)

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })
}

const vertexShader = `
attribute vec3 aColor;
attribute float aAlpha;
attribute vec3 aScale;
attribute vec4 aRotation;
attribute vec2 aCorner;

uniform vec2 uViewport;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vCenterPx;
varying float vDet;
varying float vCov00;
varying float vCov01;
varying float vCov11;

mat3 quatToMat(vec4 q) {
  float d2 = q.x*q.x + q.y*q.y + q.z*q.z + q.w*q.w;
  float s = 2.0 / d2;
  float xs = q.x*s, ys = q.y*s, zs = q.z*s;
  float wx = q.w*xs, wy = q.w*ys, wz = q.w*zs;
  float xx = q.x*xs, xy = q.x*ys, xz = q.x*zs;
  float yy = q.y*ys, yz = q.y*zs, zz = q.z*zs;
  return mat3(
    1.0 - (yy+zz), xy - wz, xz + wy,
    xy + wz, 1.0 - (xx+zz), yz - wx,
    xz - wy, yz + wx, 1.0 - (xx+yy)
  );
}

void main() {
  vColor = aColor;
  vAlpha = aAlpha;

  vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
  vec4 projPos = projectionMatrix * viewPos;
  float z = -viewPos.z;

  mat3 R = quatToMat(aRotation);
  vec3 s2 = aScale * aScale;
  vec3 s2R0 = R[0] * s2, s2R1 = R[1] * s2, s2R2 = R[2] * s2;

  mat3 cov3D;
  cov3D[0][0] = dot(R[0], s2R0);
  cov3D[1][0] = dot(R[1], s2R0);
  cov3D[2][0] = dot(R[2], s2R0);
  cov3D[0][1] = dot(R[0], s2R1);
  cov3D[1][1] = dot(R[1], s2R1);
  cov3D[2][1] = dot(R[2], s2R1);
  cov3D[0][2] = dot(R[0], s2R2);
  cov3D[1][2] = dot(R[1], s2R2);
  cov3D[2][2] = dot(R[2], s2R2);

  mat3 V = mat3(modelViewMatrix);
  vec3 vR0 = V * cov3D[0], vR1 = V * cov3D[1], vR2 = V * cov3D[2];
  mat3 covView;
  covView[0][0] = dot(vR0, V[0]);
  covView[1][0] = dot(vR1, V[0]);
  covView[2][0] = dot(vR2, V[0]);
  covView[0][1] = dot(vR0, V[1]);
  covView[1][1] = dot(vR1, V[1]);
  covView[2][1] = dot(vR2, V[1]);
  covView[0][2] = dot(vR0, V[2]);
  covView[1][2] = dot(vR1, V[2]);
  covView[2][2] = dot(vR2, V[2]);

  float fx = projectionMatrix[0][0], fy = projectionMatrix[1][1];
  float vx = viewPos.x, vy = viewPos.y;

  float J00 = fx / z, J02 = -fx * vx / (z * z);
  float J11 = fy / z, J12 = -fy * vy / (z * z);

  vCov00 = J00*J00*covView[0][0] + J02*J02*covView[2][2];
  vCov01 = J00*J11*covView[0][1] + J00*J12*covView[0][2] + J02*J11*covView[2][1] + J02*J12*covView[2][2];
  vCov11 = J11*J11*covView[1][1] + J12*J12*covView[2][2];

  vDet = max(vCov00*vCov11 - vCov01*vCov01, 1e-10);
  float radius = 3.0 * sqrt(max(vCov00, vCov11));

  vCenterPx = (projPos.xy / projPos.w) * 0.5 * uViewport + 0.5 * uViewport;
  vec2 pxPos = vCenterPx + aCorner * radius;
  vec2 ndc = pxPos / uViewport * 2.0 - 1.0;
  gl_Position = vec4(ndc, projPos.z / projPos.w, 1.0);
}
`

const fragmentShader = `
precision highp float;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vCenterPx;
varying float vDet;
varying float vCov00;
varying float vCov01;
varying float vCov11;

void main() {
  vec2 d = gl_FragCoord.xy - vCenterPx;
  float invDet = 1.0 / vDet;
  float a = vCov11 * invDet;
  float b = -vCov01 * invDet;
  float c = vCov00 * invDet;
  float mahal = d.x*(a*d.x + b*d.y) + d.y*(b*d.x + c*d.y);

  float alpha = min(vAlpha * exp(-0.5 * mahal), 1.0);
  if (alpha < 0.004) alpha = 0.3;

  gl_FragColor = vec4(vColor, alpha);
}
`

function parsePLY(buffer) {
  const decoder = new TextDecoder('ascii')
  const headerStr = decoder.decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 3000)))
  const endIdx = headerStr.indexOf('end_header\n')
  if (endIdx === -1) throw new Error('Invalid PLY header')

  let vertexCount = 0
  for (const line of headerStr.substring(0, endIdx).split('\n')) {
    if (line.startsWith('element vertex')) { vertexCount = parseInt(line.split(' ')[2], 10); break }
  }
  if (!vertexCount) throw new Error('No vertex count in PLY header')

  const dataStart = endIdx + 'end_header\n'.length
  const dv = new DataView(buffer, dataStart)
  const N = vertexCount

  const positions = new Float32Array(N * 3)
  const colors = new Float32Array(N * 3)
  const scales = new Float32Array(N * 3)
  const rotations = new Float32Array(N * 4)
  const alphas = new Float32Array(N)

  for (let i = 0; i < N; i++) {
    const off = i * VERTEX_STRIDE
    const i3 = i * 3, i4 = i * 4

    positions[i3] = dv.getFloat32(off, true)
    positions[i3 + 1] = dv.getFloat32(off + 4, true)
    positions[i3 + 2] = dv.getFloat32(off + 8, true)

    colors[i3] = 1 / (1 + Math.exp(-dv.getFloat32(off + 12, true)))
    colors[i3 + 1] = 1 / (1 + Math.exp(-dv.getFloat32(off + 16, true)))
    colors[i3 + 2] = 1 / (1 + Math.exp(-dv.getFloat32(off + 20, true)))

    alphas[i] = 1 / (1 + Math.exp(-dv.getFloat32(off + 24, true)))

    scales[i3] = Math.exp(dv.getFloat32(off + 28, true))
    scales[i3 + 1] = Math.exp(dv.getFloat32(off + 32, true))
    scales[i3 + 2] = Math.exp(dv.getFloat32(off + 36, true))

    rotations[i4] = dv.getFloat32(off + 40, true)
    rotations[i4 + 1] = dv.getFloat32(off + 44, true)
    rotations[i4 + 2] = dv.getFloat32(off + 48, true)
    rotations[i4 + 3] = dv.getFloat32(off + 52, true)
  }

  return { positions, colors, scales, rotations, alphas, numPoints: N }
}

function createGaussianSplat(data) {
  const { positions, colors, scales, rotations, alphas, numPoints } = data
  const N = numPoints
  const stride = 4

  const verts = new Float32Array(N * stride * 3)
  const cols = new Float32Array(N * stride * 3)
  const alps = new Float32Array(N * stride)
  const scs = new Float32Array(N * stride * 3)
  const rots = new Float32Array(N * stride * 4)
  const corners = new Float32Array(N * stride * 2)

  for (let i = 0; i < N; i++) {
    const i3 = i * 3, i4 = i * 4, base = i * stride
    for (let c = 0; c < stride; c++) {
      const vi = (base + c) * 3, vi2 = (base + c) * 2, vi4 = (base + c) * 4
      verts[vi] = positions[i3]; verts[vi + 1] = positions[i3 + 1]; verts[vi + 2] = positions[i3 + 2]
      cols[vi] = colors[i3]; cols[vi + 1] = colors[i3 + 1]; cols[vi + 2] = colors[i3 + 2]
      alps[base + c] = alphas[i]
      scs[vi] = scales[i3]; scs[vi + 1] = scales[i3 + 1]; scs[vi + 2] = scales[i3 + 2]
      rots[vi4] = rotations[i4]; rots[vi4 + 1] = rotations[i4 + 1]
      rots[vi4 + 2] = rotations[i4 + 2]; rots[vi4 + 3] = rotations[i4 + 3]
      corners[vi2] = (c === 0 || c === 3) ? -1 : 1
      corners[vi2 + 1] = (c === 0 || c === 1) ? -1 : 1
    }
  }

  sortedIndices = new Uint32Array(N)
  for (let i = 0; i < N; i++) sortedIndices[i] = i
  depthArray = new Float32Array(N)

  const indices = new Uint32Array(N * 6)
  for (let i = 0; i < N; i++) {
    const base = i * stride, ibase = i * 6
    indices[ibase] = base; indices[ibase + 1] = base + 1; indices[ibase + 2] = base + 2
    indices[ibase + 3] = base; indices[ibase + 4] = base + 2; indices[ibase + 5] = base + 3
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  geometry.setAttribute('aColor', new THREE.BufferAttribute(cols, 3))
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alps, 1))
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scs, 3))
  geometry.setAttribute('aRotation', new THREE.BufferAttribute(rots, 4))
  geometry.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { uViewport: { value: new THREE.Vector2(innerWidth, innerHeight) } },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor
  })

  sortData = { positions, colors, scales, rotations, alphas, N }

  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  return mesh
}

function computeBounds(positions) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  return {
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, cz: (minZ + maxZ) / 2,
    sx: maxX - minX, sy: maxY - minY, sz: maxZ - minZ,
    size: Math.max(maxX - minX, maxY - minY, maxZ - minZ)
  }
}

function sortGaussians() {
  if (!sortData) return
  const { positions, N } = sortData
  const cp = camera.position
  for (let i = 0; i < N; i++) {
    const i3 = i * 3
    const dx = positions[i3] - cp.x, dy = positions[i3 + 1] - cp.y, dz = positions[i3 + 2] - cp.z
    depthArray[i] = dx * dx + dy * dy + dz * dz
  }
  sortedIndices.sort((a, b) => depthArray[b] - depthArray[a])
}

function updateSortBuffer() {
  if (!gaussianMesh || !sortData) return
  const { positions, colors, scales, rotations, alphas, N } = sortData
  const geo = gaussianMesh.geometry
  const pos = geo.attributes.position
  const col = geo.attributes.aColor
  const alp = geo.attributes.aAlpha
  const sc = geo.attributes.aScale
  const rot = geo.attributes.aRotation

  for (let i = 0; i < N; i++) {
    const si = sortedIndices[i], i3 = si * 3, i4 = si * 4, base = i * 4
    for (let c = 0; c < 4; c++) {
      const vi = (base + c) * 3, vi4 = (base + c) * 4
      pos.array[vi] = positions[i3]; pos.array[vi + 1] = positions[i3 + 1]; pos.array[vi + 2] = positions[i3 + 2]
      col.array[vi] = colors[i3]; col.array[vi + 1] = colors[i3 + 1]; col.array[vi + 2] = colors[i3 + 2]
      alp.array[base + c] = alphas[si]
      sc.array[vi] = scales[i3]; sc.array[vi + 1] = scales[i3 + 1]; sc.array[vi + 2] = scales[i3 + 2]
      rot.array[vi4] = rotations[i4]; rot.array[vi4 + 1] = rotations[i4 + 1]
      rot.array[vi4 + 2] = rotations[i4 + 2]; rot.array[vi4 + 3] = rotations[i4 + 3]
    }
  }
  pos.needsUpdate = true; col.needsUpdate = true
  alp.needsUpdate = true; sc.needsUpdate = true; rot.needsUpdate = true
}

async function loadScene() {
  const $ = id => document.getElementById(id)
  const progressBar = $('loading-progress')
  const percentEl = $('loading-percent')
  percentEl.textContent = '加载中...'

  console.log('[PLY] 开始加载...')
  const resp = await fetch(PLY_URL)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  console.log('[PLY] HTTP', resp.status, '大小:', resp.headers.get('Content-Length'))

  const reader = resp.body.getReader()
  const chunks = []
  let received = 0
  const cl = parseInt(resp.headers.get('Content-Length') || '0', 10)
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    if (cl > 0) {
      progressBar.style.width = Math.round((received / cl) * 100) + '%'
      percentEl.textContent = Math.round((received / cl) * 100) + '%'
    }
  }
  const buf = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0))
  let p = 0; for (const c of chunks) { buf.set(c, p); p += c.byteLength }
  console.log('[PLY] 下载完成:', buf.byteLength, '字节')

  progressBar.style.width = '100%'
  percentEl.textContent = '解析点云...'
  await new Promise(r => setTimeout(r, 50))

  const t0 = performance.now()
  const data = parsePLY(buf.buffer)
  const dt = performance.now() - t0
  console.log('[PLY] 解析完成:', data.numPoints, '个顶点, 耗时', dt.toFixed(0), 'ms')
  console.log('[PLY] 范围:',
    'X', data.positions[0].toFixed(2), data.positions[1].toFixed(2), data.positions[2].toFixed(2),
    'Alpha', data.alphas[0].toFixed(4), 'Scale', data.scales[0].toFixed(4), data.scales[1].toFixed(4), data.scales[2].toFixed(4),
    'Rot', data.rotations[0].toFixed(4), data.rotations[1].toFixed(4), data.rotations[2].toFixed(4), data.rotations[3].toFixed(4))

  const bounds = computeBounds(data.positions)
  console.log('[PLY] 包围盒:', bounds)

  percentEl.textContent = '构建高斯...'
  await new Promise(r => setTimeout(r, 50))

  const t1 = performance.now()
  gaussianMesh = createGaussianSplat(data)
  scene.add(gaussianMesh)
  console.log('[GS] 高斯网格创建耗时:', (performance.now() - t1).toFixed(0), 'ms')



  camera.far = Math.max(500, bounds.size * 2.5)
  camera.updateProjectionMatrix()
  moveSpeed = Math.max(1, bounds.size * 0.4)

  const eyeH = Math.max(1.5, bounds.cy - bounds.sy * 0.3)
  camera.position.set(bounds.cx + bounds.sx * 0.05, bounds.cy + bounds.sy * 0.5, bounds.cz + bounds.sz * 0.8)
  yaw = Math.atan2(-(bounds.cx - camera.position.x), -(bounds.cz - camera.position.z))

  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))
  camera.lookAt(new THREE.Vector3(bounds.cx, bounds.cy, bounds.cz))

  $('loading').classList.add('hidden')
  state.loaded = true
  console.log('[GS] 场景加载完成')
}

function animate(time) {
  requestAnimationFrame(animate)
  const delta = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0.016
  lastTime = time

  if (state.loaded) {
    const speed = moveSpeed * delta
    const dir = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))
    if (state.forward) camera.position.addScaledVector(dir, speed)
    if (state.backward) camera.position.addScaledVector(dir, -speed)
    if (state.turnLeft) yaw += ROT_SPEED * delta
    if (state.turnRight) yaw -= ROT_SPEED * delta
    camera.lookAt(new THREE.Vector3(
      camera.position.x + dir.x,
      camera.position.y,
      camera.position.z + dir.z
    ))
    needsSort = true
  }

  if (gaussianMesh) {
    if (needsSort) {
      sortCount++
      if (sortCount % 3 === 0) {
        sortGaussians()
        updateSortBuffer()
      }
    }
    gaussianMesh.material.uniforms.uViewport.value.set(innerWidth, innerHeight)
  }

  renderer.render(scene, camera)

  // 每60帧输出一次渲染统计
  if (Math.floor(time / 1000) % 2 === 0 && !window._logged) {
    window._logged = true
    const info = renderer.info
    console.log('[RENDER]', 'triangles:', info.render.triangles, 'calls:', info.render.calls, 'points:', info.render.points)
    console.log('[RENDER] programs:', info.programs?.length, 'geometries:', info.memory?.geometries, 'textures:', info.memory?.textures)
  }
  if (Math.floor(time / 1000) % 2 !== 0) window._logged = false
}

function setupControls() {
  const bind = (id, key) => {
    const el = document.getElementById(id)
    const press = () => { state[key] = true; el.classList.add('pressed') }
    const release = () => { state[key] = false; el.classList.remove('pressed') }
    el.addEventListener('mousedown', press); el.addEventListener('mouseup', release); el.addEventListener('mouseleave', release)
    el.addEventListener('touchstart', e => { e.preventDefault(); press() }, { passive: false })
    el.addEventListener('touchend', e => { e.preventDefault(); release() }, { passive: false })
    el.addEventListener('touchcancel', release)
  }
  bind('btn-up', 'forward'); bind('btn-down', 'backward'); bind('btn-left', 'turnLeft'); bind('btn-right', 'turnRight')
  addEventListener('keydown', e => {
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': state.forward = true; e.preventDefault(); break
      case 'ArrowDown': case 'KeyS': state.backward = true; e.preventDefault(); break
      case 'ArrowLeft': case 'KeyA': state.turnLeft = true; e.preventDefault(); break
      case 'ArrowRight': case 'KeyD': state.turnRight = true; e.preventDefault(); break
    }
  })
  addEventListener('keyup', e => {
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': state.forward = false; break
      case 'ArrowDown': case 'KeyS': state.backward = false; break
      case 'ArrowLeft': case 'KeyA': state.turnLeft = false; break
      case 'ArrowRight': case 'KeyD': state.turnRight = false; break
    }
  })
}

initScene()
setupControls()
loadScene().catch(err => {
  console.error(err)
  document.querySelector('.loading-text').textContent = '加载失败: ' + err.message
})
animate()

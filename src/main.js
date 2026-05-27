import * as THREE from 'three'

const PLY_URL = '/scene.ply'
const VERTEX_STRIDE = 56

const state = {
  forward: false,
  backward: false,
  turnLeft: false,
  turnRight: false,
  loaded: false
}

let camera, scene, renderer
let yaw = 0
let moveSpeed = 2
const ROT_SPEED = 1.8

function initScene() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x1a1a1a)

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000)
  camera.position.set(0, 2, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  document.getElementById('scene-container').appendChild(renderer.domElement)

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })
}

function createCircleTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const center = size / 2
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.95)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

function parsePLY(buffer) {
  const headerEnd = 'end_header\n'
  const decoder = new TextDecoder('ascii')
  const headerStr = decoder.decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 2000)))
  const headerIdx = headerStr.indexOf(headerEnd)
  if (headerIdx === -1) throw new Error('Invalid PLY header')

  const headerLines = headerStr.substring(0, headerIdx).split('\n')
  let vertexCount = 0
  for (const line of headerLines) {
    if (line.startsWith('element vertex')) {
      vertexCount = parseInt(line.split(' ')[2], 10)
      break
    }
  }
  if (!vertexCount) throw new Error('No vertex count found')

  const dataStart = headerIdx + headerEnd.length
  const dv = new DataView(buffer, dataStart)

  const positions = new Float32Array(vertexCount * 3)
  const colors = new Float32Array(vertexCount * 3)
  let offset = 0

  for (let i = 0; i < vertexCount; i++) {
    const x = dv.getFloat32(offset, true)
    const y = dv.getFloat32(offset + 4, true)
    const z = dv.getFloat32(offset + 8, true)
    const shR = dv.getFloat32(offset + 12, true)
    const shG = dv.getFloat32(offset + 16, true)
    const shB = dv.getFloat32(offset + 20, true)

    const i3 = i * 3
    positions[i3] = x
    positions[i3 + 1] = y
    positions[i3 + 2] = z

    colors[i3] = 1 / (1 + Math.exp(-shR))
    colors[i3 + 1] = 1 / (1 + Math.exp(-shG))
    colors[i3 + 2] = 1 / (1 + Math.exp(-shB))

    offset += VERTEX_STRIDE
  }

  return { positions, colors, vertexCount }
}

function computeBounds(positions) {
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity
  const len = positions.length
  for (let i = 0; i < len; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return {
    minX, maxX, minY, maxY, minZ, maxZ,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    centerZ: (minZ + maxZ) / 2,
    sizeX: maxX - minX,
    sizeY: maxY - minY,
    sizeZ: maxZ - minZ,
    size: Math.max(maxX - minX, maxY - minY, maxZ - minZ)
  }
}

function filterOutliers(positions, bounds) {
  const threshold = bounds.size * 5
  const cx = bounds.centerX, cy = bounds.centerY, cz = bounds.centerZ
  const valid = []
  const len = positions.length
  for (let i = 0; i < len; i += 3) {
    const dx = positions[i] - cx
    const dy = positions[i + 1] - cy
    const dz = positions[i + 2] - cz
    if (Math.abs(dx) < threshold && Math.abs(dy) < threshold && Math.abs(dz) < threshold) {
      valid.push(i)
    }
  }
  return valid
}

async function loadScene() {
  const progressBar = document.getElementById('loading-progress')
  const percentEl = document.getElementById('loading-percent')

  const response = await fetch(PLY_URL)
  if (!response.ok) throw new Error(`Failed to load: ${response.status}`)

  const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10)
  const reader = response.body.getReader()
  const chunks = []
  let received = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    if (contentLength > 0) {
      const pct = Math.round((received / contentLength) * 100)
      progressBar.style.width = pct + '%'
      percentEl.textContent = pct + '%'
    }
  }

  const totalLength = chunks.reduce((s, c) => s + c.byteLength, 0)
  const buffer = new Uint8Array(totalLength)
  let pos = 0
  for (const chunk of chunks) {
    buffer.set(chunk, pos)
    pos += chunk.byteLength
  }
  progressBar.style.width = '100%'
  percentEl.textContent = '解析中...'

  await new Promise(r => setTimeout(r, 50))

  const { positions, colors } = parsePLY(buffer.buffer)

  const bounds = computeBounds(positions)
  const validIndices = filterOutliers(positions, bounds)
  const validCount = validIndices.length
  const filteredPos = new Float32Array(validCount * 3)
  const filteredCol = new Float32Array(validCount * 3)
  for (let i = 0; i < validCount; i++) {
    const srcIdx = validIndices[i]
    filteredPos[i * 3] = positions[srcIdx]
    filteredPos[i * 3 + 1] = positions[srcIdx + 1]
    filteredPos[i * 3 + 2] = positions[srcIdx + 2]
    filteredCol[i * 3] = colors[srcIdx]
    filteredCol[i * 3 + 1] = colors[srcIdx + 1]
    filteredCol[i * 3 + 2] = colors[srcIdx + 2]
  }

  const finalBounds = computeBounds(filteredPos)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(filteredPos, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(filteredCol, 3))

  const pointSize = Math.max(0.05, finalBounds.size * 0.003)
  const material = new THREE.PointsMaterial({
    size: pointSize,
    sizeAttenuation: true,
    vertexColors: true,
    map: createCircleTexture(),
    transparent: true,
    depthWrite: true,
    depthTest: true,
    blending: THREE.NormalBlending,
    opacity: 0.95
  })

  const points = new THREE.Points(geometry, material)
  scene.add(points)

  const maxDim = finalBounds.size
  scene.fog = new THREE.Fog(0x1a1a1a, maxDim * 0.5, maxDim * 1.5)
  camera.far = Math.max(500, maxDim * 2.5)
  camera.updateProjectionMatrix()

  moveSpeed = Math.max(1, maxDim * 0.4)

  const eyeHeight = Math.max(1.5, finalBounds.minY + finalBounds.sizeY * 0.25)
  camera.position.set(finalBounds.centerX, eyeHeight, finalBounds.centerZ + finalBounds.sizeZ * 0.3)
  yaw = Math.atan2(-(finalBounds.centerX - camera.position.x), -(finalBounds.centerZ - camera.position.z))
  updateCameraDirection()

  document.getElementById('loading').classList.add('hidden')
  state.loaded = true
}

function updateCameraDirection() {
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))
  const target = new THREE.Vector3(
    camera.position.x + forward.x,
    camera.position.y,
    camera.position.z + forward.z
  )
  camera.lookAt(target)
}

function updateMovement(delta) {
  if (!state.loaded) return
  const speed = moveSpeed * delta
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))

  if (state.forward) {
    camera.position.add(forward.clone().multiplyScalar(speed))
  }
  if (state.backward) {
    camera.position.add(forward.clone().multiplyScalar(-speed))
  }
  if (state.turnLeft) {
    yaw += ROT_SPEED * delta
  }
  if (state.turnRight) {
    yaw -= ROT_SPEED * delta
  }

  updateCameraDirection()
}

let lastTime = 0

function animate(time) {
  requestAnimationFrame(animate)
  const delta = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0.016
  lastTime = time
  updateMovement(delta)
  renderer.render(scene, camera)
}

function setupControls() {
  const bind = (id, key) => {
    const el = document.getElementById(id)
    const press = () => { state[key] = true; el.classList.add('pressed') }
    const release = () => { state[key] = false; el.classList.remove('pressed') }

    el.addEventListener('mousedown', press)
    el.addEventListener('mouseup', release)
    el.addEventListener('mouseleave', release)

    el.addEventListener('touchstart', (e) => { e.preventDefault(); press() }, { passive: false })
    el.addEventListener('touchend', (e) => { e.preventDefault(); release() }, { passive: false })
    el.addEventListener('touchcancel', release)
  }

  bind('btn-up', 'forward')
  bind('btn-down', 'backward')
  bind('btn-left', 'turnLeft')
  bind('btn-right', 'turnRight')

  document.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': state.forward = true; e.preventDefault(); break
      case 'ArrowDown': case 'KeyS': state.backward = true; e.preventDefault(); break
      case 'ArrowLeft': case 'KeyA': state.turnLeft = true; e.preventDefault(); break
      case 'ArrowRight': case 'KeyD': state.turnRight = true; e.preventDefault(); break
    }
  })

  document.addEventListener('keyup', (e) => {
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

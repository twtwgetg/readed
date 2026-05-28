import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'

const SPZ_URL = '/scene.spz'
const STORAGE_KEY = 'spark_camera_config'
const MARKERS_KEY = 'spark_markers'

const DEFAULT_CAMERA_CONFIG = {
  yaw: -1.506,
  pitch: 0.15,
  positionX: 0.18931372006272576,
  positionY: 0,
  positionZ: 0.11072000824999695
}

let camera, scene, renderer, spark
let splat = null
let yaw = DEFAULT_CAMERA_CONFIG.yaw
let pitch = DEFAULT_CAMERA_CONFIG.pitch
let moveSpeed = 10
let initialized = false
let spatialGrid = null
let gridMesh = null
let lastCollisionCheck = 0
let isEditMode = false
const COLLISION_RADIUS = 0.5

class SpatialGrid {
  constructor(cellSize = 1.0) {
    this.cellSize = cellSize
    this.grid = new Map()
    this.points = []
  }

  worldToCell(x, y, z) {
    const cx = Math.floor(x / this.cellSize)
    const cy = Math.floor(y / this.cellSize)
    const cz = Math.floor(z / this.cellSize)
    return `${cx},${cy},${cz}`
  }

  insert(x, y, z) {
    const key = this.worldToCell(x, y, z)
    if (!this.grid.has(key)) {
      this.grid.set(key, [])
    }
    this.grid.get(key).push({ x, y, z })
    this.points.push({ x, y, z })
  }

  getNeighbors(x, y, z) {
    const cx = Math.floor(x / this.cellSize)
    const cy = Math.floor(y / this.cellSize)
    const cz = Math.floor(z / this.cellSize)
    const neighbors = []
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = `${cx + dx},${cy + dy},${cz + dz}`
          if (this.grid.has(key)) {
            neighbors.push(...this.grid.get(key))
          }
        }
      }
    }
    return neighbors
  }

  hasPointsInCell(x, y, z) {
    const key = this.worldToCell(x, y, z)
    return this.grid.has(key)
  }
}

function buildSpatialGrid() {
  if (!splat) {
    console.log('[Spark] buildSpatialGrid: splat 未定义')
    return
  }
  
  spatialGrid = new SpatialGrid(1.0)
  
  if (!splat.geometry || !splat.geometry.attributes) {
    console.log('[Spark] buildSpatialGrid: SplatMesh 不支持直接访问点云数据')
    console.log('[Spark] buildSpatialGrid: 使用包围盒采样方法构建网格')
    buildGridFromBoundingBox()
    return
  }
  
  let positions
  try {
    positions = splat.geometry.attributes.position
  } catch (e) {
    console.log('[Spark] buildSpatialGrid: 无法访问 geometry:', e.message)
    return
  }
  
  if (!positions) {
    console.log('[Spark] buildSpatialGrid: positions 不存在')
    console.log('[Spark] buildSpatialGrid: 可用的 attributes:', Object.keys(splat.geometry.attributes || {}))
    return
  }
  
  const count = positions.count
  console.log(`[Spark] buildSpatialGrid: 点数 ${count}`)
  
  if (count === 0 || count === undefined) {
    console.log('[Spark] buildSpatialGrid: 点数为0或undefined，跳过')
    return
  }
  
  for (let i = 0; i < count; i++) {
    spatialGrid.insert(
      positions.getX(i),
      positions.getY(i),
      positions.getZ(i)
    )
  }
  
  console.log(`[Spark] buildSpatialGrid: 格子数 ${spatialGrid.grid.size}`)
  
  if (spatialGrid.grid.size > 0) {
    createGridVisualization()
  }
}

function buildGridFromBoundingBox() {
  let box
  
  if (typeof splat.getBoundingBox === 'function') {
    box = splat.getBoundingBox()
    console.log('[Spark] buildGridFromBoundingBox: 使用 SplatMesh.getBoundingBox()')
  } else {
    box = new THREE.Box3().setFromObject(splat)
    console.log('[Spark] buildGridFromBoundingBox: 使用 THREE.Box3.setFromObject()')
  }
  
  console.log('[Spark] buildGridFromBoundingBox: box:', box)
  
  if (!box || box.isEmpty()) {
    console.log('[Spark] buildGridFromBoundingBox: 包围盒为空')
    return
  }
  
  const cellSize = 1.0
  const min = box.min
  const max = box.max
  
  console.log('[Spark] buildGridFromBoundingBox: min:', min, 'max:', max)
  
  for (let x = Math.floor(min.x / cellSize); x <= Math.ceil(max.x / cellSize); x++) {
    for (let y = Math.floor(min.y / cellSize); y <= Math.ceil(max.y / cellSize); y++) {
      for (let z = Math.floor(min.z / cellSize); z <= Math.ceil(max.z / cellSize); z++) {
        spatialGrid.insert(x * cellSize, y * cellSize, z * cellSize)
      }
    }
  }
  
  console.log(`[Spark] buildGridFromBoundingBox: 格子数 ${spatialGrid.grid.size}`)
  
  if (spatialGrid.grid.size > 0) {
    createGridVisualization()
  }
}

function createGridVisualization() {
  console.log('[Spark] createGridVisualization: 开始创建')
  
  if (!spatialGrid || spatialGrid.grid.size === 0) {
    console.log('[Spark] createGridVisualization: spatialGrid 为空')
    return
  }
  
  if (gridMesh) {
    scene.remove(gridMesh)
    gridMesh.geometry.dispose()
    gridMesh.material.dispose()
    gridMesh = null
  }
  
  const cellSize = spatialGrid.cellSize
  const positions = []
  
  for (const key of spatialGrid.grid.keys()) {
    const [cx, cy, cz] = key.split(',').map(Number)
    const bx = cx * cellSize + cellSize / 2
    const by = cy * cellSize + cellSize / 2
    const bz = cz * cellSize + cellSize / 2
    const h = cellSize / 2
    
    const boxPositions = [
      bx - h, by - h, bz - h,  bx + h, by - h, bz - h,  bx + h, by + h, bz - h,
      bx - h, by - h, bz - h,  bx + h, by + h, bz - h,  bx - h, by + h, bz - h,
      bx - h, by - h, bz + h,  bx + h, by - h, bz + h,  bx + h, by + h, bz + h,
      bx - h, by - h, bz + h,  bx + h, by + h, bz + h,  bx - h, by + h, bz + h,
      bx - h, by + h, bz - h,  bx + h, by + h, bz - h,  bx + h, by + h, bz + h,
      bx - h, by + h, bz - h,  bx + h, by + h, bz + h,  bx - h, by + h, bz + h,
      bx - h, by - h, bz - h,  bx - h, by + h, bz - h,  bx - h, by + h, bz + h,
      bx - h, by - h, bz - h,  bx - h, by + h, bz + h,  bx - h, by - h, bz + h,
      bx + h, by - h, bz - h,  bx + h, by + h, bz - h,  bx + h, by + h, bz + h,
      bx + h, by - h, bz - h,  bx + h, by + h, bz + h,  bx + h, by - h, bz + h,
      bx - h, by - h, bz - h,  bx - h, by - h, bz + h,  bx + h, by - h, bz + h,
      bx - h, by - h, bz - h,  bx + h, by - h, bz + h,  bx + h, by - h, bz - h,
      bx - h, by + h, bz - h,  bx - h, by + h, bz + h,  bx + h, by + h, bz + h,
      bx - h, by + h, bz - h,  bx + h, by + h, bz + h,  bx + h, by + h, bz - h,
      bx - h, by - h, bz + h,  bx - h, by + h, bz + h,  bx + h, by + h, bz + h,
      bx - h, by - h, bz + h,  bx + h, by + h, bz + h,  bx + h, by - h, bz + h,
      bx - h, by - h, bz - h,  bx - h, by + h, bz - h,  bx + h, by + h, bz - h,
      bx - h, by - h, bz - h,  bx + h, by + h, bz - h,  bx + h, by - h, bz - h,
    ]
    positions.push(...boxPositions)
  }
  
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  
  console.log(`[Spark] createGridVisualization: 顶点数 ${positions.length / 3}`)
  
  const material = new THREE.MeshBasicMaterial({
    color: 0x00ff00,
    transparent: true,
    opacity: 0.15,
    wireframe: true
  })
  
  gridMesh = new THREE.Mesh(geometry, material)
  gridMesh.visible = false
  gridMesh.rotateX(-Math.PI / 2)
  scene.add(gridMesh)
  
  console.log(`[Spark] createGridVisualization: 完成，网格已添加到场景`)
}

function mergeGeometries(geometries) {
  const positions = []
  const normals = []
  
  for (const geo of geometries) {
    const pos = geo.attributes.position.array
    const norm = geo.attributes.normal ? geo.attributes.normal.array : null
    
    for (let i = 0; i < pos.length; i++) {
      positions.push(pos[i])
    }
    if (norm) {
      for (let i = 0; i < norm.length; i++) {
        normals.push(norm[i])
      }
    }
  }
  
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  if (normals.length > 0) {
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  }
  
  return merged
}

function toggleGridVisibility(show) {
  if (gridMesh) {
    gridMesh.visible = show
  }
}

function toggleEditMode() {
  isEditMode = !isEditMode
  
  const editBtn = document.getElementById('edit-toggle')
  const editPanel = document.getElementById('rotation-controls')
  
  if (isEditMode) {
    editBtn.textContent = '退出编辑'
    editPanel.style.display = 'flex'
    showMarkerSpheres(true)
    console.log('[Spark] 进入编辑模式')
  } else {
    editBtn.textContent = '编辑'
    editPanel.style.display = 'none'
    showMarkerSpheres(false)
    console.log('[Spark] 退出编辑模式')
  }
}

function showMarkerSpheres(show) {
  scene.traverse((child) => {
    if (child.userData && child.userData.isMarker) {
      child.visible = show
    }
  })
}

function checkCollision(position) {
  if (!spatialGrid) return false
  
  const neighbors = spatialGrid.getNeighbors(position.x, position.y, position.z)
  
  for (const point of neighbors) {
    const dx = position.x - point.x
    const dy = position.y - point.y
    const dz = position.z - point.z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    
    if (dist < COLLISION_RADIUS) {
      return true
    }
  }
  
  return false
}

const state = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  mouseDown: false,
  lastMouse: { x: 0, y: 0 },
  markingMode: false
}

let raycaster = new THREE.Raycaster()
let markerMeshes = []
let markerIndex = 0
let cameraCenter = new THREE.Vector3()

let currentMarker = null
let activeMarker = null
let lastDistanceCheck = 0
let popupTimeout = null

function loadCameraConfig() {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    try {
      const config = JSON.parse(saved)
      yaw = config.yaw || 0
      pitch = config.pitch || 0
      return config
    } catch (e) {
      return null
    }
  }
  return null
}

function saveCameraConfig() {
  const config = {
    yaw: yaw,
    pitch: pitch,
    positionX: camera.position.x,
    positionY: camera.position.y,
    positionZ: camera.position.z,
    splatYaw: splat ? splat.quaternion.y : 0,
    splatPitch: splat ? splat.quaternion.x : 0
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  document.getElementById('save-status').textContent = '已保存'
  setTimeout(() => {
    document.getElementById('save-status').textContent = ''
  }, 2000)
  
  console.log('[Spark] 当前视角已保存:', JSON.stringify(config, null, 2))
}

function saveMarkers() {
  const markers = markerMeshes.map(marker => ({
    positionX: marker.position.x,
    positionY: marker.position.y,
    positionZ: marker.position.z,
    interactionType: marker.userData.interactionType || 'click',
    radius: marker.userData.radius || 2,
    content: marker.userData.content || ''
  }))
  localStorage.setItem(MARKERS_KEY, JSON.stringify(markers))
  document.getElementById('mark-status').textContent = '标注已保存'
  setTimeout(() => {
    document.getElementById('mark-status').textContent = ''
  }, 2000)
  
  console.log('[Spark] 保存标注:', JSON.stringify(markers, null, 2))
}

const DEFAULT_MARKERS = [
  {
    "positionX": 2.2888242107708257,
    "positionY": -0.47286969515932054,
    "positionZ": -1.3115921107767132,
    "interactionType": "proximity",
    "radius": 1,
    "content": "这是一杆三八大盖"
  },
  {
    "positionX": 5.484423010144513,
    "positionY": 1.6596440648421587,
    "positionZ": -0.09812710354593937,
    "interactionType": "click",
    "radius": 2,
    "content": "比较机密的单位才有供电"
  },
  {
    "positionX": 3.8908712570645214,
    "positionY": -0.20181829830031686,
    "positionZ": 1.1625676439693167,
    "interactionType": "click",
    "radius": 2,
    "content": "一张床"
  },
  {
    "positionX": 5.187959499732977,
    "positionY": -0.003335211036597692,
    "positionZ": 0.01843076495278101,
    "interactionType": "click",
    "radius": 2,
    "content": "一张桌子"
  }
]

function createMarker(data) {
  const markerGeometry = new THREE.SphereGeometry(0.3, 16, 16)
  const markerMaterial = new THREE.MeshBasicMaterial({
    color: 0xff9800,
    transparent: true,
    opacity: 0.8
  })
  const marker = new THREE.Mesh(markerGeometry, markerMaterial)
  marker.position.set(data.positionX, data.positionY, data.positionZ)
  marker.userData.index = markerIndex++
  marker.userData.interactionType = data.interactionType || 'click'
  marker.userData.radius = data.radius || 2
  marker.userData.content = data.content || ''
  marker.userData.isMarker = true
  marker.visible = isEditMode
  scene.add(marker)
  markerMeshes.push(marker)
}

function loadMarkers() {
  const saved = localStorage.getItem(MARKERS_KEY)
  if (saved) {
    try {
      const markers = JSON.parse(saved)
      markers.forEach(data => createMarker(data))
      console.log('[Spark] 已加载', markers.length, '个标注')
    } catch (e) {
      console.error('[Spark] 加载本地标注失败，使用默认标注:', e)
      DEFAULT_MARKERS.forEach(data => createMarker(data))
      console.log('[Spark] 已加载', DEFAULT_MARKERS.length, '个默认标注')
    }
  } else {
    console.log('[Spark] 本地无标注数据，使用默认标注')
    DEFAULT_MARKERS.forEach(data => createMarker(data))
    console.log('[Spark] 已加载', DEFAULT_MARKERS.length, '个默认标注')
  }
}

function showMarkerPanel(marker) {
  currentMarker = marker
  document.getElementById('marker-interaction-type').value = marker.userData.interactionType || 'click'
  document.getElementById('marker-radius').value = marker.userData.radius || 2
  document.getElementById('marker-content').value = marker.userData.content || ''
  document.getElementById('marker-panel').classList.add('show')
  updateRadiusGroup()
}

function updateRadiusGroup() {
  const type = document.getElementById('marker-interaction-type').value
  const radiusGroup = document.getElementById('marker-radius-group')
  radiusGroup.style.display = type === 'proximity' ? 'block' : 'none'
}

function hideMarkerPanel() {
  document.getElementById('marker-panel').classList.remove('show')
  currentMarker = null
}

function deleteMarker() {
  if (currentMarker) {
    scene.remove(currentMarker)
    const index = markerMeshes.indexOf(currentMarker)
    if (index > -1) {
      markerMeshes.splice(index, 1)
    }
    hideMarkerPanel()
    console.log('[Spark] 标注已删除')
  }
}

function saveMarkerContent() {
  if (currentMarker) {
    currentMarker.userData.interactionType = document.getElementById('marker-interaction-type').value
    currentMarker.userData.radius = parseFloat(document.getElementById('marker-radius').value) || 2
    currentMarker.userData.content = document.getElementById('marker-content').value
    hideMarkerPanel()
    console.log('[Spark] 标注内容已保存')
  }
}

function showInteractionPopup(marker) {
  if (!marker.userData.content) return
  if (popupTimeout) {
    clearTimeout(popupTimeout)
  }
  document.getElementById('interaction-popup-text').textContent = marker.userData.content
  document.getElementById('interaction-popup').classList.add('show')
  activeMarker = marker
  popupTimeout = setTimeout(() => {
    hideInteractionPopup()
  }, 3000)
}

function hideInteractionPopup() {
  if (popupTimeout) {
    clearTimeout(popupTimeout)
    popupTimeout = null
  }
  document.getElementById('interaction-popup').classList.remove('show')
  activeMarker = null
}

function checkProximity() {
  if (!initialized) return
  const now = Date.now()
  if (now - lastDistanceCheck < 100) return
  lastDistanceCheck = now

  for (const marker of markerMeshes) {
    if (marker.userData.interactionType !== 'proximity') continue
    if (marker === activeMarker) continue

    const dx = camera.position.x - marker.position.x
    const dy = camera.position.y - marker.position.y
    const dz = camera.position.z - marker.position.z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

    if (dist < marker.userData.radius) {
      showInteractionPopup(marker)
      break
    }
  }
}



async function init() {
  const container = document.getElementById('scene-container')

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x111111)

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000)
  camera.position.set(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  container.appendChild(renderer.domElement)

  spark = new SparkRenderer({ renderer })
  scene.add(spark)

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  document.getElementById('loading-text').textContent = '加载模型中...'

  try {
    splat = new SplatMesh({ url: SPZ_URL })
    scene.add(splat)
    
    await splat.initialized

    console.log('[Spark] 加载完成！')

    const box = new THREE.Box3().setFromObject(splat)
    console.log('[Spark] 包围盒:', box)

    const savedConfig = loadCameraConfig()

    if (!box.isEmpty()) {
      const center = new THREE.Vector3()
      const size = new THREE.Vector3()
      box.getCenter(center)
      box.getSize(size)
      console.log('[Spark] 中心:', center)
      console.log('[Spark] 尺寸:', size)
      cameraCenter.copy(center)

      if (savedConfig) {
        camera.position.set(savedConfig.positionX, savedConfig.positionY, savedConfig.positionZ)
        console.log('[Spark] 已加载保存的视角:', savedConfig)
      } else {
        camera.position.set(center.x, center.y + size.y * 0.5, center.z + size.z * 2)
        camera.lookAt(center.x, center.y, center.z)
        console.log('[Spark] 使用默认视角位置')
      }
      moveSpeed = Math.max(size.x, size.y, size.z) * 0.5
      console.log('[Spark] 移动速度:', moveSpeed)
    }

    console.log('[Spark] 模型加载完成，准备渲染...')
    document.getElementById('loading-text').textContent = '准备渲染中...'
    
    splat.rotateX(-Math.PI / 2)
    loadMarkers()
    buildSpatialGrid()
    
    let frameCount = 0
    const checkRenderReady = () => {
      frameCount++
      if (frameCount >= 3) {
        document.getElementById('loading').style.display = 'none'
        console.log('[Spark] 渲染开始！')
        initialized = true
      } else {
        requestAnimationFrame(checkRenderReady)
      }
    }
    requestAnimationFrame(checkRenderReady)

  } catch (error) {
    console.error('[Spark] 加载失败:', error)
    document.getElementById('loading-text').textContent = '加载失败: ' + error.message
  }

  setupControls()
  document.getElementById('save-markers').addEventListener('click', saveMarkers)
  document.getElementById('marker-panel-close').addEventListener('click', hideMarkerPanel)
  document.getElementById('marker-delete-btn').addEventListener('click', deleteMarker)
  document.getElementById('marker-save-btn').addEventListener('click', saveMarkerContent)
  document.getElementById('marker-interaction-type').addEventListener('change', updateRadiusGroup)
  document.getElementById('interaction-popup-close').addEventListener('click', hideInteractionPopup)
  document.getElementById('mark-position').addEventListener('click', () => {
    state.markingMode = !state.markingMode
    console.log('[Spark] 标注模式:', state.markingMode)
    const btn = document.getElementById('mark-position')
    const status = document.getElementById('mark-status')
    if (state.markingMode) {
      btn.classList.add('active')
      status.textContent = '点击场景标注'
    } else {
      btn.classList.remove('active')
      status.textContent = ''
    }
  })
  document.getElementById('save-camera').addEventListener('click', saveCameraConfig)

  document.getElementById('show-grid').addEventListener('change', (e) => {
    toggleGridVisibility(e.target.checked)
  })

  document.getElementById('edit-toggle').addEventListener('click', toggleEditMode)
  document.getElementById('edit-panel-close').addEventListener('click', toggleEditMode)

  const editBtn = document.getElementById('edit-toggle')
  const editPanel = document.getElementById('rotation-controls')
  
  if (isEditMode) {
    editBtn.textContent = '退出编辑'
    editPanel.style.display = 'flex'
    showMarkerSpheres(true)
  } else {
    editBtn.textContent = '编辑'
    editPanel.style.display = 'none'
    showMarkerSpheres(false)
  }

  document.getElementById('show-info').addEventListener('click', () => {
      document.getElementById('info-panel').classList.add('show')
    })

    document.getElementById('info-panel-close').addEventListener('click', () => {
      document.getElementById('info-panel').classList.remove('show')
    })

  function animate() {
    requestAnimationFrame(animate)

    const oldPosition = camera.position.clone()

    if (state.forward) {
      camera.position.x -= Math.sin(yaw) * moveSpeed * 0.016
      camera.position.z -= Math.cos(yaw) * moveSpeed * 0.016
    }
    if (state.backward) {
      camera.position.x += Math.sin(yaw) * moveSpeed * 0.016
      camera.position.z += Math.cos(yaw) * moveSpeed * 0.016
    }
    if (state.left) {
      camera.position.x -= Math.cos(yaw) * moveSpeed * 0.016
      camera.position.z += Math.sin(yaw) * moveSpeed * 0.016
    }
    if (state.right) {
      camera.position.x += Math.cos(yaw) * moveSpeed * 0.016
      camera.position.z -= Math.sin(yaw) * moveSpeed * 0.016
    }

    if (initialized) {
      const now = performance.now()
      if (now - lastCollisionCheck > 100) {
        lastCollisionCheck = now
        if (checkCollision(camera.position)) {
          camera.position.copy(oldPosition)
        }
      }
    }

    if (yawDelta !== 0 || pitchDelta !== 0) {
      yaw += yawDelta
      pitch += pitchDelta
      const minPitch = -40 * Math.PI / 180
      const maxPitch = 50 * Math.PI / 180
      pitch = Math.max(minPitch, Math.min(maxPitch, pitch))
    }

    if (initialized) {
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'))
    }

    checkProximity()
    renderer.render(scene, camera)
  }

  animate()
}

function setupControls() {
  document.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': state.forward = true; break
      case 'KeyS': case 'ArrowDown': state.backward = true; break
      case 'KeyA': case 'ArrowLeft': state.left = true; break
      case 'KeyD': case 'ArrowRight': state.right = true; break
    }
  })

  document.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': state.forward = false; break
      case 'KeyS': case 'ArrowDown': state.backward = false; break
      case 'KeyA': case 'ArrowLeft': state.left = false; break
      case 'KeyD': case 'ArrowRight': state.right = false; break
    }
  })

  renderer.domElement.addEventListener('mousedown', (e) => {
    if (state.markingMode) {
      const rect = renderer.domElement.getBoundingClientRect()
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      )

      raycaster.setFromCamera(mouse, camera)
      const intersects = raycaster.intersectObject(splat)

      if (intersects.length > 0) {
        const point = intersects[0].point
        const markerGeometry = new THREE.SphereGeometry(0.3, 16, 16)
        const markerMaterial = new THREE.MeshBasicMaterial({
          color: 0xff9800,
          transparent: true,
          opacity: 0.8
        })
        const marker = new THREE.Mesh(markerGeometry, markerMaterial)
        marker.position.copy(point)
        marker.userData.index = markerIndex++
        marker.userData.interactionType = 'click'
        marker.userData.radius = 2
        marker.userData.content = ''
        marker.userData.isMarker = true
        marker.visible = isEditMode
        scene.add(marker)
        markerMeshes.push(marker)

        console.log('[Spark] 标注 #' + marker.userData.index + ' 已创建:', {
          position: { x: point.x, y: point.y, z: point.z },
          interactionType: 'click',
          radius: 2
        })
      }
      return
    }

    if (markerMeshes.length > 0) {
      const rect = renderer.domElement.getBoundingClientRect()
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      )
      raycaster.setFromCamera(mouse, camera)
      const markerIntersects = raycaster.intersectObjects(markerMeshes)
      if (markerIntersects.length > 0) {
        const marker = markerIntersects[0].object
        if (isEditMode) {
          showMarkerPanel(marker)
        } else {
          if (marker.userData.interactionType === 'click') {
            if (marker.userData.content) {
              showInteractionPopup(marker)
            }
          }
        }
        return
      }
    }

    state.mouseDown = true
    state.lastMouse.x = e.clientX
    state.lastMouse.y = e.clientY
  })

  document.addEventListener('mouseup', () => {
    state.mouseDown = false
  })

  document.addEventListener('mousemove', (e) => {
    if (!state.mouseDown) return

    const deltaX = e.clientX - state.lastMouse.x
    const deltaY = e.clientY - state.lastMouse.y

    yaw -= deltaX * 0.002
    pitch -= deltaY * 0.002
    pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch))

    state.lastMouse.x = e.clientX
    state.lastMouse.y = e.clientY
  })

  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault())

  setupMobileControls()
}

let yawDelta = 0
let pitchDelta = 0

function setupMobileControls() {
  const joystickStick = document.getElementById('joystick-stick')
  const joystickContainer = document.querySelector('.joystick-container')
  let isDragging = false
  const stickRadius = 40

  joystickContainer.addEventListener('touchstart', (e) => {
    isDragging = true
    updateJoystickPosition(e.touches[0].clientX, e.touches[0].clientY)
  }, { passive: false })

  document.addEventListener('touchmove', (e) => {
    if (isDragging) {
      e.preventDefault()
      updateJoystickPosition(e.touches[0].clientX, e.touches[0].clientY)
    }
  }, { passive: false })

  document.addEventListener('touchend', () => {
    if (isDragging) {
      isDragging = false
      joystickStick.style.transform = 'translate(-50%, -50%)'
      yawDelta = 0
      pitchDelta = 0
    }
  })

  function updateJoystickPosition(clientX, clientY) {
    const rect = joystickContainer.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2

    let deltaX = clientX - centerX
    let deltaY = clientY - centerY
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY)

    const deadZone = 8
    if (distance < deadZone) {
      yawDelta = 0
      pitchDelta = 0
      joystickStick.style.transform = 'translate(-50%, -50%)'
      return
    }

    if (distance > stickRadius) {
      const scale = stickRadius / distance
      deltaX *= scale
      deltaY *= scale
    }

    joystickStick.style.transform = `translate(${deltaX}px, ${deltaY}px)`
    yawDelta = -deltaX * 0.0008
    pitchDelta = -deltaY * 0.0008
  }

  const dpadButtons = document.querySelectorAll('.dpad-btn')
  dpadButtons.forEach(btn => {
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault()
      const direction = btn.dataset.direction
      state[direction] = true
    }, { passive: false })

    btn.addEventListener('touchend', (e) => {
      e.preventDefault()
      const direction = btn.dataset.direction
      state[direction] = false
    }, { passive: false })
  })
}

init()
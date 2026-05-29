import * as THREE from 'three'
import { SplatMesh, SplatFileType } from '@sparkjsdev/spark'

const SPZ_URL = 'https://cdn.jsdelivr.net/gh/twtwgetg/readed@main/dist/scene.spz'

let camera, scene, renderer
let splatMesh = null
let yaw = 0
let moveSpeed = 2
const ROT_SPEED = 1.8

const state = { 
  forward: false, 
  backward: false, 
  turnLeft: false, 
  turnRight: false, 
  loaded: false 
}

async function initSpark() {
  const $ = id => document.getElementById(id)
  const progressBar = $('loading-progress')
  const percentEl = $('loading-percent')
  percentEl.textContent = '加载模型...'
  
  const response = await fetch(SPZ_URL)
  const buffer = await response.arrayBuffer()
  
  progressBar.style.width = '60%'
  
  splatMesh = new SplatMesh({
    fileBytes: buffer,
    fileType: SplatFileType.SPZ
  })
  
  await splatMesh.initialized
  
  scene.add(splatMesh)
  
  console.log('[Spark] 加载完成')
  
  progressBar.style.width = '100%'
  percentEl.textContent = '完成'

  const bbox = splatMesh.getBoundingBox()
  console.log('[Spark] 包围盒:', bbox)
  
  if (!bbox || bbox.isEmpty()) {
    console.error('[Spark] 包围盒为空！')
    return
  }

  const cx = (bbox.min.x + bbox.max.x) / 2
  const cy = (bbox.min.y + bbox.max.y) / 2
  const cz = (bbox.min.z + bbox.max.z) / 2
  const sx = bbox.max.x - bbox.min.x
  const sy = bbox.max.y - bbox.min.y
  const sz = bbox.max.z - bbox.min.z
  const size = Math.max(sx, sy, sz)
  
  console.log('[Spark] 包围盒中心:', { cx, cy, cz })
  console.log('[Spark] 包围盒尺寸:', { sx, sy, sz, size })
  
  camera.far = Math.max(500, size * 2.5)
  camera.updateProjectionMatrix()
  moveSpeed = Math.max(1, size * 0.4)

  const distance = size * 1.5
  camera.position.set(cx + distance, cy + distance * 0.3, cz + distance)
  yaw = Math.atan2(-(cx - camera.position.x), -(cz - camera.position.z))
  
  console.log('[Spark] 相机位置:', camera.position)
  
  camera.lookAt(cx, cy, cz)

  setTimeout(() => {
    $('loading').classList.add('hidden')
    state.loaded = true
    console.log('[Spark] 场景加载完成')
  }, 300)
}

function initScene() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x1a1a2e)

  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000)

  renderer = new THREE.WebGLRenderer({ antialias: true })
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

function animate(time) {
  requestAnimationFrame(animate)

  if (state.loaded && splatMesh) {
    const delta = 1 / 60
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

    splatMesh.update({ 
      object: splatMesh,
      camera, 
      renderer,
      renderSize: new THREE.Vector2(innerWidth, innerHeight),
      time: time / 1000,
      deltaTime: delta,
      viewToWorld: camera.matrixWorld,
      globalEdits: []
    })
  }

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
    el.addEventListener('touchstart', e => { e.preventDefault(); press() }, { passive: false })
    el.addEventListener('touchend', e => { e.preventDefault(); release() }, { passive: false })
    el.addEventListener('touchcancel', release)
  }
  
  bind('btn-up', 'forward')
  bind('btn-down', 'backward')
  bind('btn-left', 'turnLeft')
  bind('btn-right', 'turnRight')

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
initSpark().catch(err => {
  console.error('[Spark] 错误:', err)
  document.querySelector('.loading-text').textContent = '加载失败: ' + err.message
})
animate()
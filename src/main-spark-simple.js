import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'

const SPZ_URL = 'https://cdn.jsdelivr.net/gh/twtwgetg/readed@main/dist/scene.spz'

let camera, scene, renderer
let spark = null

async function init() {
  const container = document.getElementById('scene-container')

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x111111)

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000)
  camera.position.set(0, 2, 5)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  container.appendChild(renderer.domElement)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.05
  controls.target.set(0, 0, 0)

  spark = new SparkRenderer({ renderer })
  scene.add(spark)

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  document.getElementById('loading-text').textContent = '加载模型中...'

  try {
    const splat = new SplatMesh({ url: SPZ_URL })
    splat.quaternion.set(1, 0, 0, 0)
    splat.position.set(0, 0, -3)
    scene.add(splat)

    console.log('[Spark] 加载完成！')

    const box = new THREE.Box3().setFromObject(splat)
    console.log('[Spark] 包围盒:', box)

    if (!box.isEmpty()) {
      const center = new THREE.Vector3()
      const size = new THREE.Vector3()
      box.getCenter(center)
      box.getSize(size)
      console.log('[Spark] 中心:', center)
      console.log('[Spark] 尺寸:', size)

      const maxDim = Math.max(size.x, size.y, size.z)
      camera.position.set(center.x + maxDim * 2, center.y + maxDim, center.z + maxDim * 2)
      controls.target.copy(center)
      controls.update()
    }

    document.getElementById('loading').style.display = 'none'
    console.log('[Spark] 渲染开始！')

  } catch (error) {
    console.error('[Spark] 加载失败:', error)
    document.getElementById('loading-text').textContent = '加载失败: ' + error.message
  }

  function animate() {
    requestAnimationFrame(animate)
    controls.update()
    renderer.render(scene, camera)
  }

  animate()
}

init()
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import './DorocoBadgePreview.css'

function roundedRect(width, height, radius) {
  const x = -width / 2, y = -height / 2
  const shape = new THREE.Shape()
  shape.moveTo(x + radius, y)
  shape.lineTo(x + width - radius, y)
  shape.quadraticCurveTo(x + width, y, x + width, y + radius)
  shape.lineTo(x + width, y + height - radius)
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  shape.lineTo(x + radius, y + height)
  shape.quadraticCurveTo(x, y + height, x, y + height - radius)
  shape.lineTo(x, y + radius)
  shape.quadraticCurveTo(x, y, x + radius, y)
  return shape
}

function pinOutline() {
  const s = new THREE.Shape()
  s.moveTo(-2.32, -3.03)
  s.lineTo(2.32, -3.03)
  s.quadraticCurveTo(2.55, -3.03, 2.55, -2.8)
  s.lineTo(2.55, 2.18)
  s.lineTo(1.72, 3.04)
  s.lineTo(-1.72, 3.04)
  s.lineTo(-2.55, 2.18)
  s.lineTo(-2.55, -2.8)
  s.quadraticCurveTo(-2.55, -3.03, -2.32, -3.03)
  return s
}

function trapezoid(top, bottom, height) {
  const s = new THREE.Shape()
  s.moveTo(-bottom / 2, -height / 2)
  s.lineTo(bottom / 2, -height / 2)
  s.lineTo(top / 2, height / 2)
  s.lineTo(-top / 2, height / 2)
  s.closePath()
  return s
}

function material(color, { metalness = 0, roughness = .3, clearcoat = .25 } = {}) {
  return new THREE.MeshPhysicalMaterial({ color, metalness, roughness, clearcoat, clearcoatRoughness: .12 })
}

function extrude(shape, depth, mat, x, y, z, bevel = .04) {
  const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSegments: 3, bevelSize: bevel, bevelThickness: bevel, curveSegments: 32 }), mat)
  mesh.position.set(x, y, z)
  return mesh
}

function titleTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 220
  const c = canvas.getContext('2d')
  c.clearRect(0, 0, canvas.width, canvas.height)
  c.fillStyle = '#fff1bc'
  c.font = '800 104px Arial Black, Arial'
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.fillText('DOROCO TOWN', 600, 117)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function DorocoBadgePreview() {
  const mountRef = useRef(null)

  useEffect(() => {
    const mount = mountRef.current
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(31, 1, .1, 100)
    camera.position.set(0, 0, 11)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    renderer.setSize(mount.clientWidth, mount.clientWidth)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.25
    mount.appendChild(renderer.domElement)

    const pin = new THREE.Group()
    pin.rotation.z = -.055
    scene.add(pin)

    const gold = material('#d69a38', { metalness: 1, roughness: .14, clearcoat: .85 })
    const goldLight = material('#ffe09a', { metalness: .94, roughness: .11, clearcoat: 1 })
    const blackNickel = material('#171b1b', { metalness: .92, roughness: .19, clearcoat: .55 })
    const enamelTeal = material('#146b61', { roughness: .17, clearcoat: 1 })
    const enamelDeep = material('#0b3e41', { roughness: .2, clearcoat: .85 })
    const enamelCoral = material('#d24c38', { roughness: .16, clearcoat: 1 })
    const enamelAmber = material('#f1aa35', { roughness: .14, clearcoat: 1 })
    const enamelMint = material('#7fc89e', { roughness: .16, clearcoat: 1 })
    const enamelPale = material('#d9edba', { roughness: .14, clearcoat: 1 })
    const enamelLeaf = material('#438957', { roughness: .18, clearcoat: .9 })

    // Outer die, black-nickel shadow channel, and deep enamel field.
    const base = extrude(pinOutline(), .31, gold, 0, 0, -.22, .13)
    const channel = extrude(roundedRect(4.69, 5.59, .42), .2, blackNickel, 0, -.1, .12, .09)
    const field = extrude(roundedRect(4.37, 5.27, .31), .13, enamelDeep, 0, -.1, .34, .055)
    pin.add(base, channel, field)

    const goldLine = (w, h, x, y, z = .53) => {
      const line = extrude(roundedRect(w, h, h / 2), .065, goldLight, x, y, z, .018)
      pin.add(line)
      return line
    }

    // Top sun medallion with a raised gold bezel and twelve pressed rays.
    const sunBack = new THREE.Mesh(new THREE.CylinderGeometry(.86, .86, .13, 56), blackNickel)
    sunBack.position.set(-1.25, 1.78, .48); pin.add(sunBack)
    const sunBezel = new THREE.Mesh(new THREE.CylinderGeometry(.76, .76, .15, 56), gold)
    sunBezel.position.set(-1.25, 1.78, .61); pin.add(sunBezel)
    const sun = new THREE.Mesh(new THREE.CylinderGeometry(.65, .65, .11, 56), enamelCoral)
    sun.position.set(-1.25, 1.78, .76); pin.add(sun)
    const core = new THREE.Mesh(new THREE.CylinderGeometry(.28, .28, .07, 40), enamelAmber)
    core.position.set(-1.25, 1.78, .88); pin.add(core)
    for (let i = 0; i < 12; i++) {
      const ray = extrude(trapezoid(.08, .18, .34), .06, enamelAmber, -1.25, 1.78, .85, .012)
      const angle = i * Math.PI / 6
      ray.position.x += Math.cos(angle) * .46
      ray.position.y += Math.sin(angle) * .46
      ray.rotation.z = angle + Math.PI / 2
      pin.add(ray)
    }

    // Arched gold molding uses 3D curve points so its raised metal tube stays renderable.
    const makeArc = (rx, ry, z) => new THREE.CatmullRomCurve3(Array.from({ length: 25 }, (_, index) => {
      const angle = Math.PI * .1 + index / 24 * Math.PI * .8
      return new THREE.Vector3(Math.cos(angle) * rx, .62 + Math.sin(angle) * ry, z)
    }))
    const tube = new THREE.Mesh(new THREE.TubeGeometry(makeArc(1.82, 1.86, .73), 48, .065, 10, false), goldLight)
    pin.add(tube)
    const tubeInner = new THREE.Mesh(new THREE.TubeGeometry(makeArc(1.62, 1.64, .76), 48, .025, 8, false), gold)
    pin.add(tubeInner)

    // The container greenhouse: a coral industrial base under a mint glass roof.
    const container = extrude(roundedRect(3.34, .88, .11), .17, enamelCoral, .16, .4, .56, .055)
    pin.add(container)
    const containerCap = extrude(roundedRect(3.48, .12, .06), .08, gold, .16, .88, .76, .02)
    pin.add(containerCap)
    for (let i = 0; i < 5; i++) goldLine(.05, .68, -1.12 + i * .64, .39, .77)
    for (let i = 0; i < 3; i++) {
      const door = extrude(roundedRect(.31, .47, .035), .04, blackNickel, -.84 + i * 1.17, .34, .77, .018)
      pin.add(door)
      goldLine(.03, .38, -.84 + i * 1.17, .34, .83)
    }

    const greenhouse = extrude(trapezoid(2.37, 3.08, 1.33), .16, enamelMint, .16, 1.27, .59, .04)
    pin.add(greenhouse)
    const roofLip = extrude(trapezoid(2.5, 3.22, 1.44), .045, goldLight, .16, 1.27, .77, .018)
    pin.add(roofLip)
    // A second glass surface restores the inset enamel channel inside the gold greenhouse mold.
    const glassInset = extrude(trapezoid(2.25, 2.85, 1.14), .052, enamelPale, .16, 1.27, .83, .018)
    pin.add(glassInset)
    for (let i = 0; i < 5; i++) {
      const strut = goldLine(.055, 1.1, -1.0 + i * .59, 1.25, .91)
      strut.rotation.z = -.17
    }
    for (let i = 0; i < 3; i++) goldLine(2.46 - i * .18, .045, .16, .88 + i * .36, .92)

    // Planter band: deliberately irregular leaves make the miniature settlement read as alive.
    const planter = extrude(roundedRect(3.73, .45, .16), .11, blackNickel, .12, -.88, .58, .06)
    const planterFace = extrude(roundedRect(3.5, .28, .1), .07, enamelLeaf, .12, -.88, .74, .035)
    pin.add(planter, planterFace)
    const leafShape = new THREE.Shape()
    leafShape.moveTo(0, 0); leafShape.quadraticCurveTo(.14, .35, .36, .12); leafShape.quadraticCurveTo(.18, -.04, 0, 0)
    for (let i = 0; i < 12; i++) {
      const leaf = extrude(leafShape, .045, i % 3 === 0 ? enamelPale : enamelMint, -1.55 + i * .285, -.68 + (i % 2) * .08, .83, .015)
      leaf.rotation.z = (i % 2 ? .65 : -.4)
      pin.add(leaf)
    }

    // Floating logistics drone, built as a separate raised metal-and-enamel miniature.
    const drone = new THREE.Group()
    const droneBody = extrude(roundedRect(.74, .25, .11), .1, gold, 0, 0, 0, .04)
    const droneCore = extrude(roundedRect(.52, .13, .055), .06, enamelDeep, 0, 0, .11, .025)
    drone.add(droneBody, droneCore)
    for (const x of [-.43, .43]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(.32, .045, .055), goldLight); arm.position.x = x / 2; arm.position.z = .08; drone.add(arm)
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(.15, .15, .055, 24), gold); rotor.position.set(x, 0, .12); drone.add(rotor)
    }
    const lens = new THREE.Mesh(new THREE.SphereGeometry(.065, 16, 10), enamelMint); lens.position.set(-.1, -.06, .18); drone.add(lens)
    drone.position.set(1.48, 1.9, 1.04); pin.add(drone)

    // Lower title cartouche; a tangible brass sign rather than text floating on the art.
    const plaque = extrude(roundedRect(3.7, .68, .23), .13, gold, 0, -2.13, .64, .07)
    const plaqueChannel = extrude(roundedRect(3.45, .46, .15), .075, blackNickel, 0, -2.13, .79, .04)
    pin.add(plaque, plaqueChannel)
    const label = new THREE.Mesh(new THREE.PlaneGeometry(3.12, .33), new THREE.MeshBasicMaterial({ map: titleTexture(), transparent: true, toneMapped: false }))
    label.position.set(0, -2.13, .9); pin.add(label)

    // Pin maker marks and sparkle cuts.
    for (const [x, y, size] of [[-1.88, -2.33, .06], [1.88, -2.35, .05], [1.89, .26, .045], [-1.83, 2.48, .04], [1.85, 2.28, .055]]) {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(size), goldLight)
      star.position.set(x, y, .9); pin.add(star)
    }

    const glints = []
    for (let i = 0; i < 14; i++) {
      const sparkle = new THREE.Mesh(new THREE.OctahedronGeometry(.025 + Math.random() * .04), new THREE.MeshBasicMaterial({ color: '#fff4bf', transparent: true }))
      const angle = Math.random() * Math.PI * 2
      const radius = 2.55 + Math.random() * .18
      sparkle.position.set(Math.cos(angle) * radius * .8, Math.sin(angle) * radius * 1.06, 1.04)
      sparkle.userData.phase = Math.random() * 6.28
      pin.add(sparkle); glints.push(sparkle)
    }

    scene.add(new THREE.HemisphereLight('#bffff2', '#100606', 1.9))
    const key = new THREE.DirectionalLight('#fff1c7', 4.4); key.position.set(-3.4, 4.5, 5.2); scene.add(key)
    const rimLight = new THREE.PointLight('#83f5d3', 10, 8); rimLight.position.set(3, 1.5, 4); scene.add(rimLight)
    const warmLight = new THREE.PointLight('#ff7a42', 7, 7); warmLight.position.set(-2.5, -2, 3); scene.add(warmLight)

    let targetX = 0, targetY = 0
    const move = (event) => {
      const rect = mount.getBoundingClientRect()
      targetY = ((event.clientX - rect.left) / rect.width - .5) * .54
      targetX = ((event.clientY - rect.top) / rect.height - .5) * .32
    }
    const leave = () => { targetX = 0; targetY = 0 }
    mount.addEventListener('pointermove', move)
    mount.addEventListener('pointerleave', leave)
    const resize = () => renderer.setSize(mount.clientWidth, mount.clientWidth)
    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    const clock = new THREE.Clock()
    let frame
    const animate = () => {
      const time = clock.getElapsedTime()
      pin.rotation.y += (targetY - pin.rotation.y) * .05
      pin.rotation.x += (targetX - pin.rotation.x) * .05
      pin.rotation.z += ((-.055 + Math.sin(time * .48) * .012) - pin.rotation.z) * .025
      pin.position.y = Math.sin(time * .75) * .045
      drone.position.y = 1.9 + Math.sin(time * 2.2) * .045
      key.position.x = -3.4 + Math.sin(time * .55) * 3.6
      glints.forEach((sparkle) => sparkle.scale.setScalar(Math.max(.12, .45 + Math.sin(time * 2.7 + sparkle.userData.phase) * .7)))
      renderer.render(scene, camera)
      frame = requestAnimationFrame(animate)
    }
    animate()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      mount.removeEventListener('pointermove', move)
      mount.removeEventListener('pointerleave', leave)
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  return <main className="doroco-page">
    <a className="doroco-back" href="?home">← 返回首页</a>
    <div className="doroco-layout">
      <section className="doroco-copy">
        <p className="doroco-kicker">COLLECTOR ENAMEL PIN / 01</p>
        <h1>多洛可小镇</h1>
        <p>末日中的最后绿洲被压进一枚收藏级珐琅别针：橘红工业集装箱承托玻璃温室，太阳、绿植和无人机共同构成持续运转的小镇系统。</p>
        <div className="doroco-notes"><span>立体镀金模具</span><span>凹陷珐琅槽</span><span>微缩叙事主景</span></div>
        <small>移动鼠标，观察金属模具、釉面与浮雕细节的光线变化。</small>
      </section>
      <section className="doroco-stage"><div className="doroco-glow"/><div className="doroco-canvas" ref={mountRef}/></section>
    </div>
  </main>
}

export default DorocoBadgePreview

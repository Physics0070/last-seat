import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, PerspectiveCamera, Points, Scene, ShaderMaterial, WebGLRenderer } from 'three'

const COUNT = 10_000
const CLUSTERS = 60
const MAX_DPR = 1.5
const SLOW_FRAME_MS = 24 // below ~42 fps
const SLOW_FRAMES_BEFORE_DEGRADE = 45

// mulberry32, so the sky looks the same on every visit.
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 10,000 points in ONE draw call. Each point has two positions: drifting alone (`position`) and
 * gathered into a constellation (`target`). The vertex shader blends between them with `uGather`,
 * which follows page scroll, so the CPU does no per-point work per frame.
 */
export function startSky(canvas: HTMLCanvasElement) {
  const rand = prng(7)
  const scattered = new Float32Array(COUNT * 3)
  const gathered = new Float32Array(COUNT * 3)
  const seeds = new Float32Array(COUNT)
  const centres = Array.from({ length: CLUSTERS }, () => [(rand() - 0.5) * 16, (rand() - 0.5) * 9, (rand() - 0.5) * 6])
  for (let i = 0; i < COUNT; i++) {
    scattered.set([(rand() - 0.5) * 22, (rand() - 0.5) * 13, (rand() - 0.5) * 10], i * 3)
    const c = centres[i % CLUSTERS]
    const r = Math.pow(rand(), 2) * 1.1
    const a = rand() * Math.PI * 2
    const b = Math.acos(2 * rand() - 1)
    gathered.set([c[0] + r * Math.sin(b) * Math.cos(a), c[1] + r * Math.sin(b) * Math.sin(a), c[2] + r * Math.cos(b)], i * 3)
    seeds[i] = rand()
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(scattered, 3))
  geometry.setAttribute('target', new BufferAttribute(gathered, 3))
  geometry.setAttribute('seed', new BufferAttribute(seeds, 1))

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uGather: { value: 0 }, uPulse: { value: 0 }, uScale: { value: 1 }, uCool: { value: new Color() }, uWarm: { value: new Color() } },
    vertexShader: /* glsl */ `
      attribute vec3 target;
      attribute float seed;
      uniform float uTime, uGather, uPulse, uScale;
      varying float vAlpha;
      varying float vWarm;
      void main() {
        // Points gather at slightly different moments so the motion reads as people arriving, not a zoom.
        float g = smoothstep(seed * 0.5, seed * 0.5 + 0.5, uGather);
        vec3 p = mix(position, target, g);
        p.y += sin(uTime * 0.25 + seed * 40.0) * 0.12 * (1.0 - g);
        p.x += cos(uTime * 0.2 + seed * 31.0) * 0.12 * (1.0 - g);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float twinkle = 0.65 + 0.35 * sin(uTime * (0.6 + seed) + seed * 90.0);
        vWarm = step(0.985, seed) + abs(uPulse) * step(0.9, seed);
        vAlpha = twinkle * (0.35 + 0.65 * g) + abs(uPulse) * 0.4;
        gl_PointSize = uScale * (1.4 + seed * 2.2 + vWarm * 2.0 + uPulse * 2.0) * (7.0 / -mv.z);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCool, uWarm;
      varying float vAlpha;
      varying float vWarm;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float glow = smoothstep(0.5, 0.0, d);
        vec3 color = mix(uCool, uWarm, clamp(vWarm, 0.0, 1.0));
        gl_FragColor = vec4(color, glow * glow * vAlpha);
      }`,
  })

  // Star colours follow the active palette: read the CSS tokens now and again whenever the theme attribute changes.
  function readPalette() {
    const css = getComputedStyle(document.documentElement)
    material.uniforms.uCool.value.set(css.getPropertyValue('--star').trim())
    material.uniforms.uWarm.value.set(css.getPropertyValue('--accent').trim())
  }
  readPalette()
  const paletteWatcher = new MutationObserver(readPalette)
  paletteWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  const scene = new Scene()
  const points = new Points(geometry, material)
  scene.add(points)
  const camera = new PerspectiveCamera(55, 1, 0.1, 50)
  camera.position.z = 9
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' })

  let dpr = Math.min(window.devicePixelRatio, MAX_DPR)
  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas
    renderer.setPixelRatio(dpr)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    material.uniforms.uScale.value = dpr * Math.min(1, h / 700 + 0.3)
  }
  resize()
  window.addEventListener('resize', resize)

  let gather = 0
  let pulse = 0
  let frame = 0
  let last = performance.now()
  let slowFrames = 0
  let level = 0 // 0 = full, 1 = lower resolution, 2 = half the points

  function tick(now: number) {
    frame = requestAnimationFrame(tick)
    const dt = now - last
    last = now

    // Automatic quality control: if frames stay slow, first drop resolution, then draw half the points.
    slowFrames = dt > SLOW_FRAME_MS ? slowFrames + 1 : Math.max(0, slowFrames - 1)
    if (slowFrames > SLOW_FRAMES_BEFORE_DEGRADE && level < 2) {
      level++
      slowFrames = 0
      if (level === 1) dpr = 1
      else geometry.setDrawRange(0, COUNT / 2)
      resize()
    }

    const max = document.documentElement.scrollHeight - window.innerHeight
    const targetGather = max > 200 ? Math.min(1, window.scrollY / Math.min(max, window.innerHeight * 1.5)) : 0.55
    gather += (targetGather - gather) * Math.min(1, dt / 300)
    pulse *= Math.pow(0.002, dt / 1000)

    material.uniforms.uTime.value = now / 1000
    material.uniforms.uGather.value = gather
    material.uniforms.uPulse.value = pulse
    // The camera travels with the story: it moves in and tilts as the points gather.
    points.rotation.y = now / 60000 + gather * 0.6
    points.rotation.x = gather * 0.22
    camera.position.z = 9 - gather * 2.6
    renderer.render(scene, camera)
  }

  // Never render when nobody can see it.
  function onVisibility() {
    cancelAnimationFrame(frame)
    if (!document.hidden) {
      last = performance.now()
      frame = requestAnimationFrame(tick)
    }
  }
  document.addEventListener('visibilitychange', onVisibility)
  onVisibility()

  return {
    /** +1 when someone joins (a warm flash), -1 when a team dissolves (points shrink back). */
    pulse(direction: 1 | -1) {
      pulse = direction * 0.9
    },
    dispose() {
      cancelAnimationFrame(frame)
      paletteWatcher.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', resize)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
    },
  }
}

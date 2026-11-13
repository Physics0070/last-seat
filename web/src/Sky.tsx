import { useEffect, useRef, useState } from 'react'
import { useApp } from './app'

const supportsWebGL = () => {
  try {
    return !!document.createElement('canvas').getContext('webgl2')
  } catch {
    return false
  }
}

/**
 * The night sky behind every page. Decorative only: aria-hidden, pointer-events none; everything it
 * shows is also in the DOM (the board list, the status bar announcements).
 *
 * A static CSS star field is always rendered first, so the page paints and is usable immediately.
 * The WebGL layer (three.js, its own chunk) is loaded on first interaction and only if motion is allowed
 * and WebGL exists; otherwise the CSS version simply stays.
 */
export function Sky() {
  const { reducedMotion, onLive } = useApp()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (reducedMotion || !canvas.current || !supportsWebGL()) return
    let disposed = false
    let cleanup = () => {}
    // The 3D chunk is fetched on the visitor's first interaction (move, scroll, touch, key), never during
    // page load. Until then, and on a device nobody is touching, the CSS sky costs nothing.
    const wake = ['pointermove', 'pointerdown', 'touchstart', 'keydown', 'scroll'] as const
    const stopWaiting = () => wake.forEach((type) => window.removeEventListener(type, start))
    async function start() {
      stopWaiting()
      const { startSky } = await import('./skyGL')
      if (disposed || !canvas.current) return
      const sky = startSky(canvas.current)
      const stopLive = onLive((e) => {
        if (e.type === 'member.joined' || e.type === 'team.created') sky.pulse(1)
        else if (e.type === 'team.deleted') sky.pulse(-1)
      })
      setActive(true)
      cleanup = () => {
        stopLive()
        sky.dispose()
      }
    }
    wake.forEach((type) => window.addEventListener(type, start, { once: true, passive: true }))
    return () => {
      disposed = true
      stopWaiting()
      cleanup()
      setActive(false)
    }
  }, [reducedMotion, onLive])

  return (
    <div className="sky" aria-hidden="true">
      <div className={`sky-static${active ? ' hidden' : ''}`} />
      <canvas ref={canvas} className={active ? 'visible' : ''} />
    </div>
  )
}

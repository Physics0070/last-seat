import { LazyMotion, MotionConfig, m, useMotionValueEvent, useScroll, useSpring, useTransform } from 'motion/react'
import { useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from './app'

const loadMotion = () => import('./motionFeatures').then((mod) => mod.default)

/**
 * The landing page is the only page that uses the animation library, so the page and the library load as their own
 * chunk: the board and team pages never parse or evaluate it.
 */
export default function Landing() {
  const { reducedMotion } = useApp()
  return (
    <LazyMotion features={loadMotion} strict>
      <MotionConfig reducedMotion={reducedMotion ? 'always' : 'never'}>
        <LandingStory />
      </MotionConfig>
    </LazyMotion>
  )
}

function LandingStory() {
  const { user, meta, reducedMotion } = useApp()
  const { minTeamSize, maxTeamSize, name } = meta.hackathon
  // Everything on this page is driven by scroll position. With reduced motion none of it is applied:
  // the same content is simply laid out, visible, in order.
  const { scrollY, scrollYProgress } = useScroll()
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 30 })
  const heroOpacity = useTransform(scrollY, [0, 520], [1, 0])
  const heroY = useTransform(scrollY, [0, 520], [0, -90])
  const heroScale = useTransform(scrollY, [0, 520], [1, 0.93])
  const join = user ? '/board' : '/signup'

  return (
    <div className="landing">
      {!reducedMotion && <m.div className="scroll-progress" style={{ scaleX: progress }} aria-hidden="true" />}

      <m.section className="hero" style={reducedMotion ? undefined : { opacity: heroOpacity, y: heroY, scale: heroScale }}>
        <p className="eyebrow">{name}</p>
        <h1>Find your team before the last seat is gone.</h1>
        <p className="lede">
          Ten thousand people, one night sky. Every point of light is someone looking for a team of {minTeamSize} to {maxTeamSize}.
        </p>
        <div className="actions">
          <Link className="btn primary large" to={join}>{user ? 'Open the board' : 'Join the hackathon'}</Link>
          <Link className="btn ghost large" to="/board">Watch teams form live</Link>
        </div>
        <p className="scroll-cue" aria-hidden="true">Scroll</p>
      </m.section>

      <Beat index={0} title="Alone, you are a point of light.">
        <p>Say what you are good at and where in the world you are. That is all the board needs to start matching you.</p>
      </Beat>
      <Beat index={1} title="Together, you are a constellation.">
        <p>Paste an invite code and you are in instantly. Or ask a team from the board and let its leader say yes. Everyone watching sees it happen as it happens.</p>
      </Beat>

      <SeatScene seats={maxTeamSize} />

      <Beat index={2} title="The last seat belongs to exactly one person.">
        <p>When fifty people reach for it in the same instant, one gets it and forty-nine are told so, immediately and honestly, with the next best teams to try.</p>
        <div className="actions">
          <Link className="btn primary large" to={join}>{user ? 'Find a team' : 'Take your seat'}</Link>
        </div>
      </Beat>
    </div>
  )
}

/** One story section. It slides in from its side as it climbs the viewport, with a large numeral drifting behind it. */
function Beat({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  const { reducedMotion } = useApp()
  const ref = useRef<HTMLElement>(null)
  const { scrollYProgress: arriving } = useScroll({ target: ref, offset: ['start 0.95', 'start 0.5'] })
  const { scrollYProgress: passing } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const x = useTransform(arriving, [0, 1], [index % 2 ? 90 : -90, 0])
  const y = useTransform(arriving, [0, 1], [70, 0])
  const numeralY = useTransform(passing, [0, 1], [140, -140])
  return (
    <section ref={ref} className="beat">
      <m.span className="beat-number" aria-hidden="true" style={reducedMotion ? undefined : { y: numeralY }}>0{index + 1}</m.span>
      <m.div className="beat-body" style={reducedMotion ? undefined : { opacity: arriving, x, y }}>
        <h2>{title}</h2>
        {children}
      </m.div>
    </section>
  )
}

/**
 * A pinned scene: the page holds still while scrolling fills a team's seats one at a time,
 * ending on the last seat. The text carries the story; the dots are decoration.
 */
function SeatScene({ seats }: { seats: number }) {
  const { reducedMotion } = useApp()
  const ref = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] })
  const [filled, setFilled] = useState(1)
  useMotionValueEvent(scrollYProgress, 'change', (v) => setFilled(Math.min(seats, 1 + Math.floor(v * seats))))

  const shown = reducedMotion ? seats : filled
  const line =
    shown >= seats ? 'Taken. Exactly once.' : shown === seats - 1 ? 'One seat left. Fifty people are looking at it.' : 'A team starts with one person and an idea.'
  return (
    <section ref={ref} className={`scene${reducedMotion ? ' still' : ''}`} style={reducedMotion ? undefined : { height: `${seats * 55 + 100}vh` }}>
      <div className="scene-pin">
        <div className={`scene-seats${shown === seats - 1 ? ' last' : ''}`} aria-hidden="true">
          {Array.from({ length: seats }, (_, i) => <span key={i} className={i < shown ? 'big-seat on' : 'big-seat'} />)}
        </div>
        <p className="scene-count">{shown} of {seats} seats taken</p>
        <h2>{line}</h2>
      </div>
    </section>
  )
}

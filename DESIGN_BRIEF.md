# Design brief: The Last Seat

**Concept.** The hackathon is a night sky. Each participant is a point of light; a team is a constellation. The product is named after its one tense moment: a team with a single seat left.

**Principle.** The sky is atmosphere, never interface. Everything a person needs is plain, fast, accessible HTML in front of it.

**Palette.** Deep navy `#070b1a` background, `#10162e` surfaces, `#edf0ff` text, `#aab4d6` secondary text (8.9:1 on the background). One accent, warm gold `#ffc857`, reserved for the primary action, the leader and the last seat.

**Type.** Space Grotesk for headings, Inter for text, both self-hosted variable fonts with `font-display: swap`. Fluid scale from 0.875rem to 4.25rem.

**Layout.** One column up to 68rem. Cards on an auto-fill grid that collapses to a single column on phones. 44px minimum touch targets.

**Motion.** Three durations (120, 260, 700 ms) and one easing curve, all CSS tokens. Motion confirms a change (a seat filling, a member appearing, a page arriving) and never blocks input. One switch, "Reduce motion", turns all of it off and is initialised from the system setting.

**The sky.** 10,000 points in one draw call. Scrolling the landing page gathers them from drift into constellations. A join makes them flash warm; a deleted team makes them recede. The three.js chunk loads on the visitor's first interaction, caps device pixel ratio at 1.5, stops when the tab is hidden, and lowers its own quality if frames slow down. Without WebGL, or with reduced motion, a static CSS star field stays in its place.

**Signature moments.**
- *Last seat:* gold border, a "Last seat" badge, the empty seat dot beckons.
- *Losing the race:* no error shake. A star drifts off, a calm panel explains, and the next best teams are offered.
- *Team page:* members drawn as a constellation, lines from the leader, open seats as dashed outlines.

**Accessibility.** Keyboard-operable throughout with visible focus; skip link; focus moves to the page on navigation; native `<dialog>`; every live change is announced through a polite live region; the canvas and constellation are `aria-hidden` with the same information in lists beside them.

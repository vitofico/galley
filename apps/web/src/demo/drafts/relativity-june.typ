// History draft — /relativity.typ as it stood on 30 June 1905: the kinematics
// complete, the mass–energy question explicitly LEFT OPEN. Version 4 of the
// demo history appends the September addendum below this text, so comparing
// the June and September versions shows E = mc² being written.

#let accent = rgb("#f0510e")
#let ink-soft = rgb("#6a6155")

= On the Electrodynamics of Moving Bodies

#text(size: 8.5pt, fill: ink-soft, tracking: 0.12em)[
  ANNALEN DER PHYSIK · RECEIVED 30 JUNE 1905
]
#v(0.5em)

It is known that Maxwell's electrodynamics @maxwell1865, applied to moving
bodies, leads to asymmetries which do not attach to the phenomena: the
current induced between a magnet and a conductor depends only on their
_relative_ motion, yet the theory tells two different stories according to
which one is "at rest." Add to this the failure of every attempt to detect a
motion of the earth through the supposed ether @michelson1887, and the notion
of absolute rest becomes not merely undetectable but superfluous. Two plain
demands sweep it away.

== The two postulates

#block(inset: (left: 0.95em), stroke: (left: 1.5pt + accent), above: 0.8em, below: 0.8em)[
  #set par(first-line-indent: 0em, leading: 0.66em)
  *I.~The principle of relativity.*~~The laws of physics take the same form
  in every inertial frame; no experiment confined to such a frame can
  disclose its uniform motion. \
  *II.~The invariance of light.*~~In empty space light advances at one
  definite speed $c$, the same for every observer, whatever the motion of
  its source.
]

== The Lorentz transformation

Let a frame move with velocity $v$ along the common $x$-axis of a second
frame, and demand that a single flash of light spread as a sphere of radius
$c t$ in _both_ frames. The coordinates are then forced to mix. Writing the
factor

$ gamma = 1 / sqrt(1 - v^2 / c^2) $

the resting coordinates $(t, x)$ and the moving ones $(t', x')$ are bound by

$ x' = gamma (x - v t), quad t' = gamma (t - (v x) / c^2) $

while the transverse coordinates pass untouched, $y' = y$, $z' = z$. Herr
Lorentz reached these same equations from the side of the electron theory
@lorentz1904; here they follow from kinematics alone. Two events judged
simultaneous in one frame are in general _not_ simultaneous in the other ---
an arithmetic fact, not a paradox. The geometry of cause and effect that the
transformation carves out of spacetime is drawn in @lightcone.

== Addition of velocities

If a body moves with speed $u$ along $x$ in the moving frame, its speed $w$
in the resting frame is not the naive sum $u + v$ but

$ w = (u + v) / (1 + (u v) / c^2) $

The formula carries its own guardian: set $u = c$ and the right-hand side
collapses to $c$ exactly. Light overtakes no observer, and nothing material
crosses the barrier that $c$ marks.

Whether the _inertia_ of a body depends upon its energy-content is a question
the postulates seem competent to decide; it must be left to a further
communication.

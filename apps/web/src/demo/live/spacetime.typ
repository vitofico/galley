// Appendix — a private geometric sketch: the light cone of an event, drawn
// with pure built-in vector primitives (no packages). Carries the <lightcone>
// label that /relativity.typ cross-references. Included from /main.typ.

#let ink-soft = rgb("#6a6155")
#let ink-faint = rgb("#9a9082")
#let accent = rgb("#f0510e")
#let teal = rgb("#0f8f86")
#let paper = rgb("#fffdf8")
#let line-soft = rgb("#d8cdb8")

= A Sketch of Space and Time

#text(size: 8.5pt, fill: ink-soft, tracking: 0.12em)[
  PRIVATE NOTE · NOT FOR THE ANNALEN
]
#v(0.5em)

If the velocity of light bounds every signal, then each event divides the
world. Draw time upward and space across: the two rays of light through an
event run at forty-five degrees, and between them lie all the happenings the
event can ever cause or have been caused by.

// The drawing region: a square S wide, event O at the centre. Coordinates run
// from (-1, -1) lower-left to (+1, +1) upper-right; xy(u, v) maps that frame
// onto canvas lengths. Time points UP, space RIGHT.
#let S = 6.8cm
#let half = S / 2
#let xy(u, v) = (half + u * half, half - v * half)

// Sample points of a worldline — always steeper than the light lines, so it
// stays timelike throughout.
#let world = (
  (-0.85, -0.92), (-0.55, -0.62), (-0.32, -0.34),
  (-0.14, -0.13), (0, 0), (0.16, 0.16), (0.34, 0.38),
  (0.52, 0.66), (0.66, 0.94),
)
#let wpt(p) = xy(p.at(0), p.at(1))

#figure(
  caption: [
    The light cone of an event. The diagonals are the paths of light; they
    bound the event's _future_ (above) and _past_ (below). A worldline ---
    always rising more steeply than light --- threads from the past, through
    the event, into the future, never straying into the spacelike wings.
  ],
  box(
    width: S,
    height: S,
    fill: paper,
    stroke: 0.6pt + line-soft,
    radius: 2pt,
    inset: 0pt,
  )[
    // -- future light cone (translucent vermilion wedge) ------------------
    #place(top + left)[
      #polygon(
        fill: accent.transparentize(86%),
        stroke: none,
        xy(0, 0), xy(1, 1), xy(-1, 1),
      )
    ]
    // -- past light cone ---------------------------------------------------
    #place(top + left)[
      #polygon(
        fill: ink-faint.transparentize(82%),
        stroke: none,
        xy(0, 0), xy(1, -1), xy(-1, -1),
      )
    ]

    // -- axes (space = horizontal, time = vertical) ------------------------
    #place(top + left)[
      #line(start: xy(-1, 0), end: xy(1, 0), stroke: 0.7pt + ink-faint)
    ]
    #place(top + left)[
      #line(start: xy(0, -1), end: xy(0, 1), stroke: 0.7pt + ink-faint)
    ]

    // -- the two light rays (45-degree null lines) --------------------------
    #place(top + left)[
      #line(start: xy(-1, -1), end: xy(1, 1), stroke: 1pt + accent)
    ]
    #place(top + left)[
      #line(start: xy(1, -1), end: xy(-1, 1), stroke: 1pt + accent)
    ]

    // -- the curved, accelerating worldline ---------------------------------
    #place(top + left)[
      #curve(
        stroke: 1.4pt + teal,
        fill: none,
        curve.move(wpt(world.first())),
        ..world.slice(1).map(p => curve.line(wpt(p))),
      )
    ]

    // -- the event O at the origin -------------------------------------------
    #place(top + left, dx: xy(0, 0).at(0) - 3.2pt, dy: xy(0, 0).at(1) - 3.2pt)[
      #circle(radius: 3.2pt, fill: accent, stroke: 1pt + paper)
    ]

    // -- labels ---------------------------------------------------------------
    #place(top + left, dx: xy(0, 1).at(0) + 4pt, dy: xy(0, 1).at(1) - 2pt)[
      #text(size: 0.82em, fill: ink-soft, style: "italic")[time]
    ]
    #place(top + left, dx: xy(1, 0).at(0) - 30pt, dy: xy(1, 0).at(1) + 5pt)[
      #text(size: 0.82em, fill: ink-soft, style: "italic")[space]
    ]
    #place(top + left, dx: xy(0.5, 1).at(0) + 3pt, dy: xy(0.5, 1).at(1) + 6pt)[
      #text(size: 0.8em, fill: accent)[light cone]
    ]
    #place(top + left, dx: xy(0.66, 0.94).at(0) + 4pt, dy: xy(0.66, 0.94).at(1))[
      #text(size: 0.8em, fill: teal)[worldline]
    ]
    #place(top + left, dx: xy(0, 0).at(0) + 7pt, dy: xy(0, 0).at(1) - 2pt)[
      #text(size: 0.8em, weight: 600, fill: accent)[event]
    ]
  ],
) <lightcone>

In this geometry the separation of two events is not a distance but an
_interval_ --- the quantity $(c t)^2 - x^2$ --- on whose sign all observers
agree. Points within the cone stand in possible cause and effect; points
outside are forever beyond reach, since no signal outruns the light that
rules the cone's slope. The sketch is less a picture of where things are than
of what can ever touch what.

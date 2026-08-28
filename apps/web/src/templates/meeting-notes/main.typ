// Meeting notes / memo — a single-file template built only from built-in Typst,
// so it compiles offline in the fail-closed worker and under the math-font-less
// gate. Edit the field block and the sections below; the layout (a titled header
// strip, an attendee/metadata grid, and an action-item table) is laid out by
// plain `#set`/`#grid`/`#table` rules.

#let accent = rgb("#b25a00")
#let ink = rgb("#1b1b1b")
#let ink-soft = rgb("#5b5b5b")
#let line-soft = rgb("#d8d8d4")
#let strip-bg = rgb("#fff4e6")

// ── Fields ──────────────────────────────────────────────────────────────────
#let meeting = (
  title: "Q3 Planning Sync",
  date: "9 June 2026",
  time: "10:00 – 10:45",
  location: "Room 4B / video",
  facilitator: "Morgan Lee",
  attendees: ("Morgan Lee", "Alex Recipient", "Sam Rivera", "Jordan Kim"),
)

// ── Page + type ──────────────────────────────────────────────────────────────
#set page(paper: "a4", margin: (x: 2.4cm, y: 2.4cm))
#set text(font: "New Computer Modern", size: 10.5pt, fill: ink)
#set par(justify: false, leading: 0.66em)
#show heading: set text(size: 11.5pt, weight: 700, fill: accent)
#show heading: it => { v(0.7em); it; v(0.25em) }

// ── Header strip ──────────────────────────────────────────────────────────────
#block(
  width: 100%,
  fill: strip-bg,
  inset: (x: 1em, y: 0.8em),
  radius: 5pt,
)[
  #text(size: 8.5pt, fill: accent, tracking: 0.14em)[MEETING NOTES]
  #v(0.15em)
  #text(size: 17pt, weight: 700)[#meeting.title]
]

#v(0.6em)

// ── Metadata grid ───────────────────────────────────────────────────────────
#grid(
  columns: (auto, 1fr),
  row-gutter: 0.4em,
  column-gutter: 1em,
  text(weight: 600, fill: ink-soft)[Date], [#meeting.date · #meeting.time],
  text(weight: 600, fill: ink-soft)[Location], [#meeting.location],
  text(weight: 600, fill: ink-soft)[Facilitator], [#meeting.facilitator],
  text(weight: 600, fill: ink-soft)[Attendees], [#meeting.attendees.join(", ")],
)

= Agenda
+ Review Q2 outcomes against the targets we set in March.
+ Lock the top three Q3 objectives and their owners.
+ Surface blockers that need a decision before next week.

= Discussion
Q2 landed broadly on plan: latency work shipped and the offline seam is in
production. The main risk for Q3 is reviewer bandwidth — two large efforts
(templates breadth and the sync rollout) want the same two reviewers.

We agreed to stagger them: templates merge first, then sync starts once the
gate is green, so review load never overlaps.

= Decisions
- *Stagger the two big efforts* rather than run them concurrently. (Owner: Morgan)
- *Add a second on-call reviewer* for the sync rollout window. (Owner: Alex)

= Action items
#table(
  columns: (1fr, auto, auto),
  align: (left, left, left),
  stroke: none,
  inset: (x: 0.8em, y: 0.45em),
  fill: (_, row) => if row == 0 { strip-bg } else if calc.odd(row) { rgb("#fbfbfa") } else { none },
  table.header(
    text(weight: 700)[Action],
    text(weight: 700)[Owner],
    text(weight: 700)[Due],
  ),
  [Publish the staggered timeline], [Morgan], [11 Jun],
  [Confirm second reviewer], [Alex], [12 Jun],
  [Draft the sync rollout checklist], [Sam], [16 Jun],
)

#v(1fr)
#line(length: 100%, stroke: 0.4pt + line-soft)
#v(0.3em)
#text(size: 8.5pt, fill: ink-soft, style: "italic")[
  Edit the `meeting` field block at the top, then fill in the sections. Add rows
  to the action-item table as decisions land.
]

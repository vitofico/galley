// Curriculum vitae — a single-file résumé built only from built-in Typst, so it
// compiles offline in the fail-closed worker and under the math-font-less gate.
// Edit the field block at the top and the section entries below; the layout (a
// two-column header, ruled section headings, and dated entries) is laid out by
// the small `entry`/`section` helpers.

#let accent = rgb("#2c5f4f")
#let ink = rgb("#1b1b1b")
#let ink-soft = rgb("#5b5b5b")
#let line-soft = rgb("#d8d8d4")

// ── Fields ──────────────────────────────────────────────────────────────────
#let me = (
  name: "Morgan Avery Lee",
  title: "Numerical Software Engineer",
  email: "morgan.lee@example.com",
  phone: "+44 20 7946 0991",
  site: "morganlee.dev",
  city: "Cambridge, UK",
)

// ── Page + type ──────────────────────────────────────────────────────────────
#set page(paper: "a4", margin: (x: 2.2cm, top: 2.0cm, bottom: 2.0cm))
#set text(font: "New Computer Modern", size: 10pt, fill: ink)
#set par(justify: false, leading: 0.62em)

// A ruled section heading reused for each block below.
#let section(title) = {
  v(0.9em)
  text(size: 11pt, weight: 700, fill: accent, tracking: 0.06em)[#upper(title)]
  v(0.25em)
  line(length: 100%, stroke: 0.6pt + line-soft)
  v(0.5em)
}

// One dated entry: role + org on the left, dates flush right, then details.
#let entry(role, org, dates, body) = {
  block(spacing: 0.55em)[
    #grid(
      columns: (1fr, auto),
      align: (left, right),
      [#text(weight: 600)[#role] #h(0.4em) #text(fill: ink-soft)[· #org]],
      text(size: 9pt, fill: ink-soft)[#dates],
    )
    #v(0.15em)
    #body
  ]
}

// ── Header ────────────────────────────────────────────────────────────────────
#grid(
  columns: (1fr, auto),
  align: (left + horizon, right + horizon),
  [
    #text(size: 20pt, weight: 700)[#me.name]
    #v(0.1em)
    #text(size: 11pt, fill: accent)[#me.title]
  ],
  text(size: 9pt, fill: ink-soft)[
    #me.email \
    #me.phone \
    #link("https://" + me.site)[#me.site] \
    #me.city
  ],
)
#v(0.3em)
#line(length: 100%, stroke: 1pt + accent)

#section("Profile")
Numerical software engineer with eight years building fast, well-tested solvers
for the browser and the desktop. I care about correctness proofs that survive
contact with floating point, and about tooling that keeps a team's feedback loop
under a second.

#section("Experience")
#entry("Senior Engineer", "Galley Typesetting", "2022 – present")[
  - Cut median in-browser compile latency from $480$ to $190$ #h(0.1em) ms by
    moving font decoding off the critical path.
  - Designed the fail-closed package seam that keeps offline documents building
    when the network is gone.
]
#entry("Engineer", "Acme Research Institute", "2018 – 2022")[
  - Shipped an adaptive ODE integrator used across three product teams.
  - Mentored four junior engineers through their first production launches.
]

#section("Education")
#entry("M.Sc. Applied Mathematics", "University of Cambridge", "2016 – 2018")[
  Thesis on the convergence rate of preconditioned fixed-point iteration,
  $|x_n - x^*| <= L^n |x_0 - x^*|$ with $L < 1$.
]
#entry("B.Sc. Computer Science", "University of Oxford", "2013 – 2016")[
  First-class honours. Focus on numerical methods and compilers.
]

#section("Skills")
#grid(
  columns: (auto, 1fr),
  row-gutter: 0.4em,
  column-gutter: 1em,
  text(weight: 600)[Languages], [Rust, TypeScript, Python, C++],
  text(weight: 600)[Domains], [Numerical analysis, WASM, real-time collaboration],
  text(weight: 600)[Tools], [Typst, Git, Docker, Playwright],
)

#v(1fr)
#align(center, text(size: 8pt, fill: ink-soft, style: "italic")[
  Edit the `me` field block and the entries above to make this CV your own.
])

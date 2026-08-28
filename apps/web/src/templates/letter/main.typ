// Formal letter — a single-file template built only from built-in Typst, so it
// compiles offline in the fail-closed worker. Replace the fields at the top and
// the body; the layout (sender block, date, inside address, salutation, and
// signature) is laid out by plain `#set`/`#align` rules below.

#let accent = rgb("#1f3a5f")
#let ink = rgb("#1b1b1b")
#let ink-soft = rgb("#5b5b5b")
#let line-soft = rgb("#d8d8d4")

// ── Fields ──────────────────────────────────────────────────────────────────
#let sender = (
  name: "Jane Q. Sender",
  street: "14 Riverside Walk",
  city: "Cambridge CB2 1RX",
  email: "jane.sender@example.com",
)
#let recipient = (
  name: "Dr. Alex Recipient",
  org: "Acme Research Institute",
  street: "1 Innovation Way",
  city: "Oxford OX1 2JD",
)
#let place-date = "Cambridge, 9 June 2026"
#let subject = "Application for the Research Fellowship"

// ── Page + type ──────────────────────────────────────────────────────────────
#set page(paper: "a4", margin: (x: 2.6cm, top: 2.4cm, bottom: 2.4cm))
#set text(font: "New Computer Modern", size: 11pt, fill: ink)
#set par(justify: true, leading: 0.68em)

// ── Sender, right-aligned ────────────────────────────────────────────────────
#align(right, block(spacing: 0.4em)[
  #set par(justify: false, leading: 0.55em)
  #text(weight: 600)[#sender.name] \
  #text(size: 9.5pt, fill: ink-soft)[
    #sender.street \
    #sender.city \
    #link("mailto:" + sender.email)[#sender.email]
  ]
])

#v(0.8em)

// ── Inside address, left ─────────────────────────────────────────────────────
#block[
  #set par(justify: false, leading: 0.55em)
  #recipient.name \
  #recipient.org \
  #recipient.street \
  #recipient.city
]

#v(0.6em)
#align(right, text(fill: ink-soft)[#place-date])
#v(0.4em)

#text(weight: 600)[Subject: #subject]
#v(0.2em)
#line(length: 100%, stroke: 0.5pt + line-soft)
#v(0.6em)

// ── Body ─────────────────────────────────────────────────────────────────────
Dear Dr.~Recipient,

I am writing to apply for the Research Fellowship advertised by the Acme
Research Institute. Having followed your group's work on numerical methods for
several years, I am keen to contribute to the questions your team is pursuing.

My background is in the analysis of iterative solvers, where I have studied the
conditions under which fixed-point schemes converge and the rates they achieve.
I believe this work aligns closely with the Institute's current direction, and I
would welcome the chance to discuss how it might support your projects.

I have enclosed my curriculum vitae and would be glad to provide references on
request. Thank you for considering my application; I look forward to hearing
from you.

#v(0.8em)
Yours sincerely,
#v(1.6em)
#text(weight: 600)[#sender.name]

#v(1fr)
#align(center, text(size: 8.5pt, fill: ink-soft, style: "italic")[
  Edit the field block at the top of the file to address your own letter.
])

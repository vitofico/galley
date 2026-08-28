// Problem set / homework — a two-file template. `main.typ` supplies the content;
// the look and the `problem` / `solution` helpers live in `/style.typ`, which
// this file `#import`s (proving virtual cross-file resolution). Pure built-in
// Typst with real math mode ($...$) — NewCMMath is bundled, so the relations
// typeset with proper glyphs and compile offline in the fail-closed worker.

#import "/style.typ": pset, problem, solution

#show: pset.with(
  course: "MATH 215 · Real Analysis",
  title: "Problem Set 4 — Sequences & Series",
  author: "Morgan Lee",
  due: "9 June 2026",
)

#problem(points: 10)[
  Let $(a_n)$ be defined by $a_1 = 1$ and $a_(n+1) = 1 + 1 \/ a_n$. Show that the
  sequence is bounded and that any limit $L$ must satisfy $L = 1 + 1 \/ L$, hence
  $L = (1 + sqrt(5)) \/ 2$.

  #solution[
    By induction $1 <= a_n <= 2$ for all $n$: $a_1 = 1$, and if $1 <= a_n <= 2$
    then $a_(n+1) = 1 + 1 \/ a_n in [1.5, 2]$. Taking limits in the recurrence
    gives $L = 1 + 1 \/ L$, i.e. $L^2 - L - 1 = 0$, whose positive root is the
    golden ratio $phi = (1 + sqrt(5)) \/ 2 approx 1.618$.
  ]
]

#problem(points: 8)[
  Decide whether the series converges and justify your answer:
  $ sum_(n=1)^infinity 1 / (n (n + 1)). $

  #solution[
    Telescoping: $1 \/ (n(n+1)) = 1 \/ n - 1 \/ (n+1)$, so the partial sum is
    $S_N = 1 - 1 \/ (N + 1) -> 1$. The series *converges* to $1$.
  ]
]

#problem(points: 12)[
  Prove that if $sum a_n$ converges absolutely then $sum a_n^2$ converges.
  (Hint: for all but finitely many $n$, $|a_n| < 1$, so $a_n^2 <= |a_n|$.)

  #solution[
    Since $sum |a_n|$ converges, $a_n -> 0$, so there is $N$ with $|a_n| < 1$ for
    $n >= N$. Then $a_n^2 = |a_n|^2 <= |a_n|$ for those $n$, and by comparison
    $sum_(n >= N) a_n^2$ converges; adding the finitely many earlier terms keeps
    the whole series convergent. $square.stroked$
  ]
]

#v(0.6em)
#line(length: 100%, stroke: 0.4pt + rgb("#d8d8d4"))
#v(0.3em)
#text(size: 8.5pt, fill: rgb("#5b5b5b"))[
  Add a problem by calling `#problem[...]` — the counter advances automatically.
  Wrap your worked answer in `#solution[...]`, or delete those blocks to hand
  out a blank assignment. Restyle everything from `/style.typ`.
]

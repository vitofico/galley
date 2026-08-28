## What & why

<!-- What does this PR change, and why? Link the issue if there is one. -->

## Checklist

- [ ] The Docker green-gate passes locally:
      `docker compose -f docker-compose.test.yml run --rm --build test`
      (host `pnpm test` alone is not authoritative)
- [ ] Tests cover the change (loop logic uses the fake model + fake compiler)
- [ ] Existing `data-testid`s and asserted copy are preserved (or the e2e specs
      are updated in the same PR)
- [ ] Docs updated alongside any cross-package type or behavioral-contract
      change; significant/hard-to-reverse decisions get an ADR
- [ ] Respects the invariants in [`AGENTS.md`](../AGENTS.md)
      (human Accept gate, scratch isolation, framework-agnostic cores,
      no secrets in logs)
- [ ] No AI-attribution boilerplate in commits or this PR
- [ ] **First contribution?** State: *"I have read and agree to the Galley CLA
      (CLA.md), version 1.0."*

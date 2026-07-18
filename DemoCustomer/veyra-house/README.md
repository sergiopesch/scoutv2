# Veyra House — fictional Scout demo customer

Veyra House is a fictional private performance-and-recovery club created to make the Scout demonstration concrete, visual, and buildable. It is not a real company, venue, customer, or endorsement.

The site is deliberately excellent at brand storytelling and deliberately fragmented at conversion. Its three booking paths—training, treatment, and guest ritual—are individually plausible but do not deliver the “one continuous rhythm” promised by the brand. That gap gives a live Scout conversation something useful to discover.

## Run the site

The public Codex Sites deployment is available at
[veyra-house-demo.sergiopesch.chatgpt.site](https://veyra-house-demo.sergiopesch.chatgpt.site).

From this directory:

```sh
node server.mjs
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173).

The site also works when `index.html` is opened directly. The local server is preferable for the demo and browser testing.

## Demo materials

- [`CUSTOMER_ROLE.md`](CUSTOMER_ROLE.md) — the fictional customer persona and evidence bank for the person playing the customer.
- [`DEMO_RUNBOOK.md`](DEMO_RUNBOOK.md) — the presenter sequence, expected Scout moments, and final Codex build target.
- `concepts/` — approved visual concepts used as the implementation specification.
- `assets/` — project-local production imagery generated for this fictional brand.

## Intended proof of value

The discovery should converge on a **Unified Visit Planner**: a read-only website flow that composes training, thermal ritual, and bodywork from existing availability while preserving member priority and excluding sensitive wellness data. It should deep-link into existing systems rather than replace them.

That proposal must remain a recommendation until the customer validates the supporting claims and explicitly approves a bounded handoff.

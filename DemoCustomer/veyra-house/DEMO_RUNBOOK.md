# Scout demo runbook — Veyra House

Everything in this scenario is fictional. The live conversation is the evidence source; this runbook is presenter preparation, not a customer record.

## The story in one sentence

Veyra’s website promises an integrated wellness journey, but its systems, operating rules, and customer language are fragmented; Scout helps the room turn that ambiguity into a safe, bounded website proof of value while the customer is still present.

## Why this scenario shows Scout well

- The website supplies visual evidence, not just spoken requirements.
- Multiple people, systems, processes, policies, goals, and frictions form a meaningful graph.
- Two apparently factual statements conflict and must coexist until clarified.
- One enticing metric remains explicitly unvalidated.
- A privacy boundary rules out an overreaching implementation.
- The best recommendation is not “replace everything”; it is a small read-only intervention.
- The final Codex handoff has crisp acceptance criteria and negative scope.

## Recommended six-minute sequence

### 0:00–0:35 — Establish the customer

Open the Veyra website at `http://127.0.0.1:4173` and show the promise “Train hard. Return whole.” Scroll to “A day shaped around you” and point out the three separate booking actions without judging them yet.

Say:

> This is Veyra House, a fictional premium performance and recovery club. I am not bringing Scout a requirements document. I am bringing it a customer conversation and the customer’s own digital experience.

### 0:35–2:30 — Let the model form

Start a fresh Scout discovery session with the customer’s explicit consent. Ask:

1. “What is the experience you want the website to create?”
2. “What happens today when someone wants the full morning shown here?”
3. “Which systems and teams are involved?”

Look for Scout to separate and link:

- **People:** guest, member, host, Mara/Experience, Jon/Club Operations.
- **Systems:** website, Mindbody, Book4Time, HubSpot, clinical intake record.
- **Process:** discover → choose practices → check three calendars → confirm → hand off.
- **Friction:** three entry points, manual cross-calendar composition, unclear eligibility.
- **Goal:** eligible guest morning in under two minutes without degrading member access.

### 2:30–3:30 — Make trust visible

Invite the customer to state that day rituals are “open to everyone.” Then ask how member priority works. When the second statement narrows the first, pause on Scout’s evidence and trust surfaces.

Narrate:

> Scout does not silently rewrite the first statement or choose the more convenient interpretation. The utterances and claims remain inspectable until a human records the rule that resolves them.

When the customer mentions the 63% abandonment figure, show that it remains a customer estimate requiring validation.

### 3:30–4:15 — Use the gaps

Let Scout propose the next questions. Strong questions include:

- Who owns the guest-capacity rule across systems?
- What exact fields may the planner read?
- Does the two-minute target end before payment?
- Which location, practices, and member-priority window are in scope?
- Who accepts the proof?

Ask one or two while the customer is still present and let the graph improve.

### 4:15–5:10 — Show a proposed future without laundering it into fact

The strongest candidate should be:

**Unified Visit Planner**

> Read availability for London training, thermal ritual, and bodywork; apply the approved guest/member eligibility rule; compose one eligible itinerary; then deep-link to the system that owns each booking.

Keep it visibly proposed. Confirm these boundaries with the customer:

- London only.
- Read-only availability.
- No payments.
- No clinical or wellness-intake data.
- No booking-platform replacement.
- Twenty-four-hour member priority preserved.
- Club Operations owns the capacity rule.

### 5:10–6:00 — Approve and hand off

Review the exact evidence closure and approve only the bounded candidate. Hand the approved context pack to Codex.

The first build should replace the fragmented “View class times / Book a treatment / Request a day ritual” moment with one accessible **Plan your visit** flow backed by local fixture availability. It should produce an eligible itinerary and clear deep links, not pretend to integrate live systems during the demo.

Close with:

> The customer did not wait weeks to discover what we misunderstood. They saw the model, the uncertainty, the constraint and the proposed experience take shape in the first conversation—and Codex received only what the room approved.

## Expected action-pack acceptance criteria

1. A guest can select London, a preferred date, and any combination of Train, Ritual, and Restore.
2. The planner uses only fixture service IDs, times, availability, and membership status.
3. Results respect a configurable twenty-four-hour member-priority release rule.
4. An eligible itinerary appears in under two minutes of user interaction.
5. Each step identifies the booking system that owns final confirmation.
6. The proof performs no write-back and collects no injury, stress, treatment-history, or clinical fields.
7. The flow is keyboard accessible, mobile responsive, and clearly labels unavailable or members-only practices.
8. Analytics events measure planner start, itinerary produced, and handoff selected without including wellness data.

## Do not accidentally claim

- That Veyra House is real.
- That the 63% signal is verified.
- That Scout automatically resolves contradictions.
- That the proposed planner already exists as a customer fact.
- That a production integration or clinical-data review has occurred.
- That approval covers anything beyond the exact context pack shown.

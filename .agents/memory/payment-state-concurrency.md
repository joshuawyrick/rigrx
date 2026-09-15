---
name: Payment state concurrency
description: Durable safety rules for asynchronous payment and refund state transitions.
---

Every asynchronous payment result must be fenced to the exact attempt that originated it. Once a payment intent is bound, a concurrent creation error cannot invalidate that attempt. Refund recovery must reuse one durable idempotency identity and verify the provider's final refund status.

**Why:** Controlled race tests reproduced double charges when delayed creation results could overwrite newer attempts, and false refund completion when an accepted refund had not actually succeeded.

**How to apply:** When changing purchase or refund flows, preserve attempt-key checks on every delayed write, never replace a bound external payment ID, and keep unknown external outcomes pending until reconciliation retrieves a terminal state.
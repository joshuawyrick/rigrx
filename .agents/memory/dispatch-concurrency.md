---
name: Dispatch concurrency
description: Durable rules for preventing delayed dispatch actions, membership races, and lost operational alerts.
---

Every assignment command must carry both the assignment version it was based on and a durable command identity. Every action that revokes an assignment must advance that version, even when the job becomes unassigned.

**Why:** A command can arrive for the first time after a decline, timeout, removal, or newer assignment. Command deduplication alone cannot reject a delayed first execution; the version fence must change on every revocation.

**How to apply:** Any future assignment-clearing path must increment the fence. Assignment entry points must compare the expected fence under the same lock as the state change and record the command identity transactionally.

Company membership eligibility, assignment, and company archival must share a company-level locking barrier. Membership state must also be revalidated inside technician action transactions.

**Why:** Per-technician locking does not stop a new or reactivated technician from appearing while a whole company is being archived, and middleware snapshots can become stale before an action commits.

**How to apply:** Take the active company barrier before creating, reactivating, disabling, assigning, or archiving members. Whole-company archival must recover affected jobs and archive all members in one coordinated transaction.

Operational notification intent and exception visibility must commit with the state or alarm flag that requires them. Rearmable alarms need a generation in their dedupe identity.

**Why:** A process crash after committing a lifecycle or alarm flag but before recording its notification can permanently hide the event. Reusing one dedupe key also suppresses later valid alarms after recovery and relapse.

**How to apply:** Write outbox rows and exceptions in the lifecycle transaction. Increment an alarm generation whenever a silence or stall alarm is rearmed and include it in notification dedupe keys.

Every recipient intent must exist before a related business transition can be considered committed; delivery happens only after all intents are durable.

**Why:** Enqueuing recipients one-by-one during delivery or after purchase/request commit leaves a crash window where later recipients are never recorded and replay cannot recover them.

**How to apply:** Determine recipients and enqueue the full fan-out in the state transaction. On replay, ensure any expected intent exists by a stable business-event key before returning.

Delayed outbox rows must be checked against the lifecycle occurrence they describe, not merely claimed exactly once.

**Why:** A perfectly fenced worker can still deliver an obsolete assignment, ETA, revocation, rescue, or alarm after newer state makes its message dangerous or contradictory.

**How to apply:** Put the relevant assignment version, recipient, or lifecycle generation in the payload; supersede pending/sending snapshots during transitions and revalidate applicability immediately before provider delivery.

Outbox delivery claims require a unique lease identity. Only the current lease may finalize success or failure, and rows must be claimed immediately before delivery rather than held in a waiting batch.

**Why:** An expired worker can finish after a reclaim and otherwise overwrite a newer successful attempt. Pre-claiming a batch also lets later leases expire before delivery starts.

**How to apply:** Fence finalization and lease heartbeats by the claim identity, commit notification-failure exception changes with finalization, and claim each row only when its send is about to begin.

Notification dedupe identities must represent one user action or lifecycle occurrence, not merely the resulting value. Replays reuse that identity; later legitimate occurrences get a new durable generation or command identity.

**Why:** Values such as an ETA can repeat in separate updates, and the same company can be selected again after a reopen. Value-based keys silently suppress later notifications.

**How to apply:** Require a durable command identity for repeatable same-state actions. Use lifecycle generations for repeatable transitions, and keep the identity stable only for transport retries of that one occurrence.

Any company explicitly alerted about a lead must retain durable eligibility to see that lead even when a rescue search expanded beyond its normal radius.

**Why:** Sending an alert without persisting the expanded match leads users to an empty feed and makes the rescue action ineffective.

**How to apply:** Persist successful matching eligibility before alert delivery, and make discovery honor either current radius eligibility or that recorded match.

An on-scene technician cannot be disabled, removed, or archived until the job is completed or explicitly handed off.

**Why:** Returning an arrived job to ordinary dispatch misrepresents the real-world state, while removing access strands unfinished work with no valid actor.

**How to apply:** Lock on-scene assignments during membership changes and abort the entire membership or company-archive transaction with an actionable conflict.

Lifecycle-dependent exception mutations belong in the same request-locking transaction as the transition, never in route work that waits for delivery.

**Why:** A delayed route can resume after a newer recovery transition and accidentally resolve or recreate the newer exception.

**How to apply:** Routes may process delivery and push refresh hints after commit, but they must not change lifecycle exceptions. Keep those writes in the dispatch transaction.

Administrative exception actions must be fenced to the occurrence the admin actually reviewed.

**Why:** Rescue and alarm producers may renew an existing queue row while an admin still has an older view; resolving by row ID alone can hide the renewed emergency.

**How to apply:** Increment a durable occurrence whenever a producer renews an exception, and require that occurrence on acknowledge or resolve.

Account archival and any operation that creates work for that account must share the same account-row barrier.

**Why:** Authentication middleware is only a snapshot. Without revalidation under the archival lock, a previously authenticated request can create new work after archival finishes.

**How to apply:** Lock and revalidate the active account in the same transaction before creating requests or memberships. Archival locks the account first, then handles all existing work before marking it inactive.

Use an account-before-request lock hierarchy, with account eligibility barriers held `FOR NO KEY UPDATE`.

**Why:** Opposite explicit lock order deadlocks account actions, while `FOR UPDATE` also conflicts unnecessarily with foreign-key key-share checks from request events and exceptions.

**How to apply:** Acquire driver/company/technician barriers before request locks. Reserve `FOR UPDATE` for rows whose keys need that strength; use no-key-update for account-field serialization.
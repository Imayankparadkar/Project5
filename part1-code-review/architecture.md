# Part 1.3: Architectural Evolution for Payouts at Scale

Before trusting this system with payouts at scale, I would make the following four fundamental architectural changes:

1. **Decouple Ingestion from Execution via an Asynchronous Outbox Pipeline:**  
   Replace synchronous HTTP gateway calls with an asynchronous **Transactional Outbox Pattern** backed by a durable queue (e.g. BullMQ / AWS SQS). The HTTP endpoint's sole responsibility becomes atomic balance reservation and event emission, shielding the user request path from third-party gateway latency, rate limits, and network partitions.

2. **Event-Driven Reconciliation and Webhook Settle-or-Refund State Machine:**  
   Build a state machine (`INITIATED` $\rightarrow$ `PROCESSING` $\rightarrow$ `SETTLED` / `FAILED`) powered by cryptographically verified gateway webhooks and an automated background cron reconciler. If a payout terminally fails, the reconciler executes an automated, atomic compensating transaction to refund the teenager's wallet balance without manual support intervention.

3. **Strict Integer Ledger Partitioning & Read/Write Separation:**  
   Enforce integer representation in minor currency units (paise) across all collections, partition the 40M+ document `Ledger` by date or cohort, and split reads from writes so mobile client history queries hit read-replicas via indexed, cursor-paginated endpoints (`userId: 1, createdAt: -1`), never choking primary transactional nodes.

4. **Velocity Limits, Risk Scoring & Pre-Payout Verification Controls:**  
   Introduce a real-time risk engine that enforces per-day/per-hour withdrawal velocity limits, prevents withdrawals to unverified or mismatching beneficiary names (penny-drop validation), and gates suspicious or first-time large payouts behind an automated approval hold to protect teenager accounts from account takeovers.

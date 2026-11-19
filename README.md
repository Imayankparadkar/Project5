# Funngro Backend Engineering Assessment
**Role:** Backend Engineer (Node.js / MongoDB)  
**Candidate:** Mayank  
**Evaluation Criteria Addressed:** Severity-ordered bug analysis, money-path correctness, MongoDB index & aggregation design, incident triage instincts, and system scale architecture.

---

## 📑 Table of Contents
1. [Quick Start & Local Setup](#-quick-start--local-setup)
2. [Project Architecture & Directory Layout](#-project-architecture--directory-layout)
3. [Part 1: Code Review & Payout Handler Rewrite](#-part-1-code-review--payout-handler-rewrite)
4. [Part 2: Schema, Indexes & Aggregation Pipeline](#-part-2-schema-indexes--aggregation-pipeline)
5. [Part 3: 9 PM Production Incident Response](#-part-3-9-pm-production-incident-response)
6. [Part 4: Loom Screen Recording Script](#-part-4-loom-screen-recording-script)
7. [API Documentation & Testing Guide](#-api-documentation--testing-guide)
8. [Assumptions & Questions for the Engineering Team](#-assumptions--questions-for-the-engineering-team)

---

## 🚀 Quick Start & Local Setup

### Prerequisites
- **Node.js:** v18+ (Tested on v22.13.1)
- **MongoDB:** Running locally on port `27017` (or MongoDB Compass)

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
The `.env` file is pre-configured for local development:
```env
PORT=3000
NODE_ENV=development
MONGO_URI=mongodb://127.0.0.1:27017/funngro_db
```

### 3. Seed Database & Create Production Indexes
Run the automated seed script to initialize collections, build indexes, and insert test accounts:
```bash
npm run seed
```
This prints the seeded user IDs (e.g. Alice with ₹1,500 balance, Bob with ₹500 balance).

### 4. Start the Application
```bash
npm start
```
The server starts at `http://localhost:3000`.

---

## 📂 Project Architecture & Directory Layout

```
Funngro/
├── server.js                         # Application entrypoint & HTTP server
├── package.json                      # Project metadata & npm scripts
├── .env                              # Local environment variables
├── .env.example                      # Environment template
├── .gitignore                        # Git ignore rules (node_modules, logs, .env)
├── README.md                         # Complete project documentation
│
├── part1-code-review/                # Part 1 Assessment Deliverables
│   ├── review.md                     # 7 bugs ordered by severity + scenarios + fixes
│   ├── withdraw.handler.js           # Production-safe transactional rewrite
│   └── architecture.md               # 4 architectural evolutions for scale
│
├── part2-schema-design/              # Part 2 Assessment Deliverables
│   ├── schema.md                     # Document models, field data types & index justifications
│   ├── monthly-finance-report.js     # Index-backed monthly finance aggregation pipeline
│   └── concurrency.md                # Concurrency double-spend prevention explanation
│
├── part3-incident-response/          # Part 3 Assessment Deliverables
│   └── incident-runbook.md           # Step-by-step 30-min incident triage runbook
│
├── part4-recording/                  # Part 4 Assessment Deliverables
│   └── script.md                     # Word-for-word spoken script for 5-minute Loom video
│
└── src/                              # Executable Backend Application
    ├── db.js                         # Singleton MongoDB connection manager
    ├── middleware/
    │   ├── auth.js                   # Authenticated user context (X-User-Id header)
    │   └── validate.js               # Defensive validation (integer paise, idempotency keys)
    ├── services/
    │   └── gateway.js                # Payment gateway abstraction (IMPS simulation)
    ├── routes/
    │   ├── wallet.js                 # POST /withdraw, GET /balance, GET /history, GET /payout/:id
    │   ├── points.js                 # POST /earn, POST /convert, GET /balance, GET /history, GET /rate
    │   └── reports.js                # GET /monthly-points (Part 2 Aggregation Endpoint)
    └── setup/
        ├── indexes.js                # Production index builder
        └── seed.js                   # Test data seeder for MongoDB Compass
```

---

## 🔍 Part 1: Code Review & Payout Handler Rewrite

*Full documentation: [`part1-code-review/review.md`](file:///c:/Users/immay/OneDrive/Desktop/Funngro/part1-code-review/review.md) and [`part1-code-review/withdraw.handler.js`](file:///c:/Users/immay/OneDrive/Desktop/Funngro/part1-code-review/withdraw.handler.js)*

### Vulnerabilities Ordered by Severity (Most Dangerous First):

1. **🔴 CRITICAL: Un-Awaited Gateway Call & Swallowed Error**  
   - *Problem:* `gateway.createPayout()` is called without `await`, and errors are swallowed with `console.log`.
   - *Failure Scenario:* Bank reject or gateway 502 still marks the ledger withdrawal as complete and returns `{ ok: true }`. The teenager's balance is deducted without money reaching their bank.
   - *Fix:* Two-phase state machine with asynchronous Outbox worker, or awaiting response with atomic compensating refund on terminal failures.

2. **🔴 CRITICAL: Non-Atomic Check-Then-Act (TOCTOU Race Condition)**  
   - *Problem:* `findOne` followed by memory check `wallet.balance >= amount` and separate `updateOne`.
   - *Failure Scenario:* Rapid double-clicks or concurrent requests pass the check simultaneously, allowing ₹1,000 balance to withdraw ₹2,000 (direct company fund loss).
   - *Fix:* Atomic conditional decrement: `findOneAndUpdate({ userId, balance: { $gte: amount } }, { $inc: { balance: -amount } })`.

3. **🔴 CRITICAL: Dynamic Payout Reference (`Date.now()`) with Mobile Retries**  
   - *Problem:* Payout reference is regenerated on every call (`'WD-' + Date.now()`).
   - *Failure Scenario:* Client network timeout at 10s triggers an automatic mobile retry. The gateway receives a new reference and issues a duplicate bank transfer.
   - *Fix:* Enforce client `idempotencyKey` stored with a unique index; reference is tied to deterministic `WD-<payoutId>`.

4. **🟠 HIGH: Unindexed 40M Document Query with In-Memory Sort**  
   - *Problem:* `Ledger.find({ userId }).sort({ createdAt: -1 })` executed on write path without index.
   - *Failure Scenario:* Triggers a 40M document `COLLSCAN` and in-memory sort limit failure, causing the 11-second p95 database lockup seen in Part 3.
   - *Fix:* Remove query from the write path entirely; serve history from a dedicated paginated endpoint with compound index `{ userId: 1, createdAt: -1 }`.

5. **🟠 HIGH: Multi-Resource Dual-Write Inconsistency**  
   - *Problem:* Separate updates across `Wallets`, `gateway`, and `Ledger` without transaction boundaries.
   - *Failure Scenario:* Crash between wallet debit and ledger insert leaves the double-entry books out of balance.
   - *Fix:* Atomically synchronize internal state updates and compensate external failures.

6. **🟡 MEDIUM: Floating Point Precision (`amount * 1.0`) & Unchecked Negative Values**  
   - *Problem:* IEEE-754 decimal drift, plus negative amounts increment balance (`1000 - (-500) = 1500`).
   - *Fix:* Store all currency as unsigned integers in minor units (**paise**).

7. **🟡 MEDIUM: Insecure Direct Object Reference (`req.body.userId`)**  
   - *Problem:* `userId` is trusted from the client payload instead of the authenticated session.
   - *Fix:* Derive `userId` exclusively from `req.user.id`.

---

## 📊 Part 2: Schema, Indexes & Aggregation Pipeline

*Full documentation: [`part2-schema-design/schema.md`](file:///c:/Users/immay/OneDrive/Desktop/Funngro/part2-schema-design/schema.md) and [`part2-schema-design/monthly-finance-report.js`](file:///c:/Users/immay/OneDrive/Desktop/Funngro/part2-schema-design/monthly-finance-report.js)*

### Collections & Index Strategy:
- **`PointWallets`**: Tracks spendable points (`availablePoints`, `lifetimeEarned`, `lifetimeConverted`).  
  - Index: `{ userId: 1 }` (Unique).
- **`PointTransactions`**: Append-only ledger recording all lifecycle events (`EARNED`, `CONVERTED`, `EXPIRED`).
  - Index: `{ cohort: 1, createdAt: 1, type: 1 }` — **Directly serves the monthly finance aggregation report.**
  - Index: `{ userId: 1, createdAt: -1 }` — Serves mobile point history screen.
  - Index: `{ referenceId: 1, source: 1 }` (Unique, partial) — Prevents awarding points twice for the same project or promo event.
- **`PointConversionRates`**: Auditable historical registry of rates.
  - Index: `{ effectiveFrom: -1, effectiveTo: 1 }` — Rapid active rate resolution.

### Concurrency Prevention (Part 2.3):
Conversion utilizes an **atomic conditional decrement**:
```javascript
db.collection('PointWallets').findOneAndUpdate(
  { userId, availablePoints: { $gte: pointsToConvert } },
  { $inc: { availablePoints: -pointsToConvert, lifetimeConverted: pointsToConvert } }
);
```
MongoDB's document-level write lock ensures that if two conversion requests fire simultaneously, only one operation matches `{ availablePoints: { $gte: pointsToConvert } }`. The second request returns `null` and fails with `INSUFFICIENT_POINTS`. The same execution credits the cash wallet and writes the audit ledger with a linked `walletLedgerId`.

---

## 🚨 Part 3: 9 PM Production Incident Response

*Full documentation: [`part3-incident-response/incident-runbook.md`](file:///c:/Users/immay/OneDrive/Desktop/Funngro/part3-incident-response/incident-runbook.md)*

### First 30 Minutes Triage Summary:
- **Minutes 0–4 (Stop the Bleeding):** Rate-limit `POST /api/wallet/withdraw` or return HTTP 429/503 to break the mobile app retry storm. Notify Support.
  - *What NOT to do:* **Do NOT restart or scale up Node.js pods** (avoids thundering herd crash on MongoDB). **Do NOT issue blind bulk refunds**.
- **Minutes 4–12 (Telemetry Diagnostics):**
  - Atlas: Check CPU and run `db.currentOp({ "secs_running": { $gte: 3 } })` to spot unindexed `Ledger.find()` collscans.
  - Gateway: Check API error rate, IMPS switch latency, and pending payout queues.
  - Logs: Grep for unhandled gateway rejections and retry spikes.
- **Minutes 12–22 (Surgical Fix):** Kill long-running ops via `db.killOp()`, build background index `db.Ledger.createIndex({ userId: 1, createdAt: -1 }, { background: true })`, and hotfix Node to remove the unindexed history scan from the write response.
- **Minutes 22–30 (Reconciliation):** Run reconciliation script matching incident window debits against gateway payout statuses. Automatically refund un-dispatched debits and notify impacted users.

---

## 🎥 Part 4: Loom Screen Recording Script

*Full documentation: [`part4-recording/script.md`](file:///c:/Users/immay/OneDrive/Desktop/Funngro/part4-recording/script.md)*

A 3.5-minute spoken walkthrough structured for the founders:
1. **Introduction:** Real-money responsibility when handling teenager balances.
2. **Bug 1:** Un-awaited / swallowed gateway error (leads to direct user fund loss).
3. **Bug 2:** Non-atomic check-then-act race condition (leads to direct business fund loss).
4. **The Ambiguous Decision & Question for Funngro:** Synchronous HTTP gateway resolution vs Asynchronous 202 Accepted + Outbox pattern.
   - *Question:* *"Does Funngro's mobile app require synchronous green-tick confirmation in the same HTTP call, or do you have WebSockets / polling ready for async webhook updates?"*

---

## 📡 API Documentation & Testing Guide

All endpoints require authentication via the `X-User-Id` header (simulating JWT session context).

### 1. Check Wallet Balance
```bash
curl -X GET http://localhost:3000/api/wallet/balance \
  -H "X-User-Id: <ALICE_USER_ID>"
```

### 2. Initiate Withdrawal (Part 1 Rewrite)
```bash
curl -X POST http://localhost:3000/api/wallet/withdraw \
  -H "Content-Type: application/json" \
  -H "X-User-Id: <ALICE_USER_ID>" \
  -H "x-idempotency-key: wd-alice-unique-001" \
  -d '{"amount": 10000}'
```
*Note: Amount is in paise (`10000` paise = ₹100.00).*

### 3. Convert Reward Points to Wallet Cash (Part 2)
```bash
curl -X POST http://localhost:3000/api/points/convert \
  -H "Content-Type: application/json" \
  -H "X-User-Id: <ALICE_USER_ID>" \
  -H "x-idempotency-key: conv-alice-unique-001" \
  -d '{"points": 100}'
```

### 4. Monthly Finance Cohort Report (Part 2 Aggregation Pipeline)
```bash
curl -X GET "http://localhost:3000/api/reports/monthly-points?year=2026&month=11" \
  -H "X-User-Id: <ALICE_USER_ID>"
```

---

## 🎯 Assumptions & Questions for the Engineering Team

### Stated Assumptions:
1. **Minor Currency Units:** All balances and transactions are stored as 64-bit integers in minor currency units (paise: ₹1 = 100 paise) to eliminate IEEE-754 floating-point drift.
2. **Stateful Gateway Processing:** Real-world payment gateway transfers (IMPS/UPI) are stateful and asynchronous. Initial responses are `PROCESSING`, with final settlement delivered via webhook or reconciliation polling.
3. **Immutable Double-Entry Ledger:** The `Ledger` collection is strictly append-only. Failed transactions or reversals result in compensating entries (`WITHDRAWAL_REFUND`), never document mutations.
4. **Denormalized Cohorts:** User cohort (signup month, e.g. `"2026-09"`) is denormalized onto transaction records to enable index-backed monthly aggregations without expensive `$lookup` joins on 40M+ documents.

### Questions for the Team:
1. **Payout Settlement UX:** Does the mobile app expect synchronous payout confirmation before rendering the success screen, or does the design allow an immediate `202 Accepted` ("Withdrawal Initiated") with status updates delivered via Webhooks or Push Notifications?
2. **Negative Balance Tolerance:** Are there any edge-case business scenarios (such as dispute chargebacks or late fee reversals) where a wallet balance can drop below zero, or is `balance >= amount` an invariant enforced at the database level?
3. **Gateway Idempotency Guarantee:** Does your payment gateway partner support native idempotency keys across 24–48 hours, or must our internal deduplication layer be the single source of truth before gateway invocation?

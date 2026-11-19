# Part 3: Production Incident Runbook (9:00 PM Payout Incident)

**Scenario:** Payout day at 9:00 PM. P95 latency on `POST /api/wallet/withdraw` spiked from 300ms to 11s over 60 minutes. Support is overwhelmed with "money debited but not received" complaints.  
**Available Telemetry:** Node.js Application Logs, MongoDB Atlas Metrics, Payment Gateway Dashboard.  
**Initial Context:** You did not write this system.

---

## 🛑 Minute 0 – 4: Immediate Action to Stop the Bleeding (Before Full RCA)

When latency exceeds 10s and mobile apps automatically retry on timeouts, the system is caught in an **exponential retry storm**. Hundreds of duplicate unindexed queries and gateway calls are compounding the load, while debited users are getting timed out before receiving HTTP 200s.

### What I Do IMMEDIATELY:
1. **Enable Endpoint Throttling / Degraded Mode at the API Gateway / Cloudflare / Nginx:**
   - Temporarily rate-limit `POST /api/wallet/withdraw` to a safe threshold (e.g., 5 requests/sec per IP/user) or return a clean HTTP `429 Too Many Requests` / `503 Service Temporarily Degraded` with a custom response:  
     `{ "ok": false, "retryable": false, "message": "Payout processing is temporarily queued. Please do not retry; your funds are safe." }`
   - **Trigger:** Latency > 10s + Support queue exploding with duplicate debits.
   - **Goal:** Stop incoming retries dead in their tracks so the database connection pool can recover.
2. **Post an Incident Declaration on `#incident-payouts` & Notify Support:**
   - Inform Support: *"We have acknowledged payout delays and placed a temporary throttle on new withdrawal clicks. Advise users that debited amounts are safe and will either complete or be refunded within 2 hours. Do not instruct users to retry."*

### What I Do NOT Do, and Why:
- ❌ **DO NOT blindly restart or scale out Node.js pods:**
  - *Why:* If the bottleneck is MongoDB saturation (e.g. 40M unindexed queries), restarting Node instances causes a thundering-herd reconnection storm. Scaling *up* pods adds even more concurrent unindexed queries and connection pool pressure, which will completely crash the primary MongoDB replica node.
- ❌ **DO NOT issue automated mass refunds or replay gateway batches:**
  - *Why:* We do not yet know which payouts were processed by the gateway versus which failed locally. Blindly refunding wallets or re-firing gateway calls will disburse double payouts and create irreversible financial losses.
- ❌ **DO NOT restart MongoDB:**
  - *Why:* Forcing a replica set failover while the primary has hundreds of long-running operations in progress can lead to dirty shutdowns, long recovery replay times, or stale read/write splits.

---

## 🔍 Minute 4 – 12: Triage & Metric Correlation Across the 3 Dashboards

Now that the incoming fire is controlled, determine where the 11 seconds are spent.

```
Request Timeline:
[Mobile Client] ──(1)──> [Node.js API] ──(2)──> [MongoDB Atlas] ──(3)──> [Payment Gateway]
```

### 1. MongoDB Atlas Metrics
- **Metrics to inspect:**
  - **CPU Utilization:** Is Primary CPU pinned at 95–100%?
  - **Disk IOPS & Disk Queue Depth:** Is disk I/O saturated due to page faulting?
  - **Read/Write Latency:** Have read operations spiked into seconds?
  - **Atlas Real-Time / Profiler / Performance Advisor:** Identify the slowest queries.
- **Actionable Mongo Shell Diagnostics:**
  ```javascript
  // 1. Identify long-running slow operations currently blocking the cluster
  db.currentOp({
    "secs_running": { $gte: 3 },
    "op": { $in: ["query", "update"] }
  });

  // 2. Check index usage on Ledger
  db.Ledger.getIndexes();
  ```
- **Decision Trigger:**  
  - *If* `db.currentOp` reveals dozens of queries running `COLLSCAN` on `db.Ledger.find({ userId: ... }).sort({ createdAt: -1 })` running for 5–10 seconds $\rightarrow$ **MongoDB is the primary root cause.** The 40M document table is choking the entire database.

### 2. Payment Gateway Dashboard
- **Metrics to inspect:**
  - **HTTP Status Codes:** Are we seeing a spike in `429 Too Many Requests` (gateway rate limit) or `504 Gateway Timeout`?
  - **Pending Payout Queue:** Are payouts stuck in `PROCESSING` / `QUEUED` at the banking partner (IMPS switch congestion)?
  - **Webhook Delivery Health:** Are webhook deliveries failing with timeouts?
- **Decision Trigger:**  
  - *If* Gateway API shows error spikes or 8s response times $\rightarrow$ The un-awaited or synchronous gateway call is holding the Node.js event loop and socket pools open.
  - *If* Gateway shows successful transfers but Funngro logs say timed out $\rightarrow$ Users received the money, but Funngro timed out before updating its DB (false-negative support complaints).

### 3. Application Logs (Datadog / CloudWatch / Kibana)
- **Grep / Log Queries:**
  ```bash
  # Check for unhandled gateway rejections and error logs
  grep -i "gateway error" app.log | tail -n 100
  
  # Check HTTP response codes and duration
  grep "POST /api/wallet/withdraw" access.log | awk '{print $9, $10}' | sort | uniq -c
  ```
- **Decision Trigger:**  
  - *If* logs show `gateway error` followed by a completed ledger entry $\rightarrow$ Confirms **Vulnerability #1**: the code caught a failed gateway call, logged it, but still debited the user!

---

## 🛠️ Minute 12 – 22: Surgical Remediation

Based on the highest probability findings (the unindexed 40M Ledger query + swallowed gateway timeouts):

### Step 1: Kill the Long-Running Killer Queries in MongoDB
Free the database memory and CPU immediately:
```javascript
// Terminate queries that have been scanning Ledger for > 5 seconds
db.currentOp({
  "secs_running": { $gte: 5 },
  "ns": "funngro.Ledger"
}).inprog.forEach(op => {
  db.killOp(op.opid);
});
```

### Step 2: Build the Missing Compound Index in the Background
Do not let this unindexed scan recur:
```javascript
// Run as a background index build to prevent locking active transactions
db.Ledger.createIndex(
  { userId: 1, createdAt: -1 }, 
  { background: true, name: "idx_userId_createdAt" }
);
```

### Step 3: Deploy a 2-Line Emergency Hotfix to Node.js
If Atlas CPU remains high while the index builds:
1. Comment out or bypass the `const history = await Ledger.find(...)` block inside `withdraw()`. The client only needs the confirmation of withdrawal; it does not need 5,000 historical ledger records in the response payload.
2. Ensure the gateway call timeout is bounded with an `AbortController` (e.g. 4 seconds max) so requests do not hang indefinitely.
3. Deploy immediately via rolling update.

---

## 📊 Minute 22 – 30: Financial Reconciliation & User Recovery

Now that the system latency has stabilized back to under 300ms, resolve the "money debited but not received" user complaints.

### 1. Identify the Blast Radius via Reconciliation Script
Run a targeted script against MongoDB comparing ledger entries created during the incident window (8:00 PM – 9:30 PM) against Gateway Payout reports:
```javascript
// Find all withdrawals created in the incident window
const incidentDebits = await db.Ledger.find({
  type: 'withdrawal',
  createdAt: { $gte: new Date('2026-11-17T20:00:00Z') }
}).toArray();

// Match against Gateway API status using the reference key
for (const debit of incidentDebits) {
  const gatewayStatus = await gateway.getPayoutByReference(debit.reference);
  
  if (!gatewayStatus || gatewayStatus.status === 'FAILED') {
    // Money was debited from Funngro wallet, but Gateway never sent it!
    console.log(`[ACTION REQUIRED] User ${debit.userId} needs refund: ₹${debit.amount}`);
    // Queue for automated atomic compensating refund transaction
    await refundUserWallet(debit.userId, debit.amount, debit._id, 'Incident Compensation');
  } else if (gatewayStatus.status === 'SUCCESS') {
    // Money was sent, user complained because app timed out before showing green tick
    console.log(`[RESOLVED] User ${debit.userId} payout confirmed at bank.`);
  }
}
```

### 2. Communicate Resolution
- Update `#incident-payouts` and customer support with exact numbers:
  - Total impacted users: e.g., 142 users.
  - 98 payouts were successfully processed by the gateway; bank SMS was delayed.
  - 44 payouts failed at gateway and have been automatically refunded back to user Funngro wallets with an SMS notification: *"Your withdrawal of ₹X could not be completed and has been credited back to your Funngro wallet."*
- Gradually lift API rate-limits and monitor p95 latency for 30 minutes.

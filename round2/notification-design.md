# Round 2: Notification Design — Wallet Balance Change

## Part A: Code — Daily Withdrawal Limit

### What Changed

Added a **per-user daily withdrawal limit of ₹2,000** (calendar day in IST timezone).

**Files changed:**
- `src/routes/wallet.js` — daily limit check inside the atomic transaction
- `part1-code-review/withdraw.handler.js` — same change to the standalone handler
- `src/setup/indexes.js` — unique index on `DailyWithdrawalLimits { userId, date }`
- `src/setup/seed.js` — clears `DailyWithdrawalLimits` on each seed

### How the Concurrency-Safe Limit Works

```
DailyWithdrawalLimits collection:
  { userId, date: "2026-11-27" (IST), totalWithdrawnPaise: Number }
  Unique index: { userId: 1, date: 1 }
```

**The atomic pattern** (inside the existing multi-document transaction):

```js
// Step 1: Atomically increment the counter
const rawLimit = await db.collection('DailyWithdrawalLimits').findOneAndUpdate(
  { userId, date: todayIST },
  {
    $inc: { totalWithdrawnPaise: amountPaise },
    $setOnInsert: { userId, date: todayIST, createdAt: new Date() }
  },
  { upsert: true, returnDocument: 'after', session }
);

// Step 2: Check the new total AFTER the atomic increment
if (limitDoc.totalWithdrawnPaise > DAILY_LIMIT_PAISE) {
  throw new Error('DAILY_LIMIT_EXCEEDED'); // transaction rolls back the $inc
}
```

### Why This Is Concurrency-Safe

**Scenario**: Two concurrent requests arrive — ₹1,500 and ₹800 — against a ₹2,000 daily limit.

| Step | Request A (₹1,500) | Request B (₹800) |
|------|---|----|
| 1 | `$inc` → totalWithdrawn = 1,500 ✅ | waits (document lock) |
| 2 | Checks 1,500 ≤ 2,000 → passes | `$inc` → totalWithdrawn = 2,300 |
| 3 | Wallet debit, payout created | Checks 2,300 > 2,000 → **DAILY_LIMIT_EXCEEDED** |
| 4 | Transaction commits | Transaction rolls back (restores 1,500) |

MongoDB's document-level locking ensures the two `findOneAndUpdate` operations on the same `DailyWithdrawalLimits` document cannot interleave. The `$inc` and the result check together form an atomic read-modify-check with no TOCTOU window.

**What prevents the counter from getting permanently corrupted**: The daily limit `$inc` and the wallet debit are in the **same transaction**. If the wallet debit fails (insufficient balance), the transaction rollback also reverses the `$inc`. Nothing is left in a half-updated state.

---

## Part B: Writing — Adding a Wallet Balance Notification

### How I Would Add It

I would **not touch the existing write paths**. Instead, I would use a **MongoDB Change Stream** as a reactive side-channel.

```js
// New file: src/workers/wallet-notification-worker.js
// Runs as a separate process — zero changes to existing code

const changeStream = db.collection('Wallets').watch(
  [{ $match: { 'updateDescription.updatedFields.balance': { $exists: true } } }],
  { fullDocument: 'updateLookup', resumeAfter: loadResumeToken() }
);

changeStream.on('change', async (event) => {
  const { userId, balance } = event.fullDocument;
  const previousBalance = balance - (event.updateDescription.updatedFields.balance - balance);
  await sendPushNotification(userId, { newBalance: balance });
  await saveResumeToken(event._id); // persist so we survive restarts
});
```

**Why this approach:**
- **Zero changes to existing code** — no risk of introducing bugs in a codebase I didn't write
- **Catches every balance change** — withdrawals, refunds, point conversions, webhooks, admin adjustments, all code paths
- **Decoupled** — notification failures don't affect the write path
- **Observable** — the worker can be restarted independently

If a Change Stream is not viable (e.g., standalone MongoDB), I would use the **Outbox Pattern**: write a `PendingNotification` document inside the same transaction as the wallet update, then have a separate polling worker send it. The key principle is the same: the notification is decoupled from the write path.

---

### What Could Break If Added Carelessly

#### 1. Notification fires before the transaction commits

```js
// WRONG — inside the transaction:
await walletCollection.updateOne(..., { session });
await sendPushNotification(userId, newBalance); // fires here
// If the transaction rolls back after this, user got notified of a balance that doesn't exist
```

The user gets a push notification saying "₹1,000 debited" but the transaction rolls back and their balance is unchanged. This causes confusion, support tickets, and trust issues.

**Fix**: Only send notifications after the transaction commits — either via a Change Stream (which only fires post-commit) or the Outbox pattern (a separate worker reads committed records).

---

#### 2. Blocking the write path with a synchronous external call

```js
// WRONG — in the HTTP handler:
await db.collection('Wallets').updateOne(...);
await axios.post('https://fcm.googleapis.com/send', notificationPayload); // blocks
res.json({ ok: true }); // delayed by FCM latency
```

If FCM is slow or down, every withdrawal takes 10+ seconds or times out. Under load, this creates thread exhaustion. A bank transfer should not be blocked by a push notification service.

**Fix**: The write path should return immediately. Dispatch notifications asynchronously via a queue, Change Stream, or Outbox.

---

#### 3. Incomplete coverage — hooking only one code path

If I add `sendNotification()` only in the `POST /withdraw` route handler, the notification fires for withdrawals. But balance changes also happen via:
- Point-to-cash conversion (`POST /points/convert`)
- Webhook-triggered refunds (`POST /webhooks/gateway`)
- Admin adjustments
- Future features added after my change

Each new code path requires remembering to add the notification call. This is a maintenance trap.

**Fix**: The Change Stream approach catches **all** balance changes by watching the collection, not individual routes.

---

#### 4. No resume token — notifications lost on process restart

If the notification worker crashes while processing a change, and there's no persisted resume token, it restarts from "now" and skips every change that happened while it was down.

**Fix**: Persist the Change Stream resume token (`event._id`) to a durable store (MongoDB collection, Redis) after each successful notification. On startup, resume from the last saved token.

---

#### 5. Sensitive data in the notification payload

```js
// RISKY:
await sendPushNotification(userId, {
  title: 'Withdrawal processed',
  body: `₹500 withdrawn. Remaining balance: ₹1,000`  // balance in push body
});
```

Push notification payloads are stored in device notification trays, OS notification centers, and may appear on lock screens. Putting exact balance amounts in push bodies exposes financial data to anyone who picks up the phone.

**Fix**: Send a generic "Your wallet was updated" notification in the push body. Let the app fetch the actual balance from the API when the user opens it. Store the balance detail only in the app's secure local storage, not in the notification payload.

---

#### 6. No idempotency on the notification side

If the notification worker retries a failed delivery, the user might receive the same "₹500 withdrawn" notification twice. For financial notifications this is alarming — users think the deduction happened twice.

**Fix**: Track a `notificationId` derived from the event (e.g., the Change Stream event's `_id` or the Outbox record's `_id`). Before sending, check if this ID was already processed. Mark it processed after a successful send.

---

### Summary

| Approach | Risk Level | Covers All Code Paths | No Existing Code Modified |
|---|---|---|---|
| Inline `sendNotification()` in route | High | No | No |
| Change Stream (separate worker) | Low | Yes | Yes |
| Outbox pattern | Low | Yes | Minimal (add outbox write to tx) |

The safest pattern in a codebase I didn't write is the **Change Stream** — it's purely additive and observes the data layer rather than the application layer.

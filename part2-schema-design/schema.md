# Part 2.1: MongoDB Schema & Index Design

## 1. Document Models

### Collection: `PointWallets`
Tracks instantaneous point balances per user. Optimized for fast atomic conditional updates.
```javascript
{
  _id: ObjectId,                     // Primary Key
  userId: String,                    // References Users.userId (Unique String ID, e.g. "usr_teen_1")
  availablePoints: NumberInt,        // Current spendable points (Integer, >= 0)
  lifetimeEarned: NumberInt,         // Total points earned historically
  lifetimeConverted: NumberInt,      // Total points converted to cash
  lifetimeExpired: NumberInt,        // Total points expired
  version: NumberInt,                // Optimistic concurrency control counter
  updatedAt: ISODate                 // Last updated timestamp
}
```

### Collection: `PointTransactions`
Append-only immutable ledger recording every point lifecycle event.
```javascript
{
  _id: ObjectId,                     // Primary Key
  userId: String,                    // References Users.userId (Consistent String ID)
  cohort: String,                    // Denormalized user cohort (e.g. "2026-01") for zero-join reporting
  type: String,                      // Enum: "EARNED" | "CONVERTED" | "EXPIRED" | "ADMIN_ADJUSTMENT"
  source: String,                    // Enum: "PROJECT_COMPLETION" | "PROMO_EVENT" | "CASH_CONVERSION" | "EXPIRY_JOB" | "ADMIN_MANUAL"
  points: NumberInt,                 // Unsigned integer quantity of points
  referenceId: String,               // External ID (e.g., "PROJ-1029", "PROMO-SPRING26", "CONV-uuid")
  rateUsed: Decimal128,              // Conversion rate applied (e.g. 0.10 INR/pt), null for EARNED/EXPIRED
  cashCreditedPaise: NumberInt,      // Wallet cash credited in paise (null unless CONVERTED)
  walletLedgerId: ObjectId,          // Foreign key linking directly to Cash Ledger for financial audit
  meta: {
    idempotencyKey: String,          // Client idempotency key for conversion/earn deduplication
    requestHash: String              // SHA-256 hash of payload to detect tampering
  },
  expiresAt: ISODate,                // Expiry timestamp (applicable to EARNED points)
  createdAt: ISODate                 // Transaction timestamp
}
```

### Collection: `PointConversionRates`
Auditable registry of point-to-cash exchange rates over time.
```javascript
{
  _id: ObjectId,                     // Primary Key
  rateInInr: Decimal128,             // Value of 1 point in INR (e.g. 0.10 = 10 paise per point)
  effectiveFrom: ISODate,            // Activation timestamp
  effectiveTo: ISODate,              // Expiry timestamp (null = currently active rate)
  createdBy: ObjectId,               // Admin/Finance user ID who authorized the rate change
  reason: String,                    // Audit trail rationale (e.g., "Diwali Promo Rate Bump")
  createdAt: ISODate
}
```

---

## 2. Index Strategy & Justifications

### `PointWallets`
| Index Definition | Type | Why It Exists / What Query It Serves |
| :--- | :--- | :--- |
| `{ userId: 1 }` | **Unique** | Ensures one wallet per user and guarantees $O(1)$ point balance lookup and atomic conditional decrement during conversions: `PointWallets.findOneAndUpdate({ userId, availablePoints: { $gte: reqPoints } }, ...)`. |

### `PointTransactions`
| Index Definition | Type | Why It Exists / What Query It Serves |
| :--- | :--- | :--- |
| `{ userId: 1, 'meta.idempotencyKey': 1 }` | **Unique, Partial** | **Client Idempotency Guard.** Prevents concurrent double-conversion requests from creating duplicate point-to-cash conversions using partial filter `{ 'meta.idempotencyKey': { $type: "string" } }`. |
| `{ userId: 1, createdAt: -1 }` | **Compound** | Powers the teenager's mobile app "Points History" screen with descending chronological sorting. Completely eliminates in-memory sort buffer limits. |
| `{ cohort: 1, createdAt: 1, type: 1 }` | **Compound** | **Directly serves the monthly finance aggregation report.** Enables an index-covered `$match` stage over the cohort and date window, and accelerates `$group` operations without touching the rest of the 40M+ document collection. |
| `{ referenceId: 1, source: 1 }` | **Unique, Partial/Sparse** | **Strict Idempotency Guard.** Prevents awarding points twice for the identical project or promo event: `db.PointTransactions.createIndex({ referenceId: 1, source: 1 }, { unique: true, partialFilterExpression: { referenceId: { $type: "string" } } })`. |
| `{ expiresAt: 1, type: 1 }` | **Compound, Partial** | Serves the automated background points expiry worker: finds points where `expiresAt <= now` and `type: "EARNED"`. |

### `PointConversionRates`
| Index Definition | Type | Why It Exists / What Query It Serves |
| :--- | :--- | :--- |
| `{ effectiveFrom: -1, effectiveTo: 1 }` | **Compound** | Serves dynamic rate lookups: fetches the active rate at conversion time via `findOne({ effectiveFrom: { $lte: now }, effectiveTo: null })`. |

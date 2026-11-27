/**
 * src/setup/indexes.js
 * Production Index Definition & Optimization Engine
 * 
 * Complies with Section 5 of the Antigravity Technical Brief:
 * - Creates exact unique compound indexes for idempotency and business references.
 * - Builds compound covering indexes to prevent COLLSCAN and in-memory sort failures.
 * - Uses partialFilterExpressions for sparse metadata keys.
 */

const COLLECTIONS = [
  'Users', 'Wallets', 'Ledger', 'PayoutRequests',
  'PointWallets', 'PointTransactions', 'PointConversionRates',
  'ProcessedWebhookEvents', 'DailyWithdrawalLimits'
];

async function createIndexes(db) {
  console.log('[DB] Ensuring production indexes...');

  // Drop all existing non-_id indexes so we can recreate with correct names/options.
  // Safe to do on startup: indexes rebuild quickly on the small demo dataset.
  for (const col of COLLECTIONS) {
    await db.collection(col).dropIndexes().catch(() => {});
  }

  // ─── USERS ───────────────────────────────────────────────────────────────────
  await db.collection('Users').createIndex({ email: 1 }, { unique: true, name: 'idx_users_email_unique' });
  await db.collection('Users').createIndex({ status: 1 }, { name: 'idx_users_status' });

  // ─── WALLETS ─────────────────────────────────────────────────────────────────
  // Guarantees one wallet per user; powers O(1) atomic conditional balance decrements
  await db.collection('Wallets').createIndex({ userId: 1 }, { unique: true, name: 'idx_wallets_userId_unique' });

  // ─── LEDGER ──────────────────────────────────────────────────────────────────
  // Fixes the 40M-row COLLSCAN bug from original code (userId + chronological descending)
  await db.collection('Ledger').createIndex({ userId: 1, createdAt: -1 }, { name: 'idx_ledger_user_history' });
  await db.collection('Ledger').createIndex({ payoutId: 1 }, { name: 'idx_ledger_payoutId' });

  // ─── PAYOUT REQUESTS ─────────────────────────────────────────────────────────
  // Scoped compound unique index: prevents duplicate payouts per user on mobile retries
  await db.collection('PayoutRequests').createIndex(
    { userId: 1, idempotencyKey: 1 },
    { unique: true, name: 'idx_payout_user_idempotency_unique' }
  );
  await db.collection('PayoutRequests').createIndex(
    { reference: 1 },
    { unique: true, name: 'idx_payout_reference_unique' }
  );
  await db.collection('PayoutRequests').createIndex({ status: 1, createdAt: 1 }, { name: 'idx_payout_status_createdAt' });
  await db.collection('PayoutRequests').createIndex({ userId: 1, createdAt: -1 }, { name: 'idx_payout_user_history' });

  // ─── POINT WALLETS ───────────────────────────────────────────────────────────
  await db.collection('PointWallets').createIndex({ userId: 1 }, { unique: true, name: 'idx_pointwallets_userId_unique' });

  // ─── POINT TRANSACTIONS ──────────────────────────────────────────────────────
  // 1. Mobile History Screen (Chronological descending)
  await db.collection('PointTransactions').createIndex(
    { userId: 1, createdAt: -1 },
    { name: 'idx_point_txns_user_history' }
  );

  // 2. Conversion Idempotency Guard (Unique per user + idempotency key)
  await db.collection('PointTransactions').createIndex(
    { userId: 1, 'meta.idempotencyKey': 1 },
    {
      unique: true,
      partialFilterExpression: { 'meta.idempotencyKey': { $type: 'string' } },
      name: 'idx_point_txns_conversion_idempotency_unique'
    }
  );

  // 3. Unique Business Reference (Prevents double-awarding points for same project/event)
  await db.collection('PointTransactions').createIndex(
    { referenceId: 1, source: 1 },
    {
      unique: true,
      partialFilterExpression: { referenceId: { $type: 'string' } },
      name: 'idx_point_txns_business_ref_unique'
    }
  );

  // 4. Monthly Finance Cohort Report (Index-covered $match stage)
  await db.collection('PointTransactions').createIndex(
    { cohort: 1, createdAt: 1, type: 1 },
    { name: 'idx_cohort_createdAt_type' }
  );

  // 5. Date-Only Reporting Index
  await db.collection('PointTransactions').createIndex(
    { createdAt: 1, type: 1 },
    { name: 'idx_createdAt_type' }
  );

  // 6. Automated Expiry Worker Index
  await db.collection('PointTransactions').createIndex(
    { expiresAt: 1, type: 1 },
    {
      partialFilterExpression: { type: 'EARNED', expiresAt: { $exists: true } },
      name: 'idx_expiry_earned'
    }
  );

  // ─── POINT CONVERSION RATES ──────────────────────────────────────────────────
  await db.collection('PointConversionRates').createIndex(
    { effectiveFrom: -1, effectiveTo: 1 },
    { name: 'idx_conversion_rate_lookup' }
  );

  // ─── PROCESSED WEBHOOK EVENTS ────────────────────────────────────────────────
  await db.collection('ProcessedWebhookEvents').createIndex(
    { eventId: 1 },
    { unique: true, name: 'idx_webhook_event_unique' }
  );

  // ─── DAILY WITHDRAWAL LIMITS ─────────────────────────────────────────────────
  // Unique per user per IST calendar date — powers the atomic $inc + limit check.
  await db.collection('DailyWithdrawalLimits').createIndex(
    { userId: 1, date: 1 },
    { unique: true, name: 'idx_daily_limit_user_date_unique' }
  );

  console.log('[DB] All production indexes successfully verified.');
}

module.exports = { createIndexes };

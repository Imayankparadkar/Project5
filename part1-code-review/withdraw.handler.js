'use strict';

const crypto = require('crypto');
const { ObjectId } = require('mongodb');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ₹2,000 per-user daily withdrawal limit (calendar day, IST timezone)
const DAILY_LIMIT_PAISE = 200000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Returns today's date string in IST (UTC+5:30), e.g. "2026-11-27".
// IST day boundary is the partition key for per-user daily limit counters.
function getISTDateString() {
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  return new Date(Date.now() + istOffsetMs).toISOString().slice(0, 10);
}

/**
 * Normalizes MongoDB driver v5 ({ value: doc }) vs v6 (doc directly) return shape.
 */
function extractDoc(result) {
  if (!result) return null;
  return result.value !== undefined ? result.value : result;
}

/**
 * Generates deterministic SHA-256 hash of the payout request parameters.
 * Detects idempotency key reuse with modified amount or destination account.
 */
function computeRequestHash(userId, amountPaise, bankAccount) {
  const payload = JSON.stringify({
    userId: String(userId),
    amount: amountPaise,
    accountNumber: bankAccount ? bankAccount.accountNumber : '',
    ifsc: bankAccount ? bankAccount.ifsc : ''
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// POST /api/wallet/withdraw
// ---------------------------------------------------------------------------

async function withdraw(req, res) {
  const { getDb, runInTransaction } = require('../src/db');
  const gateway = require('../src/services/gateway');
  const db = getDb();

  // ── Step 1: Authenticated Identity (IDOR Prevention) ──────────────────────
  const userId = req.user && req.user.id;
  if (!userId) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  // ── Step 2: Validated Inputs ──────────────────────────────────────────────
  const amountPaise = req.validatedAmount;
  const idemKey = req.idempotencyKey;

  // ── Step 3: User Eligibility & Mandatory KYC ─────────────────────────────
  const user = await db.collection('Users').findOne(
    { _id: userId },
    { projection: { bankAccount: 1, kycStatus: 1, status: 1 } }
  );

  if (!user || user.status !== 'ACTIVE') {
    return res.status(404).json({ error: 'USER_NOT_FOUND_OR_INACTIVE' });
  }

  // Enforce verified KYC requirement before moving real money
  if (user.kycStatus !== 'VERIFIED') {
    return res.status(403).json({
      error: 'KYC_NOT_VERIFIED',
      message: 'Withdrawal requires completed KYC verification.'
    });
  }

  if (!user.bankAccount || user.bankAccount.status !== 'VERIFIED') {
    return res.status(400).json({
      error: 'BANK_ACCOUNT_NOT_VERIFIED',
      message: 'Please add and verify a bank account before withdrawing.'
    });
  }

  // ── Step 4: Idempotency Fast-Path (Pre-Check) ─────────────────────────────
  const requestHash = computeRequestHash(userId, amountPaise, user.bankAccount);

  const existing = await db.collection('PayoutRequests').findOne({
    userId: String(userId),
    idempotencyKey: idemKey
  });

  if (existing) {
    // Check if client changed amount or bank account on this idempotency key
    if (existing.requestHash && existing.requestHash !== requestHash) {
      return res.status(409).json({
        error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        message: 'This idempotency key was already used with a different amount or bank account.'
      });
    }

    return res.status(200).json({
      ok: true,
      idempotent: true,
      status: existing.status,
      payoutId: existing._id,
      reference: existing.reference,
      amountPaise: existing.amount,
      amountINR: (existing.amount / 100).toFixed(2),
      message: 'Withdrawal already received. Returning existing payout status.'
    });
  }

  // ── Step 5: Atomic Multi-Document Transaction ─────────────────────────────
  // Commits: Daily Limit Reservation + Wallet Debit + PayoutRequest + Ledger Entry
  const payoutId = new ObjectId();
  const reference = `WD-${payoutId.toString()}`;
  const todayIST = getISTDateString();
  let newBalance;

  try {
    const txResult = await runInTransaction(async (session) => {
      // 5a. Re-check idempotency under transaction boundary
      const inTxExisting = await db.collection('PayoutRequests').findOne(
        { userId: String(userId), idempotencyKey: idemKey },
        { session }
      );

      if (inTxExisting) {
        if (inTxExisting.requestHash && inTxExisting.requestHash !== requestHash) {
          throw new Error('IDEMPOTENCY_PAYLOAD_MISMATCH');
        }
        return { isDuplicate: true, payout: inTxExisting };
      }

      // 5b. Atomic Daily Withdrawal Limit (IST Calendar Day)
      // Pattern: $inc the counter first, then check the new total.
      // On replica set: transaction rollback undoes the $inc if limit exceeded.
      // On standalone: manual compensation before throw.
      const rawLimit = await db.collection('DailyWithdrawalLimits').findOneAndUpdate(
        { userId: String(userId), date: todayIST },
        {
          $inc: { totalWithdrawnPaise: amountPaise },
          $setOnInsert: { userId: String(userId), date: todayIST, createdAt: new Date() }
        },
        { upsert: true, returnDocument: 'after', session }
      );
      const limitDoc = extractDoc(rawLimit);

      if (limitDoc.totalWithdrawnPaise > DAILY_LIMIT_PAISE) {
        if (!session) {
          await db.collection('DailyWithdrawalLimits').updateOne(
            { userId: String(userId), date: todayIST },
            { $inc: { totalWithdrawnPaise: -amountPaise } }
          );
        }
        throw new Error('DAILY_LIMIT_EXCEEDED');
      }

      // 5c. Atomic Conditional Balance Decrement (Eliminates TOCTOU Race Condition)
      const rawWallet = await db.collection('Wallets').findOneAndUpdate(
        { userId: String(userId), balance: { $gte: amountPaise } },
        { $inc: { balance: -amountPaise }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after', session }
      );
      const wallet = extractDoc(rawWallet);
      if (!wallet) {
        // Standalone: reverse daily limit since wallet debit failed
        if (!session) {
          await db.collection('DailyWithdrawalLimits').updateOne(
            { userId: String(userId), date: todayIST },
            { $inc: { totalWithdrawnPaise: -amountPaise } }
          );
        }
        throw new Error('INSUFFICIENT_BALANCE');
      }

      // 5d. Insert Payout Record in PENDING_DISPATCH
      await db.collection('PayoutRequests').insertOne({
        _id: payoutId,
        userId: String(userId),
        idempotencyKey: idemKey,
        requestHash: requestHash,
        amount: amountPaise,
        status: 'PENDING_DISPATCH',
        reference: reference,
        bankAccount: {
          accountNumber: user.bankAccount.accountNumber,
          ifsc: user.bankAccount.ifsc,
          beneficiaryName: user.bankAccount.beneficiaryName
        },
        createdAt: new Date(),
        updatedAt: new Date()
      }, { session });

      // 5d. Immutable Ledger Debit Entry
      await db.collection('Ledger').insertOne({
        userId: String(userId),
        payoutId: payoutId,
        type: 'WITHDRAWAL_DEBIT',
        amount: -amountPaise,
        balanceAfter: wallet.balance,
        doubleEntry: {
          debitAccount: `LIABILITIES:USER_WALLET:${userId}`,
          creditAccount: 'ASSETS:PAYMENT_GATEWAY_CLEARING',
          amountPaise: amountPaise
        },
        status: 'RESERVED',
        createdAt: new Date()
      }, { session });

      return { isDuplicate: false, balance: wallet.balance };
    });

    if (txResult.isDuplicate) {
      return res.status(200).json({
        ok: true,
        idempotent: true,
        status: txResult.payout.status,
        payoutId: txResult.payout._id,
        reference: txResult.payout.reference,
        message: 'Withdrawal already received. Returning existing payout status.'
      });
    }

    newBalance = txResult.balance;

  } catch (err) {
    if (err.message === 'DAILY_LIMIT_EXCEEDED') {
      return res.status(429).json({
        error: 'DAILY_LIMIT_EXCEEDED',
        message: `Daily withdrawal limit of ₹${DAILY_LIMIT_PAISE / 100} reached. Resets at midnight IST.`,
        limitPaise: DAILY_LIMIT_PAISE,
        limitINR: (DAILY_LIMIT_PAISE / 100).toFixed(2)
      });
    }

    if (err.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({
        error: 'INSUFFICIENT_BALANCE',
        message: 'Wallet balance is too low for this withdrawal.'
      });
    }

    if (err.message === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
      return res.status(409).json({
        error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        message: 'This idempotency key was already used with a different amount or bank account.'
      });
    }

    // Handle concurrent insert collision on { userId: 1, idempotencyKey: 1 } unique index
    if (err.code === 11000) {
      const raceExisting = await db.collection('PayoutRequests').findOne({
        userId: String(userId),
        idempotencyKey: idemKey
      });

      if (raceExisting) {
        if (raceExisting.requestHash && raceExisting.requestHash !== requestHash) {
          return res.status(409).json({
            error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
            message: 'This idempotency key was already used with a different amount or bank account.'
          });
        }
        return res.status(200).json({
          ok: true,
          idempotent: true,
          status: raceExisting.status,
          payoutId: raceExisting._id,
          reference: raceExisting.reference,
          amountPaise: raceExisting.amount,
          amountINR: (raceExisting.amount / 100).toFixed(2),
          message: 'Withdrawal already received. Returning existing payout status.'
        });
      }

      return res.status(409).json({
        error: 'CONCURRENT_REQUEST',
        message: 'A concurrent request with this idempotency key is already in progress.'
      });
    }

    console.error('[Withdrawal Transaction Failed]', err.message);
    return res.status(500).json({ error: 'TRANSACTION_FAILED', message: err.message });
  }

  // ── Step 6: Dispatch to Payment Gateway (AFTER DB Transaction Commit) ───────
  // Gateway amount is sent strictly in paise per gateway service contract
  let gatewayResponse;
  try {
    gatewayResponse = await gateway.createPayout({
      account: user.bankAccount,
      amount: amountPaise,
      reference: reference
    });
  } catch (gatewayErr) {
    console.error('[Gateway Error]', gatewayErr.message, '| Terminal:', gatewayErr.isTerminal);

    if (gatewayErr.isTerminal) {
      // Definitive bank rejection (e.g. invalid IFSC) -> conditional refund
      await handleTerminalRefund(db, runInTransaction, payoutId, userId, amountPaise, gatewayErr.message);
      return res.status(502).json({
        error: 'GATEWAY_REJECTED',
        message: `Payout rejected: ${gatewayErr.message}. Wallet balance has been restored.`,
        refunded: true
      });
    } else {
      // Timeout / network disconnect -> Mark PENDING_RECONCILIATION. NEVER auto-refund!
      await db.collection('PayoutRequests').updateOne(
        { _id: payoutId },
        { $set: { status: 'PENDING_RECONCILIATION', lastError: gatewayErr.message, updatedAt: new Date() } }
      );
      return res.status(202).json({
        ok: true,
        status: 'PENDING_RECONCILIATION',
        payoutId: payoutId,
        reference: reference,
        balancePaise: newBalance,
        balanceINR: (newBalance / 100).toFixed(2),
        message: 'Gateway timed out. Payout is under verification. No action needed from your side.'
      });
    }
  }

  // ── Step 7: Atomic Database Status Update on Gateway Success ───────────────
  // PayoutRequest and Ledger statuses are updated atomically inside a transaction.
  // If this update fails, the payout remains in PENDING_DISPATCH for reconciliation.
  let postDispatchPersisted = false;
  try {
    await runInTransaction(async (session) => {
      const payoutRes = await db.collection('PayoutRequests').updateOne(
        { _id: payoutId, status: 'PENDING_DISPATCH' },
        {
          $set: {
            status: 'DISPATCHED',
            gatewayPayoutId: gatewayResponse.id,
            utr: gatewayResponse.utr || null,
            updatedAt: new Date()
          }
        },
        { session }
      );

      const ledgerRes = await db.collection('Ledger').updateOne(
        { payoutId: payoutId, status: 'RESERVED' },
        { $set: { status: 'DISPATCHED', updatedAt: new Date() } },
        { session }
      );

      if (payoutRes.matchedCount !== 1 || ledgerRes.matchedCount !== 1) {
        throw new Error(
          `POST_DISPATCH_UPDATE_MISMATCH: Payout matched ${payoutRes.matchedCount}, Ledger matched ${ledgerRes.matchedCount}`
        );
      }
    });
    postDispatchPersisted = true;
  } catch (dbErr) {
    // Gateway accepted the payout, but our local DB status update failed.
    // NEVER refund! The funds are in transit at the bank.
    console.error('[CRITICAL] Gateway accepted but DB status update transaction failed:', dbErr.message);
  }

  // Return status reflecting the actual persisted database state
  if (!postDispatchPersisted) {
    return res.status(202).json({
      ok: true,
      status: 'PENDING_RECONCILIATION',
      payoutId: payoutId,
      reference: reference,
      balancePaise: newBalance,
      balanceINR: (newBalance / 100).toFixed(2),
      message: 'Payout accepted by gateway; state persistence pending reconciliation.'
    });
  }

  return res.status(202).json({
    ok: true,
    status: 'DISPATCHED',
    payoutId: payoutId,
    reference: reference,
    balancePaise: newBalance,
    balanceINR: (newBalance / 100).toFixed(2),
    message: 'Withdrawal initiated. Funds will appear in your bank account shortly.'
  });
}

// ---------------------------------------------------------------------------
// Compensating Refund (Terminal Gateway Failure only)
// ---------------------------------------------------------------------------

/**
 * Executes a single conditional refund when a terminal gateway failure occurs.
 * Transitions PayoutRequest from non-terminal states ('PENDING_DISPATCH', 'PENDING_RECONCILIATION')
 * to 'FAILED'. If wallet is missing or already refunded, rolls back to prevent ghost refunds.
 */
async function handleTerminalRefund(db, runInTransaction, payoutId, userId, amountPaise, reason) {
  try {
    await runInTransaction(async (session) => {
      // 1. Atomically transition state to FAILED (only from non-terminal states)
      const rawPayout = await db.collection('PayoutRequests').findOneAndUpdate(
        {
          _id: payoutId,
          status: { $in: ['PENDING_DISPATCH', 'PENDING_RECONCILIATION'] }
        },
        {
          $set: {
            status: 'FAILED',
            failureReason: reason,
            refundedAt: new Date(),
            updatedAt: new Date()
          }
        },
        { returnDocument: 'after', session }
      );
      const payout = extractDoc(rawPayout);

      if (!payout) {
        // Already refunded or in an invalid state for refund
        return;
      }

      // 2. Refund wallet balance atomically
      const rawWallet = await db.collection('Wallets').findOneAndUpdate(
        { userId: String(userId) },
        { $inc: { balance: amountPaise }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after', session }
      );
      const wallet = extractDoc(rawWallet);

      if (!wallet) {
        // Must throw to rollback transaction so payout is not marked FAILED without wallet credit
        throw new Error(`WALLET_NOT_FOUND: Cannot refund — wallet for user ${userId} not found.`);
      }

      // 3. Compensating ledger entry (reversal of original debit)
      await db.collection('Ledger').insertOne({
        userId: String(userId),
        payoutId: payoutId,
        type: 'WITHDRAWAL_REFUND',
        amount: amountPaise,
        balanceAfter: wallet.balance,
        doubleEntry: {
          debitAccount: 'ASSETS:PAYMENT_GATEWAY_CLEARING',
          creditAccount: `LIABILITIES:USER_WALLET:${userId}`,
          amountPaise: amountPaise
        },
        reason: reason,
        createdAt: new Date()
      }, { session });
    });
  } catch (err) {
    console.error('[Compensating Refund Error]', err.message);
    throw err;
  }
}

module.exports = { withdraw, handleTerminalRefund, computeRequestHash, extractDoc };

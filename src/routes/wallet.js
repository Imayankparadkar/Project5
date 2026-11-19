/**
 * src/routes/wallet.js
 * Production-Safe Payout & Wallet Management Handler
 * 
 * Complies with Section 4.D of the Antigravity Technical Brief:
 * - Wallet balance reservation, PayoutRequest, and Ledger debit are atomic within a transaction.
 * - Dispatch to the payment gateway occurs ONLY after the database transaction commits.
 * - Separates gateway dispatch errors from database status-update errors.
 * - Gateway timeouts enter PENDING_RECONCILIATION; NEVER automatically refunded.
 * - Confirmed terminal rejections execute a conditional single-attempt compensating refund.
 */

const express = require('express');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const router = express.Router();

const { getDb, runInTransaction } = require('../db');
const { authenticate } = require('../middleware/auth');
const { validateWithdrawal } = require('../middleware/validate');
const gateway = require('../services/gateway');

function extractDoc(result) {
  if (!result) return null;
  return result.value !== undefined ? result.value : result;
}

function computeRequestHash(userId, amountInPaise, bankAccount) {
  const payload = JSON.stringify({
    userId: userId.toString(),
    amount: amountInPaise,
    accountNumber: bankAccount ? bankAccount.accountNumber : '',
    ifsc: bankAccount ? bankAccount.ifsc : ''
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ─── POST /api/wallet/withdraw ────────────────────────────────────────────────
router.post('/withdraw', authenticate, validateWithdrawal, async (req, res) => {
  const userId = req.user.id;
  const amountPaise = req.validatedAmount;
  const idemKey = req.idempotencyKey;
  const db = getDb();

  // 1. Verify User & Bank Account Preconditions
  let user;
  try {
    user = await db.collection('Users').findOne(
      { $or: [{ _id: new ObjectId(userId) }, { _id: userId }] },
      { projection: { bankAccount: 1, kycStatus: 1, status: 1 } }
    );
  } catch {
    user = await db.collection('Users').findOne(
      { _id: userId },
      { projection: { bankAccount: 1, kycStatus: 1, status: 1 } }
    );
  }

  if (!user || user.status !== 'ACTIVE') {
    return res.status(404).json({ error: 'USER_NOT_FOUND_OR_INACTIVE' });
  }

  if (user.kycStatus !== 'VERIFIED') {
    return res.status(403).json({
      error: 'KYC_NOT_VERIFIED',
      message: 'Please complete KYC verification before withdrawing funds.'
    });
  }

  if (!user.bankAccount || user.bankAccount.status !== 'VERIFIED') {
    return res.status(400).json({
      error: 'BANK_ACCOUNT_NOT_VERIFIED',
      message: 'Please add and verify a bank account before withdrawing.'
    });
  }

  const currentRequestHash = computeRequestHash(userId, amountPaise, user.bankAccount);

  // 2. Fast Pre-Check for Idempotency
  const existingPayout = await db.collection('PayoutRequests').findOne({
    userId: String(userId),
    idempotencyKey: idemKey
  });

  if (existingPayout) {
    if (existingPayout.requestHash && existingPayout.requestHash !== currentRequestHash) {
      return res.status(409).json({
        error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        message: 'This idempotency key was already used with a different amount or bank account.'
      });
    }

    return res.status(200).json({
      ok: true,
      idempotent: true,
      status: existingPayout.status,
      payoutId: existingPayout._id,
      reference: existingPayout.reference,
      amountPaise: existingPayout.amount,
      amountINR: (existingPayout.amount / 100).toFixed(2),
      message: 'Withdrawal request already received. Returning existing payout state.'
    });
  }

  // 3. Atomic Multi-Document Transaction (Reservation + Payout + Ledger)
  const payoutId = new ObjectId();
  const reference = `WD-${payoutId.toString()}`;
  let updatedBalance;

  try {
    const txResult = await runInTransaction(async (session) => {
      // 3a. Re-check idempotency under transaction lock
      const inTxExisting = await db.collection('PayoutRequests').findOne(
        { userId: String(userId), idempotencyKey: idemKey },
        { session }
      );

      if (inTxExisting) {
        if (inTxExisting.requestHash && inTxExisting.requestHash !== currentRequestHash) {
          throw new Error('IDEMPOTENCY_PAYLOAD_MISMATCH');
        }
        return { isDuplicate: true, payout: inTxExisting };
      }

      // 3b. Atomic Conditional Balance Decrement
      const rawWallet = await db.collection('Wallets').findOneAndUpdate(
        {
          userId: String(userId),
          balance: { $gte: amountPaise } // Atomic balance guard
        },
        {
          $inc: { balance: -amountPaise },
          $set: { updatedAt: new Date() }
        },
        { returnDocument: 'after', session }
      );
      const walletDoc = extractDoc(rawWallet);

      if (!walletDoc) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      // 3c. Insert PayoutRequest in PENDING_DISPATCH
      await db.collection('PayoutRequests').insertOne({
        _id: payoutId,
        userId: String(userId),
        idempotencyKey: idemKey,
        requestHash: currentRequestHash,
        amount: amountPaise,
        status: 'PENDING_DISPATCH',
        reference,
        bankAccount: {
          accountNumber: user.bankAccount.accountNumber,
          ifsc: user.bankAccount.ifsc,
          beneficiaryName: user.bankAccount.beneficiaryName
        },
        createdAt: new Date(),
        updatedAt: new Date()
      }, { session });

      // 3d. True Double-Entry Ledger Entry
      await db.collection('Ledger').insertOne({
        userId: String(userId),
        payoutId,
        type: 'WITHDRAWAL_DEBIT',
        amount: -amountPaise,
        balanceAfter: walletDoc.balance,
        doubleEntry: {
          debitAccount: `LIABILITIES:USER_WALLET:${userId}`,
          creditAccount: 'ASSETS:PAYMENT_GATEWAY_CLEARING',
          amountPaise: amountPaise
        },
        status: 'RESERVED',
        createdAt: new Date()
      }, { session });

      return { isDuplicate: false, balance: walletDoc.balance };
    });

    if (txResult.isDuplicate) {
      return res.status(200).json({
        ok: true,
        idempotent: true,
        status: txResult.payout.status,
        payoutId: txResult.payout._id,
        reference: txResult.payout.reference,
        message: 'Withdrawal request already received. Returning existing payout state.'
      });
    }

    updatedBalance = txResult.balance;

  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ error: 'INSUFFICIENT_BALANCE', message: 'Insufficient wallet balance.' });
    }
    if (err.message === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
      return res.status(409).json({
        error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        message: 'This idempotency key was already used with a different amount or bank account.'
      });
    }

    if (err.code === 11000) {
      const raceExisting = await db.collection('PayoutRequests').findOne({
        userId: String(userId),
        idempotencyKey: idemKey
      });

      if (raceExisting) {
        if (raceExisting.requestHash && raceExisting.requestHash !== currentRequestHash) {
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
          message: 'Withdrawal request already received. Returning existing payout state.'
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

  // 4. Dispatch to Payment Gateway (AFTER DB Transaction Commit)
  let gatewayResponse;
  try {
    gatewayResponse = await gateway.createPayout({
      account: user.bankAccount,
      amount: amountPaise,
      reference
    });
  } catch (gatewayErr) {
    console.error('[Gateway Dispatch Error]', gatewayErr.message, '| Terminal:', gatewayErr.isTerminal);

    if (gatewayErr.isTerminal) {
      // Definitive terminal failure: execute conditional compensating refund
      await handleTerminalRefund(db, payoutId, userId, amountPaise, gatewayErr.message);
      return res.status(502).json({
        error: 'GATEWAY_REJECTED',
        message: `Payout was rejected: ${gatewayErr.message}. Wallet balance restored.`,
        refunded: true
      });
    } else {
      // Timeout / Unknown result: NEVER auto-refund. Escalate to PENDING_RECONCILIATION
      await db.collection('PayoutRequests').updateOne(
        { _id: payoutId },
        { $set: { status: 'PENDING_RECONCILIATION', lastError: gatewayErr.message, updatedAt: new Date() } }
      );
      return res.status(202).json({
        ok: true,
        status: 'PENDING_RECONCILIATION',
        payoutId,
        reference,
        balancePaise: updatedBalance,
        balanceINR: (updatedBalance / 100).toFixed(2),
        message: 'Gateway timeout. Payout is in verification; funds will reflect after banking reconciliation.'
      });
    }
  }

  // 5. Database Status Update (Separated from Gateway Catch Block)
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
        { payoutId, status: 'RESERVED' },
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
  } catch (dbUpdateErr) {
    // CRITICAL: Gateway accepted payout! Do NOT refund; log for reconciliation
    console.error('[CRITICAL] Gateway accepted payout, but local DB update failed:', dbUpdateErr.message);
  }

  if (!postDispatchPersisted) {
    return res.status(202).json({
      ok: true,
      status: 'PENDING_RECONCILIATION',
      payoutId,
      reference,
      balancePaise: updatedBalance,
      balanceINR: (updatedBalance / 100).toFixed(2),
      message: 'Payout accepted by gateway; state persistence pending reconciliation.'
    });
  }

  return res.status(202).json({
    ok: true,
    status: 'DISPATCHED',
    payoutId,
    reference,
    balancePaise: updatedBalance,
    balanceINR: (updatedBalance / 100).toFixed(2),
    message: 'Withdrawal initiated successfully. Funds will appear in your bank account shortly.'
  });
});

/**
 * Executes a conditional compensating refund strictly once for confirmed terminal failures.
 */
async function handleTerminalRefund(db, payoutId, userId, amountPaise, reason) {
  try {
    await runInTransaction(async (session) => {
      // 1. Atomically transition state to FAILED (Only from non-terminal states)
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
      const updatedPayout = extractDoc(rawPayout);

      if (!updatedPayout) {
        // Already refunded or not in refundable state
        return;
      }

      // 2. Refund wallet balance
      const rawWallet = await db.collection('Wallets').findOneAndUpdate(
        { userId: String(userId) },
        { $inc: { balance: amountPaise }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after', session }
      );
      const walletDoc = extractDoc(rawWallet);

      if (!walletDoc) {
        throw new Error(`WALLET_NOT_FOUND: Cannot refund — wallet for user ${userId} not found.`);
      }

      // 3. Compensating Ledger Entry (Double-Entry Reversal)
      await db.collection('Ledger').insertOne({
        userId: String(userId),
        payoutId,
        type: 'WITHDRAWAL_REFUND',
        amount: amountPaise,
        balanceAfter: walletDoc ? walletDoc.balance : 0,
        doubleEntry: {
          debitAccount: 'ASSETS:PAYMENT_GATEWAY_CLEARING',
          creditAccount: `LIABILITIES:USER_WALLET:${userId}`,
          amountPaise: amountPaise
        },
        reason,
        createdAt: new Date()
      }, { session });
    });
  } catch (err) {
    console.error('[Compensating Refund Error]', err.message);
  }
}

// ─── GET /api/wallet/balance ──────────────────────────────────────────────────
router.get('/balance', authenticate, async (req, res) => {
  const userId = req.user.id;
  const db = getDb();

  const wallet = await db.collection('Wallets').findOne({ userId: String(userId) });
  if (!wallet) return res.status(404).json({ error: 'WALLET_NOT_FOUND' });

  res.json({
    userId: String(userId),
    balancePaise: wallet.balance,
    balanceINR: (wallet.balance / 100).toFixed(2),
    updatedAt: wallet.updatedAt
  });
});

// ─── GET /api/wallet/history ──────────────────────────────────────────────────
router.get('/history', authenticate, async (req, res) => {
  const userId = req.user.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const before = req.query.before ? new Date(req.query.before) : new Date();
  const db = getDb();

  const entries = await db.collection('Ledger')
    .find({ userId: String(userId), createdAt: { $lt: before } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  res.json({
    userId: String(userId),
    count: entries.length,
    entries: entries.map(e => ({
      id: e._id,
      type: e.type,
      amountPaise: e.amount,
      amountINR: (e.amount / 100).toFixed(2),
      balanceAfterINR: (e.balanceAfter / 100).toFixed(2),
      status: e.status,
      createdAt: e.createdAt
    }))
  });
});

// ─── GET /api/wallet/payout/:payoutId ────────────────────────────────────────
router.get('/payout/:payoutId', authenticate, async (req, res) => {
  const userId = req.user.id;
  const db = getDb();

  let oid;
  try { oid = new ObjectId(req.params.payoutId); }
  catch { return res.status(400).json({ error: 'INVALID_PAYOUT_ID' }); }

  const payout = await db.collection('PayoutRequests').findOne({
    _id: oid,
    userId: String(userId)
  });

  if (!payout) return res.status(404).json({ error: 'PAYOUT_NOT_FOUND' });

  res.json({
    payoutId: payout._id,
    status: payout.status,
    reference: payout.reference,
    amountPaise: payout.amount,
    amountINR: (payout.amount / 100).toFixed(2),
    utr: payout.utr || null,
    failureReason: payout.failureReason || null,
    createdAt: payout.createdAt,
    updatedAt: payout.updatedAt
  });
});

module.exports = router;

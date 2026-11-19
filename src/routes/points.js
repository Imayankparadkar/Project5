/**
 * src/routes/points.js
 * Reward Points API: Earn & Convert Engine
 * 
 * Complies with Section 4.B & 4.C of the Antigravity Technical Brief:
 * - Earn and convert are executed within atomic multi-document ACID transactions.
 * - Idempotency is enforced with unique indexes and SHA-256 payload hash verification.
 * - Same idempotency key with different payload returns HTTP 409 Conflict.
 * - Duplicate earn requests return stable duplicate responses without modifying balances.
 * - RBAC enforced: ordinary users cannot issue ADMIN_ADJUSTMENT points (403 Forbidden).
 */

const express = require('express');
const crypto = require('crypto');
const { ObjectId, Decimal128 } = require('mongodb');
const router = express.Router();

const { getDb, runInTransaction } = require('../db');
const { authenticate } = require('../middleware/auth');
const { validatePointEarning, validatePointConversion } = require('../middleware/validate');

function extractDoc(result) {
  if (!result) return null;
  return result.value !== undefined ? result.value : result;
}

function computePointsPayloadHash(userId, points) {
  return crypto.createHash('sha256').update(`${userId}:${points}`).digest('hex');
}

// ─── POST /api/points/earn ────────────────────────────────────────────────────
router.post('/earn', authenticate, validatePointEarning, async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  const { points, source, referenceId, expiresInDays } = req.validatedEarn;
  const db = getDb();

  // Role check: Only administrators can grant ADMIN_ADJUSTMENT points
  if (source === 'ADMIN_ADJUSTMENT' && userRole !== 'admin') {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Only administrators are authorized to award ADMIN_ADJUSTMENT points.'
    });
  }

  // Pre-fetch user to determine cohort
  let user;
  try {
    user = await db.collection('Users').findOne(
      { $or: [{ _id: new ObjectId(userId) }, { _id: userId }] },
      { projection: { cohort: 1, status: 1 } }
    );
  } catch {
    user = await db.collection('Users').findOne(
      { _id: userId },
      { projection: { cohort: 1, status: 1 } }
    );
  }

  if (!user || user.status !== 'ACTIVE') {
    return res.status(404).json({ error: 'USER_NOT_FOUND_OR_INACTIVE' });
  }

  const cohort = user.cohort || 'UNKNOWN';
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null;

  try {
    const result = await runInTransaction(async (session) => {
      // 1. Check if business reference already exists (Fast In-Tx Idempotency Check)
      const existingTxn = await db.collection('PointTransactions').findOne(
        { referenceId, source },
        { session }
      );

      if (existingTxn) {
        // Fetch current balance to return stable response
        const pw = await db.collection('PointWallets').findOne({ userId: String(userId) }, { session });
        return {
          duplicate: true,
          pointsAwarded: existingTxn.points,
          currentBalance: pw ? pw.availablePoints : 0,
          expiresAt: existingTxn.expiresAt || null
        };
      }

      // 2. Atomic Point Wallet Upsert
      const rawPw = await db.collection('PointWallets').findOneAndUpdate(
        { userId: String(userId) },
        {
          $inc: { availablePoints: points, lifetimeEarned: points },
          $set: { updatedAt: new Date() },
          $setOnInsert: {
            userId: String(userId),
            lifetimeConverted: 0,
            lifetimeExpired: 0,
            createdAt: new Date()
          }
        },
        { upsert: true, returnDocument: 'after', session }
      );
      const updatedPw = extractDoc(rawPw);

      // 3. Insert EARNED record in immutable ledger
      const txnDoc = {
        userId: String(userId),
        cohort,
        type: 'EARNED',
        source,
        points,
        referenceId,
        rateUsed: null,
        cashCreditedPaise: null,
        walletLedgerId: null,
        expiresAt,
        createdAt: new Date()
      };
      await db.collection('PointTransactions').insertOne(txnDoc, { session });

      return {
        duplicate: false,
        pointsAwarded: points,
        currentBalance: updatedPw.availablePoints,
        expiresAt
      };
    });

    if (result.duplicate) {
      return res.status(200).json({
        ok: true,
        idempotent: true,
        pointsAwarded: result.pointsAwarded,
        newBalance: result.currentBalance,
        expiresAt: result.expiresAt,
        message: 'Points have already been awarded for this reference.'
      });
    }

    return res.status(201).json({
      ok: true,
      pointsAwarded: result.pointsAwarded,
      newBalance: result.currentBalance,
      expiresAt: result.expiresAt
    });

  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key on unique business reference { referenceId, source }
      const pw = await db.collection('PointWallets').findOne({ userId: String(userId) });
      return res.status(200).json({
        ok: true,
        idempotent: true,
        message: 'Points have already been awarded for this reference.',
        newBalance: pw ? pw.availablePoints : 0
      });
    }
    console.error('[Points/Earn] Error:', err.message);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ─── POST /api/points/convert ─────────────────────────────────────────────────
router.post('/convert', authenticate, validatePointConversion, async (req, res) => {
  const userId = req.user.id;
  const pointsToConvert = req.pointsToConvert;
  const idemKey = req.idempotencyKey;
  const db = getDb();

  const currentPayloadHash = computePointsPayloadHash(userId, pointsToConvert);

  // Fast pre-check: Look for existing conversion with this idempotency key
  const existingConv = await db.collection('PointTransactions').findOne({
    userId: String(userId),
    'meta.idempotencyKey': idemKey
  });

  if (existingConv) {
    if (existingConv.meta && existingConv.meta.requestHash !== currentPayloadHash) {
      return res.status(409).json({
        error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        message: 'This idempotency key was already used with a different point conversion amount.'
      });
    }

    return res.status(200).json({
      ok: true,
      idempotent: true,
      pointsConverted: existingConv.points,
      cashCreditedPaise: existingConv.cashCreditedPaise,
      cashCreditedINR: (existingConv.cashCreditedPaise / 100).toFixed(2),
      message: 'Conversion already processed. Returning original result.'
    });
  }

  // Pre-fetch active conversion rate
  const rateDoc = await db.collection('PointConversionRates').findOne(
    { effectiveTo: null },
    { sort: { effectiveFrom: -1 } }
  );

  if (!rateDoc) {
    return res.status(503).json({
      error: 'NO_ACTIVE_RATE',
      message: 'Point conversion is currently unavailable. No active rate configured.'
    });
  }

  const rateFloat = parseFloat(rateDoc.rateInInr.toString());
  const paisePerPoint = Math.round(rateFloat * 100);
  const cashToCreditPaise = pointsToConvert * paisePerPoint;

  let user;
  try {
    user = await db.collection('Users').findOne(
      { $or: [{ _id: new ObjectId(userId) }, { _id: userId }] },
      { projection: { cohort: 1 } }
    );
  } catch {
    user = await db.collection('Users').findOne(
      { _id: userId },
      { projection: { cohort: 1 } }
    );
  }

  const cohort = user?.cohort || 'UNKNOWN';

  try {
    const conversionResult = await runInTransaction(async (session) => {
      // 1. In-Tx Idempotency & Payload Mismatch Check
      const inTxExisting = await db.collection('PointTransactions').findOne(
        { userId: String(userId), 'meta.idempotencyKey': idemKey },
        { session }
      );

      if (inTxExisting) {
        if (inTxExisting.meta && inTxExisting.meta.requestHash !== currentPayloadHash) {
          throw new Error('IDEMPOTENCY_PAYLOAD_MISMATCH');
        }
        return {
          isDuplicate: true,
          pointsConverted: inTxExisting.points,
          cashCreditedPaise: inTxExisting.cashCreditedPaise
        };
      }

      // 2. Atomic Conditional Point Decrement
      const rawPw = await db.collection('PointWallets').findOneAndUpdate(
        {
          userId: String(userId),
          availablePoints: { $gte: pointsToConvert } // Atomic balance guard
        },
        {
          $inc: { availablePoints: -pointsToConvert, lifetimeConverted: pointsToConvert },
          $set: { updatedAt: new Date() }
        },
        { returnDocument: 'after', session }
      );
      const updatedPw = extractDoc(rawPw);

      if (!updatedPw) {
        throw new Error('INSUFFICIENT_POINTS');
      }

      // 3. Credit cash to Wallets
      const rawWallet = await db.collection('Wallets').findOneAndUpdate(
        { userId: String(userId) },
        {
          $inc: { balance: cashToCreditPaise },
          $set: { updatedAt: new Date() }
        },
        { upsert: true, returnDocument: 'after', session }
      );
      const updatedWallet = extractDoc(rawWallet);

      // 4. Double-Entry Cash Ledger Entry
      const ledgerEntry = await db.collection('Ledger').insertOne({
        userId: String(userId),
        type: 'POINTS_CONVERSION_CREDIT',
        amount: cashToCreditPaise,
        balanceAfter: updatedWallet.balance,
        doubleEntry: {
          debitAccount: 'EXPENSES:PROMOTIONAL_REWARDS_CONVERSION',
          creditAccount: `LIABILITIES:USER_WALLET:${userId}`,
          amountPaise: cashToCreditPaise
        },
        status: 'SETTLED',
        createdAt: new Date()
      }, { session });

      // 5. Point Transaction Record
      await db.collection('PointTransactions').insertOne({
        userId: String(userId),
        cohort,
        type: 'CONVERTED',
        source: 'CASH_CONVERSION',
        points: pointsToConvert,
        referenceId: `CONV-${idemKey}`,
        rateUsed: rateDoc.rateInInr,
        cashCreditedPaise: cashToCreditPaise,
        walletLedgerId: ledgerEntry.insertedId,
        meta: {
          idempotencyKey: idemKey,
          requestHash: currentPayloadHash
        },
        createdAt: new Date()
      }, { session });

      return {
        isDuplicate: false,
        pointsConverted: pointsToConvert,
        cashCreditedPaise: cashToCreditPaise,
        newPointBalance: updatedPw.availablePoints,
        newCashBalancePaise: updatedWallet.balance
      };
    });

    if (conversionResult.isDuplicate) {
      return res.status(200).json({
        ok: true,
        idempotent: true,
        pointsConverted: conversionResult.pointsConverted,
        cashCreditedPaise: conversionResult.cashCreditedPaise,
        cashCreditedINR: (conversionResult.cashCreditedPaise / 100).toFixed(2),
        message: 'Conversion already processed. Returning original result.'
      });
    }

    return res.status(200).json({
      ok: true,
      pointsConverted: conversionResult.pointsConverted,
      cashCreditedPaise: conversionResult.cashCreditedPaise,
      cashCreditedINR: (conversionResult.cashCreditedPaise / 100).toFixed(2),
      rateUsed: rateDoc.rateInInr.toString(),
      newPointBalance: conversionResult.newPointBalance,
      newCashBalanceINR: (conversionResult.newCashBalancePaise / 100).toFixed(2)
    });

  } catch (err) {
    if (err.message === 'INSUFFICIENT_POINTS') {
      return res.status(400).json({
        error: 'INSUFFICIENT_POINTS',
        message: 'You do not have enough available reward points for this conversion.'
      });
    }
    if (err.message === 'IDEMPOTENCY_PAYLOAD_MISMATCH' || err.code === 11000) {
      return res.status(409).json({
        error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        message: 'A conversion with this idempotency key was already submitted with different parameters.'
      });
    }
    console.error('[Points/Convert] Error:', err.message);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ─── GET /api/points/balance ──────────────────────────────────────────────────
router.get('/balance', authenticate, async (req, res) => {
  const userId = req.user.id;
  const pw = await getDb().collection('PointWallets').findOne({ userId: String(userId) });
  res.json({
    userId: String(userId),
    availablePoints: pw ? pw.availablePoints : 0,
    lifetimeEarned: pw ? pw.lifetimeEarned : 0,
    lifetimeConverted: pw ? pw.lifetimeConverted : 0,
    lifetimeExpired: pw ? pw.lifetimeExpired : 0
  });
});

// ─── GET /api/points/history ──────────────────────────────────────────────────
router.get('/history', authenticate, async (req, res) => {
  const userId = req.user.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const before = req.query.before ? new Date(req.query.before) : new Date();

  const entries = await getDb().collection('PointTransactions')
    .find({ userId: String(userId), createdAt: { $lt: before } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .project({ 'meta.requestHash': 0 })
    .toArray();

  res.json({ userId: String(userId), count: entries.length, entries });
});

// ─── GET /api/points/rate ─────────────────────────────────────────────────────
router.get('/rate', async (_req, res) => {
  const rateDoc = await getDb().collection('PointConversionRates').findOne(
    { effectiveTo: null },
    { sort: { effectiveFrom: -1 } }
  );

  if (!rateDoc) {
    return res.status(503).json({ error: 'NO_ACTIVE_RATE', message: 'No active conversion rate configured.' });
  }

  const rateFloat = parseFloat(rateDoc.rateInInr.toString());
  res.json({
    rateInInr: rateDoc.rateInInr.toString(),
    rateDescription: `1 point = ₹${rateFloat.toFixed(2)} = ${Math.round(rateFloat * 100)} paise`,
    effectiveFrom: rateDoc.effectiveFrom
  });
});

module.exports = router;

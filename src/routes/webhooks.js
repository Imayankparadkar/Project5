/**
 * src/routes/webhooks.js
 * Cryptographically Verified Gateway Webhook Pipeline
 * 
 * Complies with Section 4.E of the Antigravity Technical Brief:
 * - Mandatory HMAC-SHA256 signature verification (rejects missing/invalid signatures).
 * - Duplicate event deduplication (idempotent webhook processing).
 * - Strict state transition validation:
 *   - Prevents silent overwriting if a failed payout receives a subsequent success webhook.
 *   - Executes compensating refund strictly once upon confirmed terminal failure.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { getDb, runInTransaction } = require('../db');

function extractDoc(result) {
  if (!result) return null;
  return result.value !== undefined ? result.value : result;
}

const WEBHOOK_SECRET = process.env.GATEWAY_WEBHOOK_SECRET || 'funngro_gateway_webhook_secret_development';

// ─── POST /api/webhooks/gateway ──────────────────────────────────────────────
router.post('/gateway', async (req, res) => {
  const db = getDb();
  const signature = req.headers['x-gateway-signature'];

  // 1. Mandatory Cryptographic HMAC-SHA256 Signature Verification
  if (!signature || typeof signature !== 'string') {
    return res.status(401).json({
      error: 'MISSING_SIGNATURE',
      message: 'x-gateway-signature header is mandatory for webhook processing.'
    });
  }

  const rawPayload = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawPayload)
    .digest('hex');

  const signaturesMatch = crypto.timingSafeEqual(
    Buffer.from(signature.padEnd(64, '0')),
    Buffer.from(expectedSignature.padEnd(64, '0'))
  );

  if (!signaturesMatch) {
    return res.status(401).json({
      error: 'INVALID_SIGNATURE',
      message: 'Cryptographic signature verification failed.'
    });
  }

  const { eventId, event, data } = req.body || {};
  if (!event || !data || !data.reference) {
    return res.status(400).json({
      error: 'INVALID_PAYLOAD',
      message: 'Webhook payload missing required event or data.reference fields.'
    });
  }

  // 2. Duplicate Event Idempotency Check
  const effectiveEventId = eventId || `${data.reference}:${event}:${data.status || ''}`;
  try {
    const existingEvent = await db.collection('ProcessedWebhookEvents').findOne({ eventId: effectiveEventId });
    if (existingEvent) {
      return res.status(200).json({
        ok: true,
        idempotent: true,
        message: 'Webhook event was already processed.'
      });
    }
  } catch (err) {
    // Non-fatal if collection doesn't exist yet
  }

  // Find associated payout record
  const payout = await db.collection('PayoutRequests').findOne({ reference: data.reference });
  if (!payout) {
    return res.status(404).json({
      error: 'PAYOUT_NOT_FOUND',
      message: `No payout record found matching reference ${data.reference}.`
    });
  }

  // 3. Process Settlement Event (SUCCESS)
  if (event === 'payout.settled' || event === 'payout.success') {
    // Guard against illegal state transition: Failed payout receives later success webhook
    if (payout.status === 'FAILED') {
      console.error(`[CRITICAL FINTECH ALERT] Payout ${payout.reference} was already marked FAILED/refunded, but received late success webhook!`);
      await db.collection('PayoutRequests').updateOne(
        { _id: payout._id },
        {
          $set: {
            reconciliationAlert: 'LATE_SUCCESS_AFTER_FAILURE',
            gatewaySettlementPayload: data,
            updatedAt: new Date()
          }
        }
      );
      return res.status(422).json({
        error: 'ILLEGAL_STATE_TRANSITION',
        message: 'Payout was previously marked FAILED and refunded. Escalated for manual banking reconciliation.'
      });
    }

    if (payout.status === 'SETTLED') {
      return res.status(200).json({ ok: true, idempotent: true, status: 'SETTLED' });
    }

    await db.collection('PayoutRequests').updateOne(
      { _id: payout._id },
      {
        $set: {
          status: 'SETTLED',
          utr: data.utr || payout.utr || null,
          settledAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

    await db.collection('Ledger').updateOne(
      { payoutId: payout._id },
      { $set: { status: 'SETTLED', updatedAt: new Date() } }
    );

    await db.collection('ProcessedWebhookEvents').insertOne({
      eventId: effectiveEventId,
      reference: data.reference,
      event,
      processedAt: new Date()
    }).catch(() => {});

    return res.status(200).json({ ok: true, status: 'SETTLED' });
  }

  // 4. Process Failure Event (FAILED)
  if (event === 'payout.failed' || event === 'payout.rejected') {
    if (payout.status === 'FAILED') {
      return res.status(200).json({ ok: true, idempotent: true, status: 'FAILED' });
    }

    if (payout.status === 'SETTLED') {
      return res.status(422).json({
        error: 'ILLEGAL_STATE_TRANSITION',
        message: 'Payout was already SETTLED. Cannot transition to FAILED without chargeback dispute process.'
      });
    }

    // Execute atomic conditional refund within transaction
    try {
      await runInTransaction(async (session) => {
        const rawPayout = await db.collection('PayoutRequests').findOneAndUpdate(
          {
            _id: payout._id,
            status: { $in: ['PENDING_DISPATCH', 'PROCESSING', 'DISPATCHING', 'DISPATCHED', 'PENDING_RECONCILIATION'] }
          },
          {
            $set: {
              status: 'FAILED',
              failureReason: data.failureReason || 'Webhook reported failure',
              refundedAt: new Date(),
              updatedAt: new Date()
            }
          },
          { returnDocument: 'after', session }
        );
        const updatedPayout = extractDoc(rawPayout);

        if (!updatedPayout) {
          // Already refunded in another thread
          return;
        }

        const rawWallet = await db.collection('Wallets').findOneAndUpdate(
          { userId: String(updatedPayout.userId) },
          { $inc: { balance: updatedPayout.amount }, $set: { updatedAt: new Date() } },
          { returnDocument: 'after', session }
        );
        const walletDoc = extractDoc(rawWallet);

        await db.collection('Ledger').insertOne({
          userId: String(updatedPayout.userId),
          payoutId: updatedPayout._id,
          type: 'WITHDRAWAL_REFUND',
          amount: updatedPayout.amount,
          balanceAfter: walletDoc ? walletDoc.balance : 0,
          doubleEntry: {
            debitAccount: 'ASSETS:PAYMENT_GATEWAY_CLEARING',
            creditAccount: `LIABILITIES:USER_WALLET:${updatedPayout.userId}`,
            amountPaise: updatedPayout.amount
          },
          reason: data.failureReason || 'Webhook reported failure',
          createdAt: new Date()
        }, { session });

        await db.collection('ProcessedWebhookEvents').insertOne({
          eventId: effectiveEventId,
          reference: data.reference,
          event,
          processedAt: new Date()
        }, { session });
      });

      return res.status(200).json({ ok: true, status: 'REFUNDED' });

    } catch (refundErr) {
      console.error('[Webhook Refund Error]', refundErr.message);
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: refundErr.message });
    }
  }

  return res.status(200).json({ ok: true, message: `Event ${event} acknowledged.` });
});

module.exports = router;

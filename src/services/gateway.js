/**
 * src/services/gateway.js
 * Payment Gateway Client Adapter (Razorpay/Cashfree/Bank IMPS Simulation)
 * 
 * Complies with Section 3 & 4.E of the Antigravity Technical Brief:
 * - Amount Unit Contract: Amount is handled strictly as an integer in PAISE (no floating-point conversions).
 * - Rigorously discriminates between Terminal Rejections vs Transient Timeouts.
 * - Simulates real banking behaviors: invalid IFSC triggers terminal failure; slow IFSC triggers transient timeout.
 */

const TERMINAL_GATEWAY_ERRORS = [
  'INVALID_ACCOUNT',
  'INVALID_IFSC',
  'BENEFICIARY_SUSPENDED',
  'ACCOUNT_CLOSED',
  'ACCOUNT_BLOCKED'
];

/**
 * Dispatches payout instruction to the payment gateway partner.
 * 
 * @param {Object} options
 * @param {Object} options.account - { accountNumber, ifsc, beneficiaryName }
 * @param {number} options.amount - Amount strictly as positive integer in PAISE (e.g. 10000 = ₹100.00)
 * @param {string} options.reference - Deterministic payout reference (e.g. 'WD-<payoutId>')
 * @returns {Promise<Object>}
 */
async function createPayout({ account, amount, reference }) {
  if (!account || !account.accountNumber || !account.ifsc) {
    const err = new Error('INVALID_ACCOUNT: Incomplete beneficiary bank account or IFSC.');
    err.code = 'INVALID_ACCOUNT';
    err.isTerminal = true; // Definitive failure — safe to refund
    throw err;
  }

  // Simulation Rule: IFSC starting with 'FAIL' simulates bank rejection
  if (account.ifsc.startsWith('FAIL') || account.accountNumber.startsWith('FAIL')) {
    const err = new Error('INVALID_IFSC: Banking partner rejected account/IFSC combination.');
    err.code = 'INVALID_IFSC';
    err.isTerminal = true; // Definitive failure — safe to refund
    throw err;
  }

  // Simulation Rule: IFSC starting with 'SLOW' or 'TIMEOUT' simulates banking switch timeout
  if (account.ifsc.startsWith('SLOW') || account.ifsc.startsWith('TIMEOUT')) {
    const err = new Error('GATEWAY_TIMEOUT: IMPS switch timed out before acknowledgement.');
    err.code = 'GATEWAY_TIMEOUT';
    err.isTerminal = false; // Unknown outcome — NEVER auto-refund!
    throw err;
  }

  // Success Response
  return {
    id: `GW-${reference}-${Date.now()}`,
    status: 'PROCESSING',
    reference: reference,
    amountPaise: amount,
    utr: `UTR${Math.floor(100000000000 + Math.random() * 900000000000)}`,
    createdAt: new Date().toISOString()
  };
}

/**
 * Queries the current payout status from the payment gateway.
 * Used for reconciliation polling and incident recovery.
 */
async function getPayoutStatus(reference) {
  if (!reference) throw new Error('Reference required.');

  // For testing/simulation, deterministically return status based on reference name
  if (reference.includes('FAIL')) {
    return {
      reference,
      status: 'FAILED',
      failureReason: 'Account rejected by beneficiary bank.',
      utr: null
    };
  }

  return {
    reference,
    status: 'SETTLED',
    utr: `UTR${Math.floor(100000000000 + Math.random() * 900000000000)}`,
    settledAt: new Date().toISOString()
  };
}

module.exports = {
  createPayout,
  getPayoutStatus,
  TERMINAL_GATEWAY_ERRORS
};

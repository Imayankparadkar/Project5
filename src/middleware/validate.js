/**
 * src/middleware/validate.js
 * Defensive Validation Middleware for Monetary & Points Operations
 * 
 * Complies with Section 3 & 6 of the Antigravity Technical Brief:
 * - Uses Number.isSafeInteger() strictly for all monetary paise and point values.
 * - Enforces positive values, operational bounds, idempotency key lengths, and pagination limits.
 * - Returns consistent HTTP 400 errors with structured error payloads.
 */

const MIN_WITHDRAWAL_PAISE = 100 * 100;     // ₹100.00 minimum (10,000 paise)
const MAX_WITHDRAWAL_PAISE = 10000 * 100;   // ₹10,000.00 maximum (1,000,000 paise)
const MIN_POINTS_CONVERSION = 100;          // 100 points minimum to convert
const MAX_POINTS_CONVERSION = 1000000;      // 1,000,000 points maximum per conversion

function validateWithdrawal(req, res, next) {
  const body = req.body || {};
  const amount = body.amount;
  const idempotencyKey = req.headers['x-idempotency-key'] || body.idempotencyKey;

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length < 16) {
    return res.status(400).json({
      error: 'INVALID_IDEMPOTENCY_KEY',
      message: 'A unique x-idempotency-key header or body property of at least 16 characters is required.'
    });
  }

  if (amount === undefined || !Number.isSafeInteger(amount) || amount <= 0) {
    return res.status(400).json({
      error: 'INVALID_AMOUNT',
      message: 'Amount must be a positive safe integer in paise (1 INR = 100 paise).'
    });
  }

  if (amount < MIN_WITHDRAWAL_PAISE) {
    return res.status(400).json({
      error: 'AMOUNT_BELOW_MINIMUM',
      message: `Minimum withdrawal is ₹${MIN_WITHDRAWAL_PAISE / 100} (${MIN_WITHDRAWAL_PAISE} paise).`
    });
  }

  if (amount > MAX_WITHDRAWAL_PAISE) {
    return res.status(400).json({
      error: 'AMOUNT_EXCEEDS_MAXIMUM',
      message: `Maximum withdrawal is ₹${MAX_WITHDRAWAL_PAISE / 100} (${MAX_WITHDRAWAL_PAISE} paise) per request.`
    });
  }

  req.validatedAmount = amount;
  req.idempotencyKey = idempotencyKey.trim();
  next();
}

function validatePointConversion(req, res, next) {
  const body = req.body || {};
  const points = body.points;
  const idempotencyKey = req.headers['x-idempotency-key'] || body.idempotencyKey;

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length < 16) {
    return res.status(400).json({
      error: 'INVALID_IDEMPOTENCY_KEY',
      message: 'A unique x-idempotency-key header or body property of at least 16 characters is required.'
    });
  }

  if (points === undefined || !Number.isSafeInteger(points) || points <= 0) {
    return res.status(400).json({
      error: 'INVALID_POINTS',
      message: 'Points must be a positive safe integer.'
    });
  }

  if (points < MIN_POINTS_CONVERSION) {
    return res.status(400).json({
      error: 'POINTS_BELOW_MINIMUM',
      message: `Minimum point conversion threshold is ${MIN_POINTS_CONVERSION} points.`
    });
  }

  if (points > MAX_POINTS_CONVERSION) {
    return res.status(400).json({
      error: 'POINTS_EXCEEDS_MAXIMUM',
      message: `Maximum point conversion threshold is ${MAX_POINTS_CONVERSION} points per request.`
    });
  }

  req.pointsToConvert = points;
  req.idempotencyKey = idempotencyKey.trim();
  next();
}

function validatePointEarning(req, res, next) {
  const body = req.body || {};
  const { points, source, referenceId, expiresInDays } = body;

  if (points === undefined || !Number.isSafeInteger(points) || points <= 0) {
    return res.status(400).json({
      error: 'INVALID_POINTS',
      message: 'Points must be a positive safe integer.'
    });
  }

  const VALID_SOURCES = ['PROJECT_COMPLETION', 'PROMO_EVENT', 'ADMIN_ADJUSTMENT'];
  if (!source || typeof source !== 'string' || !VALID_SOURCES.includes(source)) {
    return res.status(400).json({
      error: 'INVALID_SOURCE',
      message: `source must be one of: ${VALID_SOURCES.join(', ')}`
    });
  }

  if (!referenceId || typeof referenceId !== 'string' || referenceId.trim().length === 0) {
    return res.status(400).json({
      error: 'INVALID_REFERENCE_ID',
      message: 'A non-empty referenceId string is required for idempotent point earning.'
    });
  }

  if (expiresInDays !== undefined) {
    if (!Number.isSafeInteger(expiresInDays) || expiresInDays <= 0 || expiresInDays > 3650) {
      return res.status(400).json({
        error: 'INVALID_EXPIRY',
        message: 'expiresInDays must be a positive safe integer between 1 and 3650 days.'
      });
    }
  }

  req.validatedEarn = {
    points,
    source,
    referenceId: referenceId.trim(),
    expiresInDays: expiresInDays || null
  };
  next();
}

function validateReportParams(req, res, next) {
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);

  if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({
      error: 'INVALID_YEAR',
      message: 'year must be a valid four-digit integer between 2000 and 2100.'
    });
  }

  if (!Number.isSafeInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({
      error: 'INVALID_MONTH',
      message: 'month must be a valid integer between 1 and 12.'
    });
  }

  let limit = 20;
  if (req.query.limit !== undefined) {
    const parsedLimit = parseInt(req.query.limit, 10);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({
        error: 'INVALID_LIMIT',
        message: 'limit must be a positive integer between 1 and 100.'
      });
    }
    limit = parsedLimit;
  }

  let page = 1;
  if (req.query.page !== undefined) {
    const parsedPage = parseInt(req.query.page, 10);
    if (!Number.isSafeInteger(parsedPage) || parsedPage < 1) {
      return res.status(400).json({
        error: 'INVALID_PAGE',
        message: 'page must be a positive integer >= 1.'
      });
    }
    page = parsedPage;
  }

  req.validatedReport = {
    year,
    month,
    cohort: req.query.cohort ? String(req.query.cohort).trim() : null,
    limit,
    page
  };
  next();
}

module.exports = {
  validateWithdrawal,
  validatePointConversion,
  validatePointEarning,
  validateReportParams,
  MIN_WITHDRAWAL_PAISE,
  MAX_WITHDRAWAL_PAISE,
  MIN_POINTS_CONVERSION,
  MAX_POINTS_CONVERSION
};

/**
 * src/middleware/auth.js
 * Verified JWT Authentication & Role-Based Access Control (RBAC)
 * 
 * Complies with Section 4.A of the Antigravity Technical Brief:
 * - Eliminates unverified trust in client-supplied X-User-Id.
 * - Enforces cryptographically signed JWT verification.
 * - Implements RBAC: Ordinary users cannot perform admin adjustments or view finance reports.
 * - Retains dev bypass ONLY when explicitly enabled via ALLOW_DEV_AUTH_BYPASS=true (disabled by default).
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'funngro_jwt_secret_development_only';

/**
 * Generates a signed JWT token for users and service accounts.
 * Used by authentication flows and automated test suites.
 */
function generateToken({ id, role = 'user' }, expiresIn = '7d') {
  if (!id) throw new Error('Cannot generate token without user id.');
  return jwt.sign(
    { sub: id.toString(), role: role || 'user' },
    JWT_SECRET,
    { expiresIn }
  );
}

/**
 * Authentication Middleware
 * Validates Authorization: Bearer <token>
 */
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = {
        id: decoded.sub,
        role: decoded.role || 'user'
      };
      return next();
    } catch (err) {
      return res.status(401).json({
        error: 'INVALID_TOKEN',
        message: 'The provided authentication token is invalid or expired.'
      });
    }
  }

  // Explicit, gated development bypass (strictly disabled by default in production)
  if (process.env.ALLOW_DEV_AUTH_BYPASS === 'true' && req.headers['x-user-id']) {
    req.user = {
      id: req.headers['x-user-id'],
      role: req.headers['x-user-role'] || 'user'
    };
    return next();
  }

  return res.status(401).json({
    error: 'UNAUTHORIZED',
    message: 'Authentication required. Please provide a valid Bearer token in the Authorization header.'
  });
}

/**
 * Role-Based Access Control (RBAC) Middleware
 * Restricts access to specified roles (e.g., 'admin', 'finance')
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `Access denied. Requires one of the following roles: ${allowedRoles.join(', ')}`
      });
    }

    next();
  };
}

module.exports = {
  authenticate,
  requireRole,
  generateToken
};

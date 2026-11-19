/**
 * server.js - Funngro Backend Assessment Service Entrypoint
 * 
 * Complies with Section 3 of the Antigravity Technical Brief:
 * - One clear MongoDB connection path confirming replica-set transaction support.
 * - Captures raw request buffer for cryptographically verified webhook signatures.
 * - Implements graceful shutdown and clean connection termination.
 */

require('dotenv').config();

const express = require('express');
const { connect, disconnect, getDb, getSupportsTransactions } = require('./src/db');
const { createIndexes } = require('./src/setup/indexes');

const walletRoutes = require('./src/routes/wallet');
const pointsRoutes = require('./src/routes/points');
const reportsRoutes = require('./src/routes/reports');
const webhookRoutes = require('./src/routes/webhooks');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Global Middleware ────────────────────────────────────────────────────────
// Captures rawBody buffer for HMAC-SHA256 signature verification on webhooks
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

// Request logging (Lightweight audit trail)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Health & Readiness Check ─────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    replicaSetTransactions: getSupportsTransactions()
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/wallet', walletRoutes);
app.use('/api/points', pointsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/webhooks', webhookRoutes);

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Requested endpoint does not exist.' });
});

// ─── Centralized Error Handler ────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
});

// ─── Application Bootstrap ────────────────────────────────────────────────────
let serverInstance = null;

async function startServer() {
  try {
    const db = await connect();
    await createIndexes(db);

    serverInstance = app.listen(PORT, () => {
      console.log('');
      console.log('══════════════════════════════════════════════════════════════════');
      console.log(`  🚀 Funngro Backend Active at http://localhost:${PORT}`);
      console.log(`  🍃 MongoDB Replica Set Transactions: ${getSupportsTransactions() ? 'ENABLED' : 'DISABLED (Standalone)'}`);
      console.log('══════════════════════════════════════════════════════════════════');
      console.log('  Endpoints:');
      console.log('    POST /api/wallet/withdraw          (Payout Initiation)');
      console.log('    GET  /api/wallet/balance           (Wallet Balance)');
      console.log('    GET  /api/wallet/history           (Paginated Ledger)');
      console.log('    POST /api/points/earn              (Award Points)');
      console.log('    POST /api/points/convert           (Convert Points to Cash)');
      console.log('    GET  /api/points/balance           (Point Wallet Balance)');
      console.log('    GET  /api/reports/monthly-points   (Finance Cohort Aggregation - Admin)');
      console.log('    POST /api/webhooks/gateway         (Gateway Webhook Reconciliation)');
      console.log('    GET  /health                       (Service Health)');
      console.log('══════════════════════════════════════════════════════════════════\n');
    });

    return serverInstance;
  } catch (err) {
    console.error('[Bootstrap Error]', err.message);
    process.exit(1);
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
async function shutdown() {
  console.log('\n[Server] Shutting down gracefully...');
  if (serverInstance) {
    await new Promise((resolve) => serverInstance.close(resolve));
  }
  await disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };

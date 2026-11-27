/**
 * src/setup/seed.js
 * Database Seeder for Local Development & Testing
 * 
 * Complies with Section 3 & 6 of the Antigravity Technical Brief:
 * - Destructive reset is explicitly restricted to development environments.
 * - Standardizes string user IDs consistently across all collections.
 * - Seeds users with RBAC roles ('user' and 'admin').
 * - Prints valid Bearer JWT tokens for instant, zero-friction API testing.
 */

require('dotenv').config();
const { ObjectId, Decimal128 } = require('mongodb');
const { connect, disconnect, getDb } = require('../db');
const { createIndexes } = require('./indexes');
const { generateToken } = require('../middleware/auth');

async function seed() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED_RESET !== 'true') {
    console.error('[Seed Error] Destructive database reset is strictly prohibited in production.');
    process.exit(1);
  }

  const db = await connect();

  console.log('[Seed] Clearing existing demo data...');
  const collections = [
    'Users',
    'Wallets',
    'Ledger',
    'PayoutRequests',
    'PointWallets',
    'PointTransactions',
    'PointConversionRates',
    'ProcessedWebhookEvents',
    'DailyWithdrawalLimits'
  ];

  for (const col of collections) {
    await db.collection(col).deleteMany({});
  }

  // Ensure production indexes
  await createIndexes(db);

  // 1. Seed Users (Alice = Verified, Bob = Verified, Charlie = Unverified, Admin = Admin Role)
  const aliceId = new ObjectId().toString();
  const bobId = new ObjectId().toString();
  const charlieId = new ObjectId().toString();
  const adminId = new ObjectId().toString();

  const users = [
    {
      _id: aliceId,
      name: 'Alice Kumar',
      email: 'alice@funngro.com',
      role: 'user',
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      cohort: '2026-09',
      bankAccount: {
        accountNumber: '11223344556677',
        ifsc: 'HDFC0001234',
        beneficiaryName: 'Alice Kumar',
        status: 'VERIFIED'
      },
      createdAt: new Date('2026-09-15T10:00:00Z')
    },
    {
      _id: bobId,
      name: 'Bob Sharma',
      email: 'bob@funngro.com',
      role: 'user',
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      cohort: '2026-10',
      bankAccount: {
        accountNumber: '99887766554433',
        ifsc: 'SBIN0005678',
        beneficiaryName: 'Bob Sharma',
        status: 'VERIFIED'
      },
      createdAt: new Date('2026-10-01T10:00:00Z')
    },
    {
      _id: charlieId,
      name: 'Charlie Verma',
      email: 'charlie@funngro.com',
      role: 'user',
      status: 'ACTIVE',
      kycStatus: 'PENDING',
      cohort: '2026-10',
      bankAccount: null, // No verified bank account
      createdAt: new Date('2026-10-20T10:00:00Z')
    },
    {
      _id: adminId,
      name: 'Admin Supervisor',
      email: 'admin@funngro.com',
      role: 'admin',
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      cohort: '2026-01',
      bankAccount: null,
      createdAt: new Date('2026-01-01T10:00:00Z')
    }
  ];
  await db.collection('Users').insertMany(users);

  // 2. Seed Wallets (Balances stored strictly as integer paise: 1 INR = 100 paise)
  const wallets = [
    { userId: aliceId, balance: 150000, updatedAt: new Date() }, // ₹1,500.00
    { userId: bobId, balance: 50000, updatedAt: new Date() },    // ₹500.00
    { userId: charlieId, balance: 20000, updatedAt: new Date() } // ₹200.00
  ];
  await db.collection('Wallets').insertMany(wallets);

  // 3. Seed Point Wallets
  const pointWallets = [
    {
      userId: aliceId,
      availablePoints: 850,
      lifetimeEarned: 1000,
      lifetimeConverted: 100,
      lifetimeExpired: 50,
      updatedAt: new Date()
    },
    {
      userId: bobId,
      availablePoints: 1500,
      lifetimeEarned: 1500,
      lifetimeConverted: 0,
      lifetimeExpired: 0,
      updatedAt: new Date()
    }
  ];
  await db.collection('PointWallets').insertMany(pointWallets);

  // 4. Seed Active Conversion Rate (1 point = ₹0.10 = 10 paise)
  await db.collection('PointConversionRates').insertOne({
    rateInInr: Decimal128.fromString('0.10'),
    effectiveFrom: new Date('2026-10-01T00:00:00Z'),
    effectiveTo: null,
    reason: 'Standard launch conversion rate',
    createdAt: new Date('2026-10-01T00:00:00Z')
  });

  // 5. Seed November 2026 Point Transactions for the Monthly Finance Report
  const pointTxns = [
    // Alice (Cohort 2026-09)
    {
      userId: aliceId,
      cohort: '2026-09',
      type: 'EARNED',
      source: 'PROJECT_COMPLETION',
      points: 500,
      referenceId: 'PROJ-SEED-101',
      rateUsed: null,
      cashCreditedPaise: null,
      walletLedgerId: null,
      createdAt: new Date('2026-11-05T10:00:00Z')
    },
    {
      userId: aliceId,
      cohort: '2026-09',
      type: 'EARNED',
      source: 'PROMO_EVENT',
      points: 500,
      referenceId: 'PROMO-DIWALI-2026',
      rateUsed: null,
      cashCreditedPaise: null,
      walletLedgerId: null,
      createdAt: new Date('2026-11-08T09:00:00Z')
    },
    {
      userId: aliceId,
      cohort: '2026-09',
      type: 'CONVERTED',
      source: 'CASH_CONVERSION',
      points: 100,
      referenceId: 'CONV-SEED-ALICE-01',
      rateUsed: Decimal128.fromString('0.10'),
      cashCreditedPaise: 1000, // ₹10.00
      walletLedgerId: new ObjectId(),
      meta: { idempotencyKey: 'idem-seed-alice-01' },
      createdAt: new Date('2026-11-12T14:00:00Z')
    },
    {
      userId: aliceId,
      cohort: '2026-09',
      type: 'EXPIRED',
      source: 'EXPIRY_JOB',
      points: 50,
      referenceId: 'EXP-SEED-ALICE-01',
      rateUsed: null,
      cashCreditedPaise: null,
      walletLedgerId: null,
      createdAt: new Date('2026-11-20T00:00:00Z')
    },
    // Bob (Cohort 2026-10)
    {
      userId: bobId,
      cohort: '2026-10',
      type: 'EARNED',
      source: 'PROJECT_COMPLETION',
      points: 1000,
      referenceId: 'PROJ-SEED-202',
      rateUsed: null,
      cashCreditedPaise: null,
      walletLedgerId: null,
      createdAt: new Date('2026-11-10T11:00:00Z')
    },
    {
      userId: bobId,
      cohort: '2026-10',
      type: 'CONVERTED',
      source: 'CASH_CONVERSION',
      points: 500,
      referenceId: 'CONV-SEED-BOB-01',
      rateUsed: Decimal128.fromString('0.10'),
      cashCreditedPaise: 5000, // ₹50.00
      walletLedgerId: new ObjectId(),
      meta: { idempotencyKey: 'idem-seed-bob-01' },
      createdAt: new Date('2026-11-15T16:00:00Z')
    }
  ];
  await db.collection('PointTransactions').insertMany(pointTxns);

  // Generate tokens for each user
  const aliceToken = generateToken({ id: aliceId, role: 'user' });
  const bobToken = generateToken({ id: bobId, role: 'user' });
  const charlieToken = generateToken({ id: charlieId, role: 'user' });
  const adminToken = generateToken({ id: adminId, role: 'admin' });

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  🎉 DATABASE SEEDING COMPLETED SUCCESSFULLY');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`  Alice   [Role: user,  Wallet: ₹1,500, Points: 850]:  ${aliceId}`);
  console.log(`  Bob     [Role: user,  Wallet: ₹500,   Points: 1500]: ${bobId}`);
  console.log(`  Charlie [Role: user,  Wallet: ₹200,   Unverified]:   ${charlieId}`);
  console.log(`  Admin   [Role: admin, Full Access]:                  ${adminId}`);
  console.log('──────────────────────────────────────────────────────────────────');
  console.log('  TEST TOKENS (Authorization: Bearer <token>):');
  console.log(`  Alice Token: ${aliceToken}`);
  console.log(`  Admin Token: ${adminToken}`);
  console.log('══════════════════════════════════════════════════════════════════\n');

  await disconnect();
}

if (require.main === module) {
  seed().catch((err) => {
    console.error('[Seed Error]', err);
    process.exit(1);
  });
}

module.exports = { seed };

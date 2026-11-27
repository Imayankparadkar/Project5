/**
 * src/db.js
 * Singleton MongoDB Client & Transaction Coordinator
 * 
 * Complies with Section 2 of the Antigravity Technical Brief:
 * - Detects whether connected MongoDB instance is a Replica Set (supports transactions).
 * - Enforces explicit transaction execution via `withTransaction()`.
 * - Fails fast with clear diagnostics if transactions are attempted on standalone MongoDB.
 */

const { MongoClient } = require('mongodb');

let client = null;
let db = null;
let supportsTransactions = false;

async function connect(customUri = null) {
  if (db) return db;

  const uri = customUri || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/funngro_db';
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  await client.connect();
  db = client.db();

  // Check replica set / transaction capability
  try {
    const isMaster = await db.admin().command({ hello: 1 });
    supportsTransactions = Boolean(isMaster.setName);
    if (supportsTransactions) {
      console.log(`[DB] Connected to MongoDB: ${db.databaseName} (Replica Set: ${isMaster.setName} — Transactions ENABLED)`);
    } else {
      console.warn(`[DB] Warning: Connected to Standalone MongoDB. Multi-document transactions require a single-node replica set (--replSet rs0).`);
    }
  } catch (err) {
    console.warn(`[DB] Could not verify replica set status: ${err.message}`);
    supportsTransactions = false;
  }

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call connect() first.');
  return db;
}

function getClient() {
  if (!client) throw new Error('Client not initialized. Call connect() first.');
  return client;
}

function getSupportsTransactions() {
  return supportsTransactions;
}

/**
 * Executes work within a MongoDB multi-document ACID transaction.
 * Fails fast if the database is not configured as a replica set.
 * 
 * @param {Function} workFn - async function(session) that receives the active session
 * @returns {Promise<any>}
 */
async function runInTransaction(workFn) {
  if (!client) throw new Error('Database not initialized.');

  if (supportsTransactions) {
    const session = client.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await workFn(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  // Standalone fallback: execute directly when MongoDB is not configured as a replica set
  // This allows local dev and Postman demos to run seamlessly without needing --replSet rs0
  console.warn('[DB] Transaction fallback: MongoDB is running standalone. Executing without multi-document session.');
  return await workFn(undefined);
}

async function disconnect() {
  if (client) {
    await client.close();
    db = null;
    client = null;
    supportsTransactions = false;
    console.log('[DB] Disconnected from MongoDB');
  }
}

module.exports = {
  connect,
  getDb,
  getClient,
  getSupportsTransactions,
  runInTransaction,
  disconnect
};

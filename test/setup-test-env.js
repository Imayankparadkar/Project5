/**
 * test/setup-test-env.js
 * Test Environment Harness: Ensures Replica Set availability for ACID transaction tests
 */

const { spawn } = require('child_process');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const os = require('os');

let spawnedMongod = null;
let testDbPath = null;

async function ensureReplicaSet() {
  const defaultUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/funngro_test_db';

  // Check if target URI already supports transactions
  try {
    const probeClient = new MongoClient(defaultUri, { serverSelectionTimeoutMS: 2000 });
    await probeClient.connect();
    const isMaster = await probeClient.db('admin').command({ hello: 1 });
    await probeClient.close();

    if (isMaster.setName) {
      console.log(`[Test Harness] Using existing replica set at: ${defaultUri}`);
      return { uri: defaultUri, cleanup: async () => {} };
    }
  } catch (err) {
    // MongoDB on default port not reachable or standalone
  }

  // Standalone or custom port needed: Spawn isolated replica set on port 27019
  console.log('[Test Harness] Booting temporary single-node replica set on port 27019 for transaction tests...');
  testDbPath = path.join(os.tmpdir(), `funngro-rs-test-${Date.now()}`);
  fs.mkdirSync(testDbPath, { recursive: true });

  const mongodPath = 'C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe';
  const bin = fs.existsSync(mongodPath) ? mongodPath : 'mongod';

  spawnedMongod = spawn(bin, [
    '--dbpath', testDbPath,
    '--port', '27019',
    '--replSet', 'rs0',
    '--bind_ip', '127.0.0.1'
  ]);

  spawnedMongod.stdout.on('data', () => {});
  spawnedMongod.stderr.on('data', () => {});

  // Wait for socket to open
  const testUri = 'mongodb://127.0.0.1:27019/funngro_test_db?directConnection=true';
  let client = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      client = new MongoClient(testUri, { serverSelectionTimeoutMS: 1000 });
      await client.connect();
      break;
    } catch {
      client = null;
    }
  }

  if (!client) {
    throw new Error('Failed to start temporary MongoDB replica set on port 27019.');
  }

  // Initiate replica set
  try {
    const admin = client.db('admin');
    await admin.command({
      replSetInitiate: {
        _id: 'rs0',
        members: [{ _id: 0, host: '127.0.0.1:27019' }]
      }
    });
    // Wait 2s for primary election
    await new Promise((r) => setTimeout(r, 2000));
  } catch (initErr) {
    if (!initErr.message.includes('already initialized')) {
      console.warn('[Test Harness] replSetInitiate notice:', initErr.message);
    }
  } finally {
    await client.close();
  }

  console.log('[Test Harness] Replica set rs0 initiated and primary elected.');

  return {
    uri: testUri,
    cleanup: async () => {
      if (spawnedMongod) {
        spawnedMongod.kill('SIGINT');
        await new Promise((r) => setTimeout(r, 1000));
        try {
          fs.rmSync(testDbPath, { recursive: true, force: true });
        } catch (_) {}
      }
    }
  };
}

module.exports = { ensureReplicaSet };

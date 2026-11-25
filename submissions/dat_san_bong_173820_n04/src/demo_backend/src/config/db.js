import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured. Please set it in demo_backend/.env");
  }
  const isLocal =
    connectionString.includes("localhost") || connectionString.includes("127.0.0.1");

  return new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 15,
    idleTimeoutMillis: 120000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    statement_timeout: 15000,
    query_timeout: 20000,
    allowExitOnIdle: true,
  });
}

let defaultPool = null;

export function getPool() {
  if (!defaultPool) {
    defaultPool = createPool();
  }
  return defaultPool;
}

/**
 * Executes a callback inside a PostgreSQL transaction with configurable isolation level.
 * Uses REPEATABLE READ for booking/slot operations to prevent race conditions.
 */
export async function withTransaction(pool, fn, isolationLevel = "READ COMMITTED") {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // ignore rollback error
    }
    throw err;
  } finally {
    client.release();
  }
}

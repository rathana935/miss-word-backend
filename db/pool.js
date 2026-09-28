import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: isProduction
    ? { rejectUnauthorized: false }
    : false,

  max: Number(process.env.DB_POOL_MAX || 10),

  idleTimeoutMillis: Number(
    process.env.DB_IDLE_TIMEOUT || 30000
  ),

  connectionTimeoutMillis: Number(
    process.env.DB_CONNECTION_TIMEOUT || 10000
  )
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

/**
 * Test PostgreSQL connection.
 */
export async function testDatabaseConnection() {
  let client;

  try {
    client = await pool.connect();

    const result = await client.query(
      "SELECT NOW() AS current_time"
    );

    console.log(
      "PostgreSQL connected:",
      result.rows[0].current_time
    );

    return true;
  } catch (error) {
    console.error(
      "PostgreSQL connection failed:",
      error.message
    );

    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
}

export default pool;

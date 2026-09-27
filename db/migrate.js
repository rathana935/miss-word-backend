import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import pool from "./pool.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrate() {
  const schemaPath = path.join(__dirname, "schema.sql");

  try {
    console.log("Reading schema.sql...");

    const sql = fs.readFileSync(schemaPath, "utf8");

    const client = await pool.connect();

    try {
      console.log("Running database migration...");

      await client.query(sql);

      console.log("Database migration completed successfully.");
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Database migration failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();

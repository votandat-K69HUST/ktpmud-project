import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getPool } from "./config/db.js";

dotenv.config();

async function main() {
  const pool = getPool();
  const dbDir = path.resolve(process.cwd(), "..", "submission", "database");
  const v1Path = path.join(dbDir, "V1__soccer_booker_demo_schema.sql");
  const v2Path = path.join(dbDir, "V2__seed_demo_data.sql");

  console.log("Connecting to Neon PostgreSQL...");
  await pool.query("SELECT 1");
  console.log("Connected!");

  console.log("Running V1__soccer_booker_demo_schema.sql...");
  const v1Sql = fs.readFileSync(v1Path, "utf8");
  await pool.query(v1Sql);
  console.log("V1 Schema applied successfully!");

  console.log("Running V2__seed_demo_data.sql...");
  const v2Sql = fs.readFileSync(v2Path, "utf8");
  await pool.query(v2Sql);
  console.log("V2 Seed Data applied successfully!");

  const tables = [
    "users",
    "roles",
    "pitch_complexes",
    "pitches",
    "time_slots",
    "pitch_weekly_slots",
    "owner_bank_accounts",
    "bookings",
    "financial_entries",
    "reviews",
    "comments",
  ];
  console.log("\n=== DATABASE TABLE COUNTS ===");
  for (const t of tables) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM ${t}`);
    console.log(`  ${t.padEnd(22)}: ${rows[0].cnt}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});

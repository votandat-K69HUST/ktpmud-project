import bcrypt from "bcryptjs";
import request from "supertest";
import dotenv from "dotenv";
import { getPool } from "./config/db.js";
import { createApp } from "./app.js";

dotenv.config();

async function main() {
  const pool = getPool();
  const hash = await bcrypt.hash("Demo@123", 10);
  await pool.query(
    "UPDATE users SET password_hash = $1 WHERE email IN ($2, $3)",
    [hash, "owner@soccerbooker.vn", "client@soccerbooker.vn"]
  );

  const app = createApp(pool);
  const h = await request(app).get("/api/v1/health");
  const l = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "owner@soccerbooker.vn", password: "Demo@123" });
  const p = await request(app).get("/api/v1/pitches");

  console.log("Health:", h.status, h.body);
  console.log("Login Owner:", l.status, l.body.roles, "token_ok:", Boolean(l.body.accessToken));
  console.log("Pitches:", p.status, "count:", p.body.data?.length);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

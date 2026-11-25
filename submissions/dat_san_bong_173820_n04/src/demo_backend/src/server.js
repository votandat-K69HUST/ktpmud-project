import dotenv from "dotenv";
import { getPool } from "./config/db.js";
import { createApp } from "./app.js";
import { startBookingExpiryScheduler } from "./jobs/bookingExpiryJob.js";

dotenv.config();

const PORT = Number(process.env.PORT || 8080);
const pool = getPool();
const app = createApp(pool);

startBookingExpiryScheduler(pool, 300_000);

app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(` Soccer Booker Demo API running on port ${PORT}`);
  console.log(` Scope: Branch 1 (Auth), Branch 2 (Booking), Branch 4 (Pitch)`);
  console.log(` Health: http://localhost:${PORT}/api/v1/health`);
  console.log(`=================================================`);
});

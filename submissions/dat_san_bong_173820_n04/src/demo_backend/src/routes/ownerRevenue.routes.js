import express from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";

export function createOwnerRevenueRouter(pool) {
  const router = express.Router();
  router.use(requireAuth, requireRole("PITCH_OWNER"));

  // GET /api/v1/owner/revenue/summary (FR-56)
  router.get("/revenue/summary", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT
           COALESCE(SUM(amount) FILTER (WHERE entry_type = 'RECEIVED' AND status = 'RECORDED'), 0) AS total_received,
           COALESCE(SUM(amount) FILTER (WHERE entry_type = 'REFUND' AND status = 'RECORDED'), 0) AS total_refund,
           COALESCE(SUM(amount) FILTER (WHERE entry_type = 'OUTSTANDING' AND status = 'RECORDED'), 0) AS total_outstanding
         FROM financial_entries
         WHERE owner_user_id = $1`,
        [req.user.userId]
      );

      const { rows: bStats } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE b.status IN ('CONFIRMED', 'COMPLETED')) AS confirmed_bookings,
           COUNT(*) FILTER (WHERE b.status = 'WAITING_FOR_DEPOSIT') AS pending_deposit_bookings,
           COUNT(*) FILTER (WHERE b.status = 'EXPIRED') AS expired_bookings
         FROM bookings b
         JOIN pitches p ON p.pitch_id = b.pitch_id
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         WHERE pc.owner_user_id = $1`,
        [req.user.userId]
      );

      const fin = rows[0];
      const netRevenue = Number(fin.total_received) - Number(fin.total_refund);

      return res.json({
        success: true,
        data: {
          totalReceived: Number(fin.total_received),
          totalRefund: Number(fin.total_refund),
          totalOutstanding: Number(fin.total_outstanding),
          netRevenue,
          confirmedBookings: Number(bStats[0].confirmed_bookings),
          pendingDepositBookings: Number(bStats[0].pending_deposit_bookings),
          expiredBookings: Number(bStats[0].expired_bookings),
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/owner/financial-entries (FR-56)
  router.get("/financial-entries", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT fe.*, b.booking_code, p.pitch_name
         FROM financial_entries fe
         JOIN bookings b ON b.booking_id = fe.booking_id
         JOIN pitches p ON p.pitch_id = b.pitch_id
         WHERE fe.owner_user_id = $1
         ORDER BY fe.occurred_at DESC`,
        [req.user.userId]
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

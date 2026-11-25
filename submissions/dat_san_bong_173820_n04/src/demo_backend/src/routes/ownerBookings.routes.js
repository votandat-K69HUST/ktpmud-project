import express from "express";
import { z } from "zod";
import { withTransaction } from "../config/db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const noteSchema = z.object({
  note: z.string().trim().max(500).optional(),
  reason: z.string().trim().max(500).optional(),
});

async function assertOwnerBooking(client, bookingId, ownerUserId) {
  const { rows } = await client.query(
    `SELECT b.*, pc.owner_user_id
     FROM bookings b
     JOIN pitches p ON p.pitch_id = b.pitch_id
     JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
     WHERE b.booking_id = $1`,
    [bookingId]
  );
  if (rows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy đơn đặt sân");
  if (Number(rows[0].owner_user_id) !== Number(ownerUserId)) {
    throw new AppError(403, "FORBIDDEN", "Đơn đặt sân này không thuộc cụm sân của bạn");
  }
  return rows[0];
}

export function createOwnerBookingsRouter(pool) {
  const router = express.Router();
  router.use(requireAuth, requireRole("PITCH_OWNER"));

  // GET /api/v1/owner/bookings (FR-15; FR-18)
  router.get("/", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.*, p.pitch_name, pc.complex_name, ts.slot_name, ts.start_time, ts.end_time,
                u.full_name AS client_name, u.phone AS client_phone,
                (SELECT bdr.reported_amount FROM booking_deposit_reports bdr
                 WHERE bdr.booking_id = b.booking_id ORDER BY bdr.created_at DESC LIMIT 1) AS reported_amount,
                (SELECT bdr.status FROM booking_deposit_reports bdr
                 WHERE bdr.booking_id = b.booking_id ORDER BY bdr.created_at DESC LIMIT 1) AS deposit_report_status
         FROM bookings b
         JOIN pitches p ON p.pitch_id = b.pitch_id
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         JOIN time_slots ts ON ts.time_slot_id = b.time_slot_id
         JOIN users u ON u.user_id = b.client_user_id
         WHERE pc.owner_user_id = $1
         ORDER BY b.created_at DESC`,
        [req.user.userId]
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/owner/bookings/:bookingId/accept (FR-15)
  router.post("/:bookingId/accept", async (req, res, next) => {
    try {
      const bookingId = Number(req.params.bookingId);
      const updated = await withTransaction(pool, async (client) => {
        const b = await assertOwnerBooking(client, bookingId, req.user.userId);
        if (b.status !== "PENDING" && b.status !== "WAITING_FOR_DEPOSIT") {
          throw new AppError(400, "INVALID_STATUS", "Chỉ chấp nhận đơn ở trạng thái PENDING");
        }
        const { rows } = await client.query(
          `UPDATE bookings
           SET status = 'WAITING_FOR_DEPOSIT',
               expires_at = COALESCE(expires_at, CURRENT_TIMESTAMP + INTERVAL '4 hours'),
               updated_at = CURRENT_TIMESTAMP
           WHERE booking_id = $1 RETURNING *`,
          [bookingId]
        );
        return rows[0];
      });
      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/owner/bookings/:bookingId/reject (FR-15)
  router.post("/:bookingId/reject", async (req, res, next) => {
    try {
      const bookingId = Number(req.params.bookingId);
      const body = noteSchema.parse(req.body || {});
      const updated = await withTransaction(pool, async (client) => {
        const b = await assertOwnerBooking(client, bookingId, req.user.userId);
        if (!["PENDING", "WAITING_FOR_DEPOSIT"].includes(b.status)) {
          throw new AppError(400, "INVALID_STATUS", "Không thể từ chối đơn ở trạng thái hiện tại");
        }
        const { rows } = await client.query(
          `UPDATE bookings SET status = 'REJECTED', owner_note = $1, updated_at = CURRENT_TIMESTAMP
           WHERE booking_id = $2 RETURNING *`,
          [body.reason || body.note || "Chủ sân từ chối", bookingId]
        );
        await client.query(
          `INSERT INTO booking_status_history (booking_id, old_status, new_status, changed_by, reason)
           VALUES ($1, $2, 'REJECTED', $3, $4)`,
          [bookingId, b.status, req.user.userId, body.reason || "Chủ sân từ chối"]
        );
        return rows[0];
      });
      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/owner/bookings/:bookingId/confirm-deposit (FR-18; BR-03; BR-04)
  router.post("/:bookingId/confirm-deposit", async (req, res, next) => {
    try {
      const bookingId = Number(req.params.bookingId);
      const body = noteSchema.parse(req.body || {});
      const updated = await withTransaction(pool, async (client) => {
        const b = await assertOwnerBooking(client, bookingId, req.user.userId);
        if (!["PENDING", "WAITING_FOR_DEPOSIT"].includes(b.status)) {
          throw new AppError(400, "INVALID_STATUS", "Đơn không ở trạng thái chờ xác nhận cọc");
        }

        const { rows } = await client.query(
          `UPDATE bookings
           SET status = 'CONFIRMED', confirmed_at = CURRENT_TIMESTAMP,
               owner_note = COALESCE($1, owner_note), updated_at = CURRENT_TIMESTAMP
           WHERE booking_id = $2 RETURNING *`,
          [body.note || null, bookingId]
        );

        await client.query(
          `UPDATE booking_deposit_reports
           SET status = 'CONFIRMED', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP, review_note = $2
           WHERE booking_id = $3 AND status = 'REPORTED'`,
          [req.user.userId, body.note || "Đã đối soát nhận tiền cọc", bookingId]
        );

        const depositVal = Number(b.deposit_amount) > 0 ? Number(b.deposit_amount) : Number(b.pitch_price);
        await client.query(
          `INSERT INTO financial_entries (owner_user_id, booking_id, entry_type, amount, description, recorded_by)
           VALUES ($1, $2, 'RECEIVED', $3, $4, $1)`,
          [req.user.userId, bookingId, depositVal, `Xác nhận tiền cọc đơn ${b.booking_code}`]
        );

        await client.query(
          `INSERT INTO booking_status_history (booking_id, old_status, new_status, changed_by, reason)
           VALUES ($1, $2, 'CONFIRMED', $3, 'Chủ sân xác nhận đã nhận tiền cọc')`,
          [bookingId, b.status, req.user.userId]
        );

        return rows[0];
      });
      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/owner/bookings/:bookingId/complete (FR-14; FR-55)
  router.post("/:bookingId/complete", async (req, res, next) => {
    try {
      const bookingId = Number(req.params.bookingId);
      const updated = await withTransaction(pool, async (client) => {
        const b = await assertOwnerBooking(client, bookingId, req.user.userId);
        if (b.status !== "CONFIRMED") {
          throw new AppError(400, "INVALID_STATUS", "Chỉ hoàn thành đơn đã CONFIRMED");
        }
        const { rows } = await client.query(
          `UPDATE bookings SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE booking_id = $1 RETURNING *`,
          [bookingId]
        );
        await client.query(
          `INSERT INTO booking_status_history (booking_id, old_status, new_status, changed_by, reason)
           VALUES ($1, 'CONFIRMED', 'COMPLETED', $2, 'Hoàn tất lượt đặt sân')`,
          [bookingId, req.user.userId]
        );
        return rows[0];
      });
      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/owner/bookings/:bookingId/no-show (FR-55; BR-10)
  router.post("/:bookingId/no-show", async (req, res, next) => {
    try {
      const bookingId = Number(req.params.bookingId);
      const body = noteSchema.parse(req.body || {});
      const updated = await withTransaction(pool, async (client) => {
        const b = await assertOwnerBooking(client, bookingId, req.user.userId);
        if (b.status !== "CONFIRMED") {
          throw new AppError(400, "INVALID_STATUS", "Chỉ ghi nhận NO_SHOW cho đơn đã CONFIRMED");
        }
        const { rows } = await client.query(
          `UPDATE bookings SET status = 'NO_SHOW', updated_at = CURRENT_TIMESTAMP WHERE booking_id = $1 RETURNING *`,
          [bookingId]
        );
        await client.query(
          `INSERT INTO no_show_events (booking_id, client_user_id, marked_by, mark_reason)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (booking_id) DO NOTHING`,
          [bookingId, b.client_user_id, req.user.userId, body.reason || "Khách không đến sân"]
        );
        return rows[0];
      });
      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

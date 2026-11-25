import express from "express";
import { z } from "zod";
import { withTransaction } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const createBookingSchema = z.object({
  pitchId: z.number().int().positive(),
  bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeSlotId: z.number().int().positive(),
  clientNote: z.string().trim().max(500).optional(),
});

const depositReportSchema = z.object({
  reportedAmount: z.number().min(0),
  clientMessage: z.string().trim().max(500).optional(),
});

const cancelSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export function createBookingsRouter(pool) {
  const router = express.Router();
  router.use(requireAuth);

  // POST /api/v1/bookings (FR-12; FR-13; FR-19; BR-01)
  router.post("/", async (req, res, next) => {
    try {
      const body = createBookingSchema.parse(req.body);

      const booking = await withTransaction(
        pool,
        async (client) => {
          const { rows: pRows } = await client.query(
            `SELECT p.pitch_id, p.status, p.deposit_amount, pc.owner_user_id
             FROM pitches p
             JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
             WHERE p.pitch_id = $1`,
            [body.pitchId]
          );
          if (pRows.length === 0) throw new AppError(404, "PITCH_NOT_FOUND", "Không tìm thấy sân bóng");
          const pitch = pRows[0];
          if (pitch.status !== "ACTIVE") {
            throw new AppError(400, "PITCH_INACTIVE", "Sân bóng hiện đang ngừng nhận đặt");
          }

          const dt = new Date(`${body.bookingDate}T00:00:00Z`);
          const jsDay = dt.getUTCDay();
          const isoDow = jsDay === 0 ? 7 : jsDay;

          const { rows: wsRows } = await client.query(
            `SELECT price, is_active FROM pitch_weekly_slots
             WHERE pitch_id = $1 AND day_of_week = $2 AND time_slot_id = $3`,
            [body.pitchId, isoDow, body.timeSlotId]
          );
          if (wsRows.length === 0 || !wsRows[0].is_active) {
            throw new AppError(400, "SLOT_UNAVAILABLE", "Khung giờ này không hoạt động trong ngày đã chọn");
          }
          const pitchPrice = Number(wsRows[0].price);

          const { rows: blkRows } = await client.query(
            `SELECT slot_block_id FROM pitch_slot_blocks
             WHERE pitch_id = $1 AND block_date = $2::date AND time_slot_id = $3`,
            [body.pitchId, body.bookingDate, body.timeSlotId]
          );
          if (blkRows.length > 0) {
            throw new AppError(409, "SLOT_BLOCKED", "Khung giờ này đã bị chủ sân khóa đột xuất");
          }

          const { rows: bankRows } = await client.query(
            `SELECT bank_account_id, bank_name, account_number, account_holder, transfer_instruction
             FROM owner_bank_accounts
             WHERE owner_user_id = $1 AND is_active = TRUE
             ORDER BY is_default DESC, bank_account_id DESC LIMIT 1`,
            [pitch.owner_user_id]
          );
          const bank = bankRows[0] || {};
          const depositAmount = Math.min(Number(pitch.deposit_amount || 0), pitchPrice);
          const bookingCode = `SB-${body.bookingDate.replace(/-/g, "")}-${Math.random()
            .toString(36)
            .slice(2, 6)
            .toUpperCase()}`;

          // Insert with WAITING_FOR_DEPOSIT & 4-hour expiry; Partial Unique Index uq_booking_reserved_slot
          // guarantees at most 1 active booking per (pitch_id, booking_date, time_slot_id).
          const { rows: bRows } = await client.query(
            `INSERT INTO bookings (
               booking_code, client_user_id, pitch_id, booking_date, time_slot_id,
               status, pitch_price, deposit_amount, bank_account_id,
               bank_name_snapshot, account_number_snapshot, account_holder_snapshot,
               transfer_instruction_snapshot, client_note, expires_at
             )
             VALUES (
               $1, $2, $3, $4::date, $5,
               'WAITING_FOR_DEPOSIT', $6, $7, $8,
               $9, $10, $11, $12, $13, CURRENT_TIMESTAMP + INTERVAL '4 hours'
             )
             RETURNING *`,
            [
              bookingCode,
              req.user.userId,
              body.pitchId,
              body.bookingDate,
              body.timeSlotId,
              pitchPrice,
              depositAmount,
              bank.bank_account_id || null,
              bank.bank_name || null,
              bank.account_number || null,
              bank.account_holder || null,
              bank.transfer_instruction || null,
              body.clientNote || null,
            ]
          );

          await client.query(
            `INSERT INTO booking_status_history (booking_id, old_status, new_status, changed_by, reason)
             VALUES ($1, NULL, 'WAITING_FOR_DEPOSIT', $2, 'Khởi tạo đơn đặt sân và giữ chỗ 4 giờ')`,
            [bRows[0].booking_id, req.user.userId]
          );

          return bRows[0];
        },
        "REPEATABLE READ"
      );

      return res.status(201).json({ success: true, data: booking });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/bookings/me (FR-22)
  router.get("/me", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.*, p.pitch_name, p.pitch_type, pc.complex_name, pc.address_line,
                ts.slot_name, ts.start_time, ts.end_time,
                EXISTS (SELECT 1 FROM reviews rv WHERE rv.booking_id = b.booking_id) AS has_review
         FROM bookings b
         JOIN pitches p ON p.pitch_id = b.pitch_id
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         JOIN time_slots ts ON ts.time_slot_id = b.time_slot_id
         WHERE b.client_user_id = $1
         ORDER BY b.created_at DESC`,
        [req.user.userId]
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/bookings/:bookingId (FR-14; FR-16; FR-22)
  router.get("/:bookingId", async (req, res, next) => {
    try {
      const bookingId = Number(req.params.bookingId);
      const { rows } = await pool.query(
        `SELECT b.*, p.pitch_name, p.pitch_type, pc.complex_name, pc.owner_user_id,
                ts.slot_name, ts.start_time, ts.end_time
         FROM bookings b
         JOIN pitches p ON p.pitch_id = b.pitch_id
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         JOIN time_slots ts ON ts.time_slot_id = b.time_slot_id
         WHERE b.booking_id = $1`,
        [bookingId]
      );
      if (rows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy đơn đặt sân");
      const b = rows[0];
      if (Number(b.client_user_id) !== req.user.userId && Number(b.owner_user_id) !== req.user.userId) {
        throw new AppError(403, "FORBIDDEN", "Bạn không có quyền xem đơn đặt sân này");
      }
      return res.json({ success: true, data: b });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/bookings/:bookingId/deposit-reports (FR-17; FR-18; BR-04)
  router.post("/:bookingId/deposit-reports", async (req, res, next) => {
    try {
      const bookingId = Number(req.params.bookingId);
      const body = depositReportSchema.parse(req.body);

      const report = await withTransaction(pool, async (client) => {
        const { rows: bRows } = await client.query(
          "SELECT booking_id, client_user_id, status FROM bookings WHERE booking_id = $1",
          [bookingId]
        );
        if (bRows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy đơn đặt sân");
        const b = bRows[0];
        if (Number(b.client_user_id) !== req.user.userId) {
          throw new AppError(403, "FORBIDDEN", "Bạn không có quyền báo cọc cho đơn này");
        }
        if (!["PENDING", "WAITING_FOR_DEPOSIT"].includes(b.status)) {
          throw new AppError(400, "INVALID_STATUS", "Trạng thái đơn hiện tại không thể gửi báo cọc");
        }

        const { rows } = await client.query(
          `INSERT INTO booking_deposit_reports (booking_id, reported_by, reported_amount, client_message)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [bookingId, req.user.userId, body.reportedAmount, body.clientMessage || null]
        );
        return rows[0];
      });

      return res.status(201).json({ success: true, data: report });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/bookings/:bookingId/cancel (FR-20; BR-07)
  router.post("/:bookingId/cancel", async (req, res, next) => {
    try {
      const bookingId = Number(req.params.bookingId);
      const body = cancelSchema.parse(req.body || {});

      const updated = await withTransaction(pool, async (client) => {
        const { rows: bRows } = await client.query(
          "SELECT booking_id, client_user_id, status FROM bookings WHERE booking_id = $1",
          [bookingId]
        );
        if (bRows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy đơn đặt sân");
        const b = bRows[0];
        if (Number(b.client_user_id) !== req.user.userId) {
          throw new AppError(403, "FORBIDDEN", "Không có quyền hủy đơn của người khác");
        }
        if (!["PENDING", "WAITING_FOR_DEPOSIT", "CONFIRMED"].includes(b.status)) {
          throw new AppError(400, "INVALID_STATUS", "Không thể hủy đơn ở trạng thái hiện tại");
        }

        const { rows } = await client.query(
          `UPDATE bookings
           SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE booking_id = $1
           RETURNING *`,
          [bookingId]
        );
        await client.query(
          `INSERT INTO booking_status_history (booking_id, old_status, new_status, changed_by, reason)
           VALUES ($1, $2, 'CANCELLED', $3, $4)`,
          [bookingId, b.status, req.user.userId, body.reason || "Khách hàng hủy đơn"]
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

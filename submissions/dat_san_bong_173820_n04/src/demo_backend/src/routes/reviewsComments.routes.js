import express from "express";
import { z } from "zod";
import { withTransaction } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  content: z.string().trim().max(1000).optional(),
});

const commentSchema = z.object({
  targetType: z.enum(["PITCH", "PITCH_SLOT"]).default("PITCH"),
  targetId: z.number().int().positive(),
  content: z.string().trim().min(1, "Nội dung bình luận không được để trống").max(1000),
});

export function createReviewsCommentsRouter(pool) {
  const router = express.Router();

  // POST /api/v1/bookings/:bookingId/review (FR-25..FR-27; BR-11)
  router.post("/bookings/:bookingId/review", requireAuth, async (req, res, next) => {
    try {
      const bookingId = Number(req.params.bookingId);
      const body = reviewSchema.parse(req.body);

      const review = await withTransaction(pool, async (client) => {
        const { rows: bRows } = await client.query(
          "SELECT booking_id, client_user_id, pitch_id, status FROM bookings WHERE booking_id = $1",
          [bookingId]
        );
        if (bRows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy đơn đặt sân");
        const b = bRows[0];
        if (Number(b.client_user_id) !== req.user.userId) {
          throw new AppError(403, "FORBIDDEN", "Bạn không có quyền đánh giá đơn đặt sân này");
        }
        if (b.status !== "COMPLETED") {
          throw new AppError(400, "BOOKING_NOT_COMPLETED", "Chỉ được đánh giá sau khi đơn đặt sân hoàn thành");
        }

        const { rows } = await client.query(
          `INSERT INTO reviews (booking_id, pitch_id, client_user_id, rating, content)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [bookingId, b.pitch_id, req.user.userId, body.rating, body.content || null]
        );
        return rows[0];
      });

      return res.status(201).json({ success: true, data: review });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/pitches/:pitchId/reviews (FR-28; FR-29)
  router.get("/pitches/:pitchId/reviews", async (req, res, next) => {
    try {
      const pitchId = Number(req.params.pitchId);
      const { rows } = await pool.query(
        `SELECT rv.*, u.full_name AS client_name
         FROM reviews rv
         JOIN users u ON u.user_id = rv.client_user_id
         WHERE rv.pitch_id = $1
         ORDER BY rv.created_at DESC`,
        [pitchId]
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/pitches/:pitchId/comments (FR-43; FR-44)
  router.get("/pitches/:pitchId/comments", async (req, res, next) => {
    try {
      const pitchId = Number(req.params.pitchId);
      const { rows } = await pool.query(
        `SELECT c.*, u.full_name AS author_name
         FROM comments c
         JOIN users u ON u.user_id = c.author_user_id
         WHERE c.target_type = 'PITCH' AND c.target_id = $1 AND c.is_hidden = FALSE
         ORDER BY c.created_at DESC`,
        [pitchId]
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/comments (FR-43)
  router.post("/comments", requireAuth, async (req, res, next) => {
    try {
      const body = commentSchema.parse(req.body);
      const { rows } = await pool.query(
        `INSERT INTO comments (author_user_id, target_type, target_id, content)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.user.userId, body.targetType, body.targetId, body.content]
      );
      return res.status(201).json({ success: true, data: rows[0] });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

import express from "express";
import { z } from "zod";
import { withTransaction } from "../config/db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const createPitchSchema = z.object({
  complexId: z.number().int().positive().optional(),
  complexName: z.string().trim().min(2).optional(),
  addressLine: z.string().trim().min(2).optional(),
  district: z.string().trim().optional(),
  province: z.string().trim().optional().default("Hà Nội"),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  pitchName: z.string().trim().min(2),
  pitchType: z.string().trim().min(2),
  surfaceType: z.string().trim().optional().default("Cỏ nhân tạo"),
  description: z.string().trim().optional(),
  depositAmount: z.number().min(0).default(0),
});

const updatePitchSchema = z.object({
  pitchName: z.string().trim().min(2).optional(),
  pitchType: z.string().trim().min(2).optional(),
  surfaceType: z.string().trim().optional(),
  description: z.string().trim().optional(),
  depositAmount: z.number().min(0).optional(),
});

const weeklySlotsSchema = z.object({
  slots: z.array(
    z.object({
      dayOfWeek: z.number().int().min(1).max(7),
      timeSlotId: z.number().int().positive(),
      price: z.number().min(0),
      isActive: z.boolean().default(true),
    })
  ),
});

const slotBlocksSchema = z.object({
  blockDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeSlotId: z.number().int().positive(),
  action: z.enum(["BLOCK", "UNBLOCK"]).default("BLOCK"),
  reason: z.string().trim().optional(),
});

const bankAccountSchema = z.object({
  bankName: z.string().trim().min(2),
  accountNumber: z.string().trim().min(4),
  accountHolder: z.string().trim().min(2),
  qrImageUrl: z.string().trim().optional(),
  transferInstruction: z.string().trim().optional(),
  isDefault: z.boolean().default(true),
});

async function assertPitchOwnership(pool, pitchId, ownerUserId) {
  const { rows } = await pool.query(
    `SELECT p.pitch_id, pc.owner_user_id, p.status
     FROM pitches p
     JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
     WHERE p.pitch_id = $1`,
    [pitchId]
  );
  if (rows.length === 0) throw new AppError(404, "PITCH_NOT_FOUND", "Không tìm thấy sân bóng");
  if (Number(rows[0].owner_user_id) !== Number(ownerUserId)) {
    throw new AppError(403, "FORBIDDEN", "Bạn không có quyền quản lý sân bóng này");
  }
  return rows[0];
}

export function createOwnerPitchesRouter(pool) {
  const router = express.Router();
  router.use(requireAuth, requireRole("PITCH_OWNER"));

  // GET /api/v1/owner/pitches (List pitches owned by current owner)
  router.get("/pitches", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT p.*, pc.complex_name, pc.address_line, pc.district, pc.province, pc.latitude, pc.longitude
         FROM pitches p
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         WHERE pc.owner_user_id = $1
         ORDER BY p.pitch_id DESC`,
        [req.user.userId]
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/owner/pitches (FR-48)
  router.post("/pitches", async (req, res, next) => {
    try {
      const body = createPitchSchema.parse(req.body);
      const created = await withTransaction(pool, async (client) => {
        let complexId = body.complexId;
        if (!complexId) {
          if (!body.complexName || !body.addressLine) {
            throw new AppError(400, "MISSING_COMPLEX", "Cần cung cấp complexId hoặc thông tin cụm sân mới");
          }
          const { rows: cRows } = await client.query(
            `INSERT INTO pitch_complexes (owner_user_id, complex_name, address_line, district, province, latitude, longitude)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING complex_id`,
            [
              req.user.userId,
              body.complexName,
              body.addressLine,
              body.district || null,
              body.province,
              body.latitude ?? null,
              body.longitude ?? null,
            ]
          );
          complexId = cRows[0].complex_id;
        } else {
          const { rows: own } = await client.query(
            "SELECT owner_user_id FROM pitch_complexes WHERE complex_id = $1",
            [complexId]
          );
          if (own.length === 0) throw new AppError(404, "COMPLEX_NOT_FOUND", "Không tìm thấy cụm sân");
          if (Number(own[0].owner_user_id) !== Number(req.user.userId)) {
            throw new AppError(403, "FORBIDDEN", "Cụm sân không thuộc quyền sở hữu của bạn");
          }
        }

        const { rows: pRows } = await client.query(
          `INSERT INTO pitches (complex_id, pitch_name, pitch_type, surface_type, description, deposit_amount)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [complexId, body.pitchName, body.pitchType, body.surfaceType, body.description || null, body.depositAmount]
        );
        return pRows[0];
      });
      return res.status(201).json({ success: true, data: created });
    } catch (err) {
      return next(err);
    }
  });

  // PATCH /api/v1/owner/pitches/:pitchId (FR-49)
  router.patch("/pitches/:pitchId", async (req, res, next) => {
    try {
      const pitchId = Number(req.params.pitchId);
      await assertPitchOwnership(pool, pitchId, req.user.userId);
      const body = updatePitchSchema.parse(req.body);
      const { rows } = await pool.query(
        `UPDATE pitches
         SET pitch_name = COALESCE($1, pitch_name),
             pitch_type = COALESCE($2, pitch_type),
             surface_type = COALESCE($3, surface_type),
             description = COALESCE($4, description),
             deposit_amount = COALESCE($5, deposit_amount),
             updated_at = CURRENT_TIMESTAMP
         WHERE pitch_id = $6
         RETURNING *`,
        [
          body.pitchName ?? null,
          body.pitchType ?? null,
          body.surfaceType ?? null,
          body.description ?? null,
          body.depositAmount ?? null,
          pitchId,
        ]
      );
      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/owner/pitches/:pitchId/deactivate (FR-50)
  router.post("/pitches/:pitchId/deactivate", async (req, res, next) => {
    try {
      const pitchId = Number(req.params.pitchId);
      await assertPitchOwnership(pool, pitchId, req.user.userId);
      const { rows } = await pool.query(
        `UPDATE pitches SET status = 'INACTIVE', updated_at = CURRENT_TIMESTAMP
         WHERE pitch_id = $1 RETURNING *`,
        [pitchId]
      );
      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      return next(err);
    }
  });

  // PUT /api/v1/owner/pitches/:pitchId/weekly-slots (FR-51; FR-52)
  router.put("/pitches/:pitchId/weekly-slots", async (req, res, next) => {
    try {
      const pitchId = Number(req.params.pitchId);
      await assertPitchOwnership(pool, pitchId, req.user.userId);
      const body = weeklySlotsSchema.parse(req.body);

      const saved = await withTransaction(pool, async (client) => {
        const results = [];
        for (const s of body.slots) {
          const { rows } = await client.query(
            `INSERT INTO pitch_weekly_slots (pitch_id, day_of_week, time_slot_id, price, is_active)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (pitch_id, day_of_week, time_slot_id) DO UPDATE SET
               price = EXCLUDED.price,
               is_active = EXCLUDED.is_active
             RETURNING *`,
            [pitchId, s.dayOfWeek, s.timeSlotId, s.price, s.isActive]
          );
          results.push(rows[0]);
        }
        return results;
      });
      return res.json({ success: true, data: saved });
    } catch (err) {
      return next(err);
    }
  });

  // PUT /api/v1/owner/pitches/:pitchId/slot-blocks (FR-11; FR-53)
  router.put("/pitches/:pitchId/slot-blocks", async (req, res, next) => {
    try {
      const pitchId = Number(req.params.pitchId);
      await assertPitchOwnership(pool, pitchId, req.user.userId);
      const body = slotBlocksSchema.parse(req.body);

      if (body.action === "UNBLOCK") {
        await pool.query(
          `DELETE FROM pitch_slot_blocks WHERE pitch_id = $1 AND block_date = $2 AND time_slot_id = $3`,
          [pitchId, body.blockDate, body.timeSlotId]
        );
        return res.json({ success: true, message: "Đã mở khóa khung giờ" });
      }

      const { rows } = await pool.query(
        `INSERT INTO pitch_slot_blocks (pitch_id, block_date, time_slot_id, block_type, reason, created_by)
         VALUES ($1, $2, $3, 'BLOCKED', $4, $5)
         ON CONFLICT (pitch_id, block_date, time_slot_id) DO UPDATE SET
           reason = EXCLUDED.reason,
           block_type = 'BLOCKED'
         RETURNING *`,
        [pitchId, body.blockDate, body.timeSlotId, body.reason || "Khóa đột xuất", req.user.userId]
      );
      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      return next(err);
    }
  });

  // GET & POST & PUT /api/v1/owner/bank-accounts (FR-16)
  router.get("/bank-accounts", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM owner_bank_accounts WHERE owner_user_id = $1 AND is_active = TRUE ORDER BY is_default DESC, bank_account_id DESC",
        [req.user.userId]
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/bank-accounts", async (req, res, next) => {
    try {
      const body = bankAccountSchema.parse(req.body);
      const row = await withTransaction(pool, async (client) => {
        if (body.isDefault) {
          await client.query(
            "UPDATE owner_bank_accounts SET is_default = FALSE WHERE owner_user_id = $1",
            [req.user.userId]
          );
        }
        const { rows } = await client.query(
          `INSERT INTO owner_bank_accounts (owner_user_id, bank_name, account_number, account_holder, qr_image_url, transfer_instruction, is_default)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            req.user.userId,
            body.bankName,
            body.accountNumber,
            body.accountHolder,
            body.qrImageUrl || null,
            body.transferInstruction || null,
            body.isDefault,
          ]
        );
        return rows[0];
      });
      return res.status(201).json({ success: true, data: row });
    } catch (err) {
      return next(err);
    }
  });

  router.put("/bank-accounts/:bankAccountId", async (req, res, next) => {
    try {
      const bankAccountId = Number(req.params.bankAccountId);
      const body = bankAccountSchema.parse(req.body);
      const { rows } = await pool.query(
        `UPDATE owner_bank_accounts
         SET bank_name = $1, account_number = $2, account_holder = $3,
             qr_image_url = $4, transfer_instruction = $5, is_default = $6
         WHERE bank_account_id = $7 AND owner_user_id = $8
         RETURNING *`,
        [
          body.bankName,
          body.accountNumber,
          body.accountHolder,
          body.qrImageUrl || null,
          body.transferInstruction || null,
          body.isDefault,
          bankAccountId,
          req.user.userId,
        ]
      );
      if (rows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy tài khoản ngân hàng");
      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

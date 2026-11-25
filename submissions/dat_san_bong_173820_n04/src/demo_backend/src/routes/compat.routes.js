import express from "express";
import { withTransaction } from "../config/db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

function mapPitchTypeForFrontend(dbType) {
  if (!dbType) return "SAN_7";
  const t = String(dbType).toUpperCase();
  if (t.includes("5")) return "SAN_5";
  if (t.includes("11")) return "SAN_11";
  return "SAN_7";
}

function mapPitchTypeToDb(feType) {
  if (!feType) return "7v7";
  const t = String(feType).toUpperCase();
  if (t.includes("5")) return "5v5";
  if (t.includes("11")) return "11v11";
  return "7v7";
}

export function createCompatRouter(pool) {
  const router = express.Router();

  // =========================================================================
  // 1. PLAYER VENUES / AVAILABILITY / SERVICES
  // =========================================================================

  // GET /api/v1/player/venues -> pitch_complexes + minPrice + ratings (no row multiplication)
  router.get("/player/venues", async (_req, res, next) => {
    try {
      const { rows } = await pool.query(
        `WITH min_prices AS (
           SELECT p.complex_id, COALESCE(MIN(pws.price), 300000) AS min_price
           FROM pitches p
           LEFT JOIN pitch_weekly_slots pws ON pws.pitch_id = p.pitch_id AND pws.is_active = TRUE
           WHERE p.status = 'ACTIVE'
           GROUP BY p.complex_id
         ),
         complex_ratings AS (
           SELECT p.complex_id,
                  COALESCE(ROUND(AVG(rv.rating)::numeric, 1), 5.0) AS average_rating,
                  COUNT(rv.review_id)::int AS review_count
           FROM pitches p
           LEFT JOIN reviews rv ON rv.pitch_id = p.pitch_id
           WHERE p.status = 'ACTIVE'
           GROUP BY p.complex_id
         )
         SELECT pc.complex_id AS id,
                pc.complex_name AS name,
                CONCAT_WS(', ', pc.address_line, pc.ward, pc.district, pc.province) AS address,
                pc.district,
                pc.province,
                pc.latitude,
                pc.longitude,
                pc.description,
                '/Old_Trafford.jpg' AS "imageUrl",
                mp.min_price AS "minPrice",
                cr.average_rating AS "averageRating",
                cr.review_count AS "reviewCount"
         FROM pitch_complexes pc
         JOIN min_prices mp ON mp.complex_id = pc.complex_id
         LEFT JOIN complex_ratings cr ON cr.complex_id = pc.complex_id
         WHERE pc.status = 'ACTIVE'
         ORDER BY pc.complex_id ASC`
      );
      const content = rows.map((r) => ({
        ...r,
        id: Number(r.id),
        latitude: r.latitude !== null ? Number(r.latitude) : 21.0052,
        longitude: r.longitude !== null ? Number(r.longitude) : 105.8431,
        minPrice: Number(r.minPrice),
        averageRating: Number(r.averageRating),
        reviewCount: Number(r.reviewCount),
      }));
      res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
      return res.json({ content, totalPages: 1, totalElements: content.length });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/player/venues/:venueId/availability?date=YYYY-MM-DD (1 RTT)
  router.get("/player/venues/:venueId/availability", async (req, res, next) => {
    try {
      const venueId = Number(req.params.venueId);
      const dateStr = String(req.query.date || new Date().toISOString().slice(0, 10));
      const dt = new Date(`${dateStr}T00:00:00Z`);
      const jsDay = dt.getUTCDay();
      const isoDow = jsDay === 0 ? 7 : jsDay;

      const { rows } = await pool.query(
        `SELECT pc.complex_id, pc.complex_name,
                p.pitch_id, p.pitch_name, p.pitch_type, p.deposit_amount,
                ts.time_slot_id, ts.slot_name, ts.start_time, ts.end_time,
                COALESCE(pws.price, 400000) AS price,
                psb.slot_block_id,
                b.booking_id, b.status AS booking_status
         FROM pitch_complexes pc
         LEFT JOIN pitches p ON p.complex_id = pc.complex_id AND p.status = 'ACTIVE'
         LEFT JOIN time_slots ts ON p.pitch_id IS NOT NULL
         LEFT JOIN pitch_weekly_slots pws
           ON pws.pitch_id = p.pitch_id AND pws.time_slot_id = ts.time_slot_id AND pws.day_of_week = $2
         LEFT JOIN pitch_slot_blocks psb
           ON psb.pitch_id = p.pitch_id AND psb.block_date = $3::date AND psb.time_slot_id = ts.time_slot_id
         LEFT JOIN bookings b
           ON b.pitch_id = p.pitch_id AND b.booking_date = $3::date AND b.time_slot_id = ts.time_slot_id
          AND b.status IN ('PENDING', 'WAITING_FOR_DEPOSIT', 'CONFIRMED', 'COMPLETED', 'NO_SHOW')
         WHERE pc.complex_id = $1
         ORDER BY p.pitch_id ASC, ts.start_time ASC`,
        [venueId, isoDow, dateStr]
      );
      if (rows.length === 0) throw new AppError(404, "VENUE_NOT_FOUND", "Không tìm thấy cụm sân");

      const slotOrderMap = new Map();
      let counter = 1;
      const pitchMap = new Map();

      for (const r of rows) {
        if (!r.pitch_id) continue;
        const pid = Number(r.pitch_id);
        if (!pitchMap.has(pid)) {
          pitchMap.set(pid, {
            pitchId: pid,
            pitchName: r.pitch_name,
            pitchType: mapPitchTypeForFrontend(r.pitch_type),
            depositAmount: Number(r.deposit_amount),
            slots: [],
          });
        }
        if (r.time_slot_id) {
          const tid = Number(r.time_slot_id);
          if (!slotOrderMap.has(tid)) slotOrderMap.set(tid, counter++);
          let status = "AVAILABLE";
          if (r.slot_block_id) status = "BOOKED";
          else if (r.booking_id) {
            status = r.booking_status === "WAITING_FOR_DEPOSIT" || r.booking_status === "PENDING" ? "PENDING" : "BOOKED";
          }
          pitchMap.get(pid).slots.push({
            timeSlotId: tid,
            slotNumber: slotOrderMap.get(tid) || tid,
            slotName: r.slot_name,
            startTime: String(r.start_time).slice(0, 5),
            endTime: String(r.end_time).slice(0, 5),
            price: Number(r.price),
            status,
          });
        }
      }

      return res.json({
        venueId: Number(rows[0].complex_id),
        venueName: rows[0].complex_name,
        date: dateStr,
        pitches: Array.from(pitchMap.values()),
      });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/player/venues/:venueId/services (empty for Branches 1/2/4 scope)
  router.get("/player/venues/:venueId/services", (_req, res) => {
    return res.json([]);
  });

  // =========================================================================
  // 2. PLAYER BOOKINGS & REVIEWS
  // =========================================================================

  // POST /api/v1/player/bookings -> creates real WAITING_FOR_DEPOSIT 4h hold booking (fast RTT)
  router.post("/player/bookings", requireAuth, async (req, res, next) => {
    try {
      const pitchId = Number(req.body.pitchId);
      const bookingDate = String(req.body.bookingDate);
      const timeSlotId = Number(req.body.timeSlotId);
      const clientNote = req.body.clientNote || null;

      const dt = new Date(`${bookingDate}T00:00:00Z`);
      const isoDow = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay();

      const { rows: ctxRows } = await pool.query(
        `SELECT p.pitch_id, p.pitch_name, p.status, p.deposit_amount,
                pc.owner_user_id, pc.complex_name,
                pws.price AS weekly_price, ts.start_time, ts.end_time,
                psb.slot_block_id,
                oba.bank_account_id, oba.bank_name, oba.account_number,
                oba.account_holder, oba.transfer_instruction
         FROM pitches p
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         LEFT JOIN pitch_weekly_slots pws
           ON pws.pitch_id = p.pitch_id AND pws.day_of_week = $2 AND pws.time_slot_id = $3 AND pws.is_active = TRUE
         LEFT JOIN time_slots ts ON ts.time_slot_id = pws.time_slot_id
         LEFT JOIN pitch_slot_blocks psb
           ON psb.pitch_id = p.pitch_id AND psb.block_date = $4::date AND psb.time_slot_id = $3
         LEFT JOIN LATERAL (
           SELECT bank_account_id, bank_name, account_number, account_holder, transfer_instruction
           FROM owner_bank_accounts
           WHERE owner_user_id = pc.owner_user_id AND is_active = TRUE
           ORDER BY is_default DESC, bank_account_id DESC
           LIMIT 1
         ) oba ON TRUE
         WHERE p.pitch_id = $1`,
        [pitchId, isoDow, timeSlotId, bookingDate]
      );
      if (ctxRows.length === 0) throw new AppError(404, "PITCH_NOT_FOUND", "Không tìm thấy sân");
      const ctx = ctxRows[0];
      if (ctx.status !== "ACTIVE") throw new AppError(400, "PITCH_INACTIVE", "Sân đang tạm ngưng hoạt động");
      if (!ctx.weekly_price) throw new AppError(400, "SLOT_UNAVAILABLE", "Khung giờ không khả dụng");
      if (ctx.slot_block_id) throw new AppError(409, "SLOT_BLOCKED", "Khung giờ đã bị chủ sân khóa");

      const pitchPrice = Number(ctx.weekly_price);
      const depositAmount = Math.min(Number(ctx.deposit_amount || Math.round(pitchPrice * 0.3)), pitchPrice);
      const bookingCode = `SB-${bookingDate.replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      const { rows: bRows } = await pool.query(
        `WITH inserted AS (
           INSERT INTO bookings (
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
           RETURNING *
         ),
         hist AS (
           INSERT INTO booking_status_history (booking_id, old_status, new_status, changed_by, reason)
           SELECT booking_id, NULL, 'WAITING_FOR_DEPOSIT', $2, 'Đặt sân giữ chỗ 4 giờ' FROM inserted
         ),
         aud AS (
           INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, reason)
           SELECT $2, 'CREATE_BOOKING', 'BOOKING', booking_id, $14 FROM inserted
         )
         SELECT * FROM inserted`,
        [
          bookingCode,
          req.user.userId,
          pitchId,
          bookingDate,
          timeSlotId,
          pitchPrice,
          depositAmount,
          ctx.bank_account_id || null,
          ctx.bank_name || "MB Bank",
          ctx.account_number || "0389999888",
          ctx.account_holder || "CHU SAN DEMO SOCCER BOOKER",
          ctx.transfer_instruction || `Chuyển khoản cọc kèm nội dung: ${bookingCode}`,
          clientNote,
          `Tạo đơn ${bookingCode}`,
        ]
      );

      const b = bRows[0];
      return res.status(201).json({
        id: Number(b.booking_id),
        bookingId: Number(b.booking_id),
        bookingCode: b.booking_code,
        pitchId: Number(b.pitch_id),
        pitchName: ctx.pitch_name,
        venueName: ctx.complex_name,
        bookingDate,
        startTime: String(ctx.start_time).slice(0, 5),
        endTime: String(ctx.end_time).slice(0, 5),
        totalPrice: pitchPrice,
        depositAmount,
        status: b.status,
        expiresAt: b.expires_at,
        bankName: b.bank_name_snapshot,
        accountNumber: b.account_number_snapshot,
        accountHolder: b.account_holder_snapshot,
        transferInstruction: b.transfer_instruction_snapshot,
      });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/player/bookings -> real booking history
  router.get("/player/bookings", requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.booking_id AS id,
                b.booking_code AS "bookingCode",
                b.pitch_id AS "pitchId",
                p.pitch_name AS "pitchName",
                pc.complex_name AS "venueName",
                b.booking_date::text AS "bookingDate",
                ts.start_time::text AS "startTime",
                ts.end_time::text AS "endTime",
                b.pitch_price::float AS "totalPrice",
                b.deposit_amount::float AS "depositAmount",
                b.status,
                b.expires_at AS "expiresAt",
                b.bank_name_snapshot AS "bankName",
                b.account_number_snapshot AS "accountNumber",
                b.account_holder_snapshot AS "accountHolder",
                b.transfer_instruction_snapshot AS "transferInstruction",
                EXISTS (SELECT 1 FROM reviews rv WHERE rv.booking_id = b.booking_id) AS reviewed,
                EXISTS (SELECT 1 FROM booking_deposit_reports dr WHERE dr.booking_id = b.booking_id) AS "depositReported"
         FROM bookings b
         JOIN pitches p ON p.pitch_id = b.pitch_id
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         JOIN time_slots ts ON ts.time_slot_id = b.time_slot_id
         WHERE b.client_user_id = $1
         ORDER BY b.created_at DESC`,
        [req.user.userId]
      );
      const content = rows.map((r) => ({ ...r, id: Number(r.id), pitchId: Number(r.pitchId) }));
      return res.json({ content, totalPages: 1, totalElements: content.length });
    } catch (err) {
      return next(err);
    }
  });

  // Cancel helpers
  async function handleCancel(req, res, next) {
    try {
      const bookingId = Number(req.params.bookingId);
      const { rows: bRows } = await pool.query(
        "SELECT booking_id, client_user_id, status FROM bookings WHERE booking_id = $1",
        [bookingId]
      );
      if (bRows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy đơn đặt sân");
      if (Number(bRows[0].client_user_id) !== req.user.userId) {
        throw new AppError(403, "FORBIDDEN", "Không có quyền hủy đơn của người khác");
      }
      await pool.query(
        "UPDATE bookings SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE booking_id = $1",
        [bookingId]
      );
      await pool.query(
        "INSERT INTO booking_status_history (booking_id, old_status, new_status, changed_by, reason) VALUES ($1, $2, 'CANCELLED', $3, 'Khách hủy đơn')",
        [bookingId, bRows[0].status, req.user.userId]
      );
      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  }
  router.patch("/player/bookings/:bookingId/cancel", requireAuth, handleCancel);
  router.post("/player/bookings/:bookingId/cancel-unpaid", requireAuth, handleCancel);

  // POST /api/v1/player/reviews
  router.post("/player/reviews", requireAuth, async (req, res, next) => {
    try {
      const bookingId = Number(req.body.bookingId);
      const rating = Number(req.body.rating);
      const content = req.body.content || "";
      const { rows: bRows } = await pool.query(
        "SELECT booking_id, client_user_id, pitch_id, status FROM bookings WHERE booking_id = $1",
        [bookingId]
      );
      if (bRows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy đơn");
      if (Number(bRows[0].client_user_id) !== req.user.userId) throw new AppError(403, "FORBIDDEN", "Không có quyền");
      if (bRows[0].status !== "COMPLETED") throw new AppError(400, "INVALID_STATUS", "Chỉ đánh giá sau khi hoàn thành");

      const { rows } = await pool.query(
        "INSERT INTO reviews (booking_id, pitch_id, client_user_id, rating, content) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [bookingId, bRows[0].pitch_id, req.user.userId, rating, content]
      );
      return res.status(201).json({ ...rows[0], rewardPoints: 0, memberPoints: 0 });
    } catch (err) {
      return next(err);
    }
  });

  // =========================================================================
  // 3. OWNER / ADMIN VENUES, PITCHES, SLOTS & SCHEDULE
  // =========================================================================

  router.get("/admin/venues", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT pc.complex_id AS id, pc.complex_name AS name,
                CONCAT_WS(', ', pc.address_line, pc.district, pc.province) AS address,
                pop.contact_phone AS phone, pop.contact_email AS email
         FROM pitch_complexes pc
         LEFT JOIN pitch_owner_profiles pop ON pop.user_id = pc.owner_user_id
         WHERE pc.owner_user_id = $1 AND pc.status = 'ACTIVE'
         ORDER BY pc.complex_id ASC`,
        [req.user.userId]
      );
      const content = rows.map((r) => ({ ...r, id: String(r.id) }));
      return res.json({ content, totalPages: 1, totalElements: content.length });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/admin/venues", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const v = typeof req.body?.venue === "string" ? JSON.parse(req.body.venue) : req.body;
      const { rows } = await pool.query(
        `INSERT INTO pitch_complexes (owner_user_id, complex_name, address_line, district, province, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING complex_id AS id, complex_name AS name, address_line AS address`,
        [req.user.userId, v.name || "Cụm sân mới", v.address || "Hà Nội", v.district || "Hai Bà Trưng", "Hà Nội", v.description || ""]
      );
      return res.status(201).json({ ...rows[0], id: Number(rows[0].id) });
    } catch (err) {
      return next(err);
    }
  });

  router.get("/admin/venues/:venueId/pitches", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const venueId = Number(req.params.venueId);
      const { rows: pitches } = await pool.query(
        `SELECT p.*, pc.complex_name
         FROM pitches p
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         WHERE p.complex_id = $1 AND pc.owner_user_id = $2
         ORDER BY p.pitch_id ASC`,
        [venueId, req.user.userId]
      );
      const { rows: slots } = await pool.query("SELECT * FROM time_slots ORDER BY start_time ASC");
      const { rows: ws } = await pool.query(
        `SELECT pws.* FROM pitch_weekly_slots pws
         JOIN pitches p ON p.pitch_id = pws.pitch_id
         WHERE p.complex_id = $1`,
        [venueId]
      );

      const content = pitches.map((p) => {
        const myWs = ws.filter((w) => Number(w.pitch_id) === Number(p.pitch_id));
        const slotPrices = slots.map((s, idx) => {
          const wd = myWs.find((w) => Number(w.time_slot_id) === Number(s.time_slot_id) && w.day_of_week === 1);
          const we = myWs.find((w) => Number(w.time_slot_id) === Number(s.time_slot_id) && w.day_of_week === 7);
          return {
            slotNumber: idx + 1,
            timeSlotId: Number(s.time_slot_id),
            weekdayPrice: wd ? Number(wd.price) : 400000,
            weekendPrice: we ? Number(we.price) : 500000,
          };
        });
        return {
          id: Number(p.pitch_id),
          name: p.pitch_name,
          pitchType: mapPitchTypeForFrontend(p.pitch_type),
          isActive: p.status === "ACTIVE",
          venueId: Number(p.complex_id),
          venueName: p.complex_name,
          basePrice: slotPrices[0]?.weekdayPrice || 400000,
          depositAmount: Number(p.deposit_amount),
          slotPrices,
        };
      });
      return res.json({ content, totalPages: 1, totalElements: content.length });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/admin/venues/:venueId/pitches", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const venueId = Number(req.params.venueId);
      const { name, pitchType, isActive = true, slotPrices = [] } = req.body;
      const created = await withTransaction(pool, async (client) => {
        const { rows: pRows } = await client.query(
          `INSERT INTO pitches (complex_id, pitch_name, pitch_type, surface_type, deposit_amount, status)
           VALUES ($1, $2, $3, 'Cỏ nhân tạo', 200000, $4)
           RETURNING *`,
          [venueId, name, mapPitchTypeToDb(pitchType), isActive ? "ACTIVE" : "INACTIVE"]
        );
        const pitch = pRows[0];
        const { rows: tsRows } = await client.query("SELECT time_slot_id FROM time_slots ORDER BY start_time ASC");
        const slotIds = [];
        const dows = [];
        const prices = [];
        for (let idx = 0; idx < tsRows.length; idx++) {
          const sp = slotPrices[idx] || {};
          for (let dow = 1; dow <= 7; dow++) {
            slotIds.push(Number(tsRows[idx].time_slot_id));
            dows.push(dow);
            prices.push(dow >= 6 ? Number(sp.weekendPrice || 600000) : Number(sp.weekdayPrice || 450000));
          }
        }
        if (slotIds.length > 0) {
          await client.query(
            `INSERT INTO pitch_weekly_slots (pitch_id, day_of_week, time_slot_id, price, is_active)
             SELECT $1, u.dow, u.slot_id, u.price, TRUE
             FROM UNNEST($2::smallint[], $3::bigint[], $4::numeric[]) AS u(dow, slot_id, price)
             ON CONFLICT DO NOTHING`,
            [pitch.pitch_id, dows, slotIds, prices]
          );
        }
        return {
          id: Number(pitch.pitch_id),
          name: pitch.pitch_name,
          pitchType: mapPitchTypeForFrontend(pitch.pitch_type),
          isActive: pitch.status === "ACTIVE",
          venueId,
        };
      });
      return res.status(201).json(created);
    } catch (err) {
      return next(err);
    }
  });

  router.put("/admin/pitches/:pitchId", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const pitchId = Number(req.params.pitchId);
      const { name, pitchType, isActive, slotPrices = [] } = req.body;
      const updated = await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `UPDATE pitches
           SET pitch_name = COALESCE($1, pitch_name),
               pitch_type = COALESCE($2, pitch_type),
               status = COALESCE($3, status),
               updated_at = CURRENT_TIMESTAMP
           WHERE pitch_id = $4 RETURNING *`,
          [name || null, pitchType ? mapPitchTypeToDb(pitchType) : null, isActive === undefined ? null : isActive ? "ACTIVE" : "INACTIVE", pitchId]
        );
        if (rows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy sân");
        const { rows: tsRows } = await client.query("SELECT time_slot_id FROM time_slots ORDER BY start_time ASC");
        const slotIds = [];
        const dows = [];
        const prices = [];
        for (let idx = 0; idx < Math.min(slotPrices.length, tsRows.length); idx++) {
          const sp = slotPrices[idx];
          for (let dow = 1; dow <= 7; dow++) {
            slotIds.push(Number(tsRows[idx].time_slot_id));
            dows.push(dow);
            prices.push(dow >= 6 ? Number(sp.weekendPrice ?? sp.weekdayPrice ?? 500000) : Number(sp.weekdayPrice ?? 400000));
          }
        }
        if (slotIds.length > 0) {
          await client.query(
            `INSERT INTO pitch_weekly_slots (pitch_id, day_of_week, time_slot_id, price, is_active)
             SELECT $1, u.dow, u.slot_id, u.price, TRUE
             FROM UNNEST($2::smallint[], $3::bigint[], $4::numeric[]) AS u(dow, slot_id, price)
             ON CONFLICT (pitch_id, day_of_week, time_slot_id) DO UPDATE SET price = EXCLUDED.price`,
            [pitchId, dows, slotIds, prices]
          );
        }
        return {
          id: Number(rows[0].pitch_id),
          name: rows[0].pitch_name,
          pitchType: mapPitchTypeForFrontend(rows[0].pitch_type),
          isActive: rows[0].status === "ACTIVE",
          venueId: Number(rows[0].complex_id),
        };
      });
      return res.json(updated);
    } catch (err) {
      return next(err);
    }
  });

  router.delete("/admin/pitches/:pitchId", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      await pool.query("UPDATE pitches SET status = 'INACTIVE', updated_at = CURRENT_TIMESTAMP WHERE pitch_id = $1", [
        Number(req.params.pitchId),
      ]);
      return res.status(204).send();
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/owner/pitches/:pitchId/weekly-slots & slot-blocks (read helpers)
  router.get("/owner/pitches/:pitchId/weekly-slots", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT pws.*, ts.slot_name, ts.start_time, ts.end_time
         FROM pitch_weekly_slots pws
         JOIN time_slots ts ON ts.time_slot_id = pws.time_slot_id
         WHERE pws.pitch_id = $1 ORDER BY pws.day_of_week, ts.start_time`,
        [Number(req.params.pitchId)]
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      return next(err);
    }
  });

  router.get("/owner/pitches/:pitchId/slot-blocks", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT psb.*, ts.slot_name, ts.start_time, ts.end_time
         FROM pitch_slot_blocks psb
         JOIN time_slots ts ON ts.time_slot_id = psb.time_slot_id
         WHERE psb.pitch_id = $1 ORDER BY psb.block_date DESC`,
        [Number(req.params.pitchId)]
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      return next(err);
    }
  });

  // =========================================================================
  // 4. OWNER BOOKINGS, SCHEDULES & DASHBOARD STATS
  // =========================================================================

  router.get("/admin/bookings", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const venueId = req.query.venueId ? Number(req.query.venueId) : null;
      const { rows } = await pool.query(
        `SELECT b.booking_id AS id,
                b.booking_code AS "bookingCode",
                u.full_name AS "customerName",
                u.phone AS "customerPhone",
                pc.complex_name AS "venueName",
                p.pitch_name AS "pitchName",
                b.booking_date::text AS "bookingDate",
                ts.start_time::text AS "startTime",
                ts.end_time::text AS "endTime",
                b.pitch_price::float AS "totalPrice",
                b.deposit_amount::float AS "depositAmount",
                b.status,
                b.expires_at AS "expiresAt",
                bdr.reported_amount::float AS "reportedAmount",
                bdr.status AS "depositReportStatus"
         FROM bookings b
         JOIN pitches p ON p.pitch_id = b.pitch_id
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         JOIN time_slots ts ON ts.time_slot_id = b.time_slot_id
         JOIN users u ON u.user_id = b.client_user_id
         LEFT JOIN LATERAL (
           SELECT reported_amount, status
           FROM booking_deposit_reports
           WHERE booking_id = b.booking_id
           ORDER BY created_at DESC
           LIMIT 1
         ) bdr ON TRUE
         WHERE pc.owner_user_id = $1
           AND ($2::bigint IS NULL OR pc.complex_id = $2::bigint)
         ORDER BY b.created_at DESC
         LIMIT 200`,
        [req.user.userId, venueId]
      );
      const content = rows.map((r) => ({ ...r, id: Number(r.id) }));
      return res.json({ content, totalPages: 1, totalElements: content.length });
    } catch (err) {
      return next(err);
    }
  });

  router.get("/admin/bookings/schedules", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const dateStr = String(req.query.date || new Date().toISOString().slice(0, 10));
      const venueId = req.query.venueId && req.query.venueId !== "ALL" ? Number(req.query.venueId) : null;
      const dt = new Date(`${dateStr}T00:00:00Z`);
      const isoDow = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay();

      const { rows: matrix } = await pool.query(
        `SELECT p.pitch_id, p.pitch_name, pc.complex_name,
                ts.time_slot_id, ts.start_time, ts.end_time,
                COALESCE(pws.price, 400000) AS price,
                psb.slot_block_id, psb.reason AS block_reason,
                b.booking_id, b.status AS booking_status, b.deposit_amount,
                u.full_name AS customer_name, u.phone AS customer_phone
         FROM pitches p
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         CROSS JOIN time_slots ts
         LEFT JOIN pitch_weekly_slots pws ON pws.pitch_id = p.pitch_id AND pws.time_slot_id = ts.time_slot_id AND pws.day_of_week = $2
         LEFT JOIN pitch_slot_blocks psb ON psb.pitch_id = p.pitch_id AND psb.block_date = $3::date AND psb.time_slot_id = ts.time_slot_id
         LEFT JOIN bookings b ON b.pitch_id = p.pitch_id AND b.booking_date = $3::date AND b.time_slot_id = ts.time_slot_id
           AND b.status IN ('PENDING', 'WAITING_FOR_DEPOSIT', 'CONFIRMED', 'COMPLETED', 'NO_SHOW')
         LEFT JOIN users u ON u.user_id = b.client_user_id
         WHERE pc.owner_user_id = $1 AND p.status = 'ACTIVE'
           AND ($4::bigint IS NULL OR pc.complex_id = $4::bigint)
         ORDER BY pc.complex_id, p.pitch_id, ts.start_time`,
        [req.user.userId, isoDow, dateStr, venueId]
      );

      const pitchMap = new Map();
      for (const m of matrix) {
        const pid = Number(m.pitch_id);
        if (!pitchMap.has(pid)) {
          pitchMap.set(pid, {
            pitchId: pid,
            pitchName: m.pitch_name,
            venueName: m.complex_name,
            slots: [],
          });
        }
        const entry = pitchMap.get(pid);
        let status = "AVAILABLE";
        if (m.slot_block_id) status = "MAINTENANCE";
        else if (m.booking_id) status = "BOOKED";
        entry.slots.push({
          timeSlotId: Number(m.time_slot_id),
          slotNumber: entry.slots.length + 1,
          startTime: String(m.start_time).slice(0, 5),
          endTime: String(m.end_time).slice(0, 5),
          status,
          customerName: m.customer_name || (m.slot_block_id ? m.block_reason || "Bảo trì" : null),
          customerPhone: m.customer_phone || null,
          depositAmount: m.deposit_amount ? Number(m.deposit_amount) : 0,
          price: Number(m.price),
        });
      }
      return res.json(Array.from(pitchMap.values()));
    } catch (err) {
      return next(err);
    }
  });

  router.get("/admin/bookings/:bookingId", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.*, p.pitch_name, pc.complex_id, pc.complex_name, ts.start_time, ts.end_time,
                u.full_name AS customer_name, u.phone AS customer_phone, u.email AS customer_email
         FROM bookings b
         JOIN pitches p ON p.pitch_id = b.pitch_id
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         JOIN time_slots ts ON ts.time_slot_id = b.time_slot_id
         JOIN users u ON u.user_id = b.client_user_id
         WHERE b.booking_id = $1 AND pc.owner_user_id = $2`,
        [Number(req.params.bookingId), req.user.userId]
      );
      if (rows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy đơn đặt sân");
      const b = rows[0];
      return res.json({
        id: Number(b.booking_id),
        venueId: Number(b.complex_id),
        venueName: b.complex_name,
        pitchName: b.pitch_name,
        bookingDate: b.booking_date,
        startTime: String(b.start_time).slice(0, 5),
        endTime: String(b.end_time).slice(0, 5),
        status: b.status,
        customerName: b.customer_name,
        customerPhone: b.customer_phone,
        customerEmail: b.customer_email,
        totalPrice: Number(b.pitch_price),
        depositAmount: Number(b.deposit_amount),
        paymentStatus: b.status === "CONFIRMED" || b.status === "COMPLETED" ? "PAID" : "PENDING",
        adminNote: b.owner_note,
        createdAt: b.created_at,
        updatedAt: b.updated_at,
        addOns: [],
      });
    } catch (err) {
      return next(err);
    }
  });

  // PATCH /api/v1/admin/bookings/:orderId/status
  router.patch("/admin/bookings/:orderId/status", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const bookingId = Number(req.params.orderId);
      const nextStatusRaw = String(req.body.status || "").toUpperCase();
      const adminNote = req.body.adminNote || "";

      await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `SELECT b.*, pc.owner_user_id FROM bookings b
           JOIN pitches p ON p.pitch_id = b.pitch_id
           JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
           WHERE b.booking_id = $1`,
          [bookingId]
        );
        if (rows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy đơn");
        const b = rows[0];
        if (Number(b.owner_user_id) !== req.user.userId) throw new AppError(403, "FORBIDDEN", "Không có quyền");

        const targetStatus =
          nextStatusRaw === "BOOKED" || nextStatusRaw === "CONFIRMED"
            ? "CONFIRMED"
            : nextStatusRaw === "COMPLETED"
            ? "COMPLETED"
            : nextStatusRaw === "NO_SHOW"
            ? "NO_SHOW"
            : "CANCELLED";

        await client.query(
          `UPDATE bookings SET status = $1::booking_status, owner_note = COALESCE($2, owner_note),
             confirmed_at = CASE WHEN $1::text = 'CONFIRMED' THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
             completed_at = CASE WHEN $1::text = 'COMPLETED' THEN CURRENT_TIMESTAMP ELSE completed_at END,
             cancelled_at = CASE WHEN $1::text = 'CANCELLED' THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
             updated_at = CURRENT_TIMESTAMP
           WHERE booking_id = $3`,
          [targetStatus, adminNote, bookingId]
        );

        if (targetStatus === "CONFIRMED" && b.status !== "CONFIRMED") {
          const amt = Number(b.deposit_amount) > 0 ? Number(b.deposit_amount) : Number(b.pitch_price);
          await client.query(
            `INSERT INTO financial_entries (owner_user_id, booking_id, entry_type, amount, description, recorded_by)
             VALUES ($1, $2, 'RECEIVED', $3, $4, $1)`,
            [req.user.userId, bookingId, amt, `Xác nhận cọc đơn ${b.booking_code}`]
          );
          await client.query(
            `UPDATE booking_deposit_reports SET status = 'CONFIRMED', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP
             WHERE booking_id = $2 AND status = 'REPORTED'`,
            [req.user.userId, bookingId]
          );
        }

        await client.query(
          `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, reason)
           VALUES ($1, $2, 'BOOKING', $3, $4)`,
          [req.user.userId, `STATUS_${targetStatus}`, bookingId, adminNote || `Chuyển sang ${targetStatus}`]
        );
      });

      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  });

  router.get("/admin/dashboard/stats", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const facilityId = req.query.facilityId && req.query.facilityId !== "ALL" ? Number(req.query.facilityId) : null;
      const [{ rows: summary }, { rows: perf }] = await Promise.all([
        pool.query(
          `SELECT
             COALESCE(SUM(CASE WHEN b.status IN ('CONFIRMED','COMPLETED') THEN b.pitch_price ELSE 0 END), 0)::float AS total_revenue,
             COUNT(b.booking_id)::int AS total_bookings,
             COUNT(b.booking_id) FILTER (WHERE b.status IN ('CANCELLED','REJECTED','EXPIRED'))::int AS canceled_bookings,
             COUNT(DISTINCT b.client_user_id)::int AS unique_customers
           FROM bookings b
           JOIN pitches p ON p.pitch_id = b.pitch_id
           JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
           WHERE pc.owner_user_id = $1
             AND ($2::bigint IS NULL OR pc.complex_id = $2::bigint)`,
          [req.user.userId, facilityId]
        ),
        pool.query(
          `SELECT p.pitch_id AS "pitchId", p.pitch_name AS "pitchName",
                  COUNT(b.booking_id) FILTER (WHERE b.status IN ('CONFIRMED','COMPLETED','WAITING_FOR_DEPOSIT'))::int AS "bookingCount",
                  COALESCE(SUM(CASE WHEN b.status IN ('CONFIRMED','COMPLETED') THEN b.pitch_price ELSE 0 END), 0)::float AS revenue
           FROM pitches p
           JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
           LEFT JOIN bookings b ON b.pitch_id = p.pitch_id
           WHERE pc.owner_user_id = $1 AND ($2::bigint IS NULL OR pc.complex_id = $2::bigint)
           GROUP BY p.pitch_id, p.pitch_name
           ORDER BY "bookingCount" DESC`,
          [req.user.userId, facilityId]
        ),
      ]);

      const st = summary[0];
      const totalSlots = Math.max(perf.length * 6, 1);
      const occupancyRate = Math.min(100, Math.round((st.total_bookings / totalSlots) * 100));

      return res.json({
        totalRevenue: st.total_revenue,
        totalBookings: st.total_bookings,
        canceledBookings: st.canceled_bookings,
        uniqueCustomers: st.unique_customers,
        occupancyRate,
        pitchPerformances: perf,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.get("/admin/dashboard/recent-orders", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.booking_id AS id, u.full_name AS "customerName", p.pitch_name AS "fieldName",
                CONCAT(ts.start_time::text, ' - ', b.booking_date::text) AS "bookingTime",
                b.pitch_price::float AS price, b.status
         FROM bookings b
         JOIN pitches p ON p.pitch_id = b.pitch_id
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         JOIN time_slots ts ON ts.time_slot_id = b.time_slot_id
         JOIN users u ON u.user_id = b.client_user_id
         WHERE pc.owner_user_id = $1
         ORDER BY b.created_at DESC LIMIT 8`,
        [req.user.userId]
      );
      return res.json(rows.map((r) => ({ ...r, id: Number(r.id) })));
    } catch (err) {
      return next(err);
    }
  });

  router.get("/admin/activity-logs", requireAuth, requireRole("PITCH_OWNER"), async (_req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT al.audit_log_id AS id, u.full_name AS "actorName", al.action,
                al.entity_type AS "entityType", al.reason AS description, al.created_at AS "createdAt"
         FROM audit_logs al
         LEFT JOIN users u ON u.user_id = al.actor_user_id
         ORDER BY al.created_at DESC LIMIT 20`
      );
      return res.json({ content: rows, totalPages: 1, totalElements: rows.length });
    } catch (err) {
      return next(err);
    }
  });

  // Notifications stub backed by real recent bookings (prevents 404 polling noise)
  router.get("/notifications", requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.booking_id AS id,
                CONCAT('Đơn đặt sân ', b.booking_code) AS title,
                CONCAT(p.pitch_name, ' - Trạng thái: ', b.status) AS message,
                b.created_at AS "createdAt",
                TRUE AS "isRead"
         FROM bookings b
         JOIN pitches p ON p.pitch_id = b.pitch_id
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         WHERE b.client_user_id = $1 OR pc.owner_user_id = $1
         ORDER BY b.created_at DESC LIMIT 6`,
        [req.user.userId]
      );
      return res.json(rows.map((r) => ({ ...r, id: Number(r.id) })));
    } catch (err) {
      return next(err);
    }
  });

  router.get("/notifications/unread-count", requireAuth, (_req, res) => {
    return res.json({ count: 0 });
  });

  router.patch("/notifications/read-all", requireAuth, (_req, res) => {
    return res.json({ success: true });
  });

  return router;
}

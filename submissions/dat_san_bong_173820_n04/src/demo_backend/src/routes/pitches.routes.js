import express from "express";
import { AppError } from "../middleware/errorHandler.js";

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function createPitchesRouter(pool) {
  const router = express.Router();

  // GET /api/v1/time-slots
  router.get("/time-slots", async (_req, res, next) => {
    try {
      const { rows } = await pool.query("SELECT * FROM time_slots ORDER BY start_time ASC");
      return res.json({ success: true, data: rows });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/pitches (FR-05..FR-08)
  router.get("/pitches", async (req, res, next) => {
    try {
      const q = String(req.query.q || "").trim().toLowerCase();
      const district = String(req.query.district || "").trim().toLowerCase();
      const pitchType = String(req.query.pitchType || "").trim();
      const lat = req.query.lat !== undefined ? Number(req.query.lat) : null;
      const lng = req.query.lng !== undefined ? Number(req.query.lng) : null;
      const radiusKm = req.query.radiusKm !== undefined ? Number(req.query.radiusKm) : null;

      const { rows } = await pool.query(
        `SELECT p.pitch_id, p.complex_id, p.pitch_name, p.pitch_type, p.surface_type, p.description,
                p.deposit_amount, p.status,
                pc.complex_name, pc.address_line, pc.ward, pc.district, pc.province,
                pc.latitude, pc.longitude, pc.owner_user_id,
                COALESCE(v.review_count, 0) AS review_count,
                COALESCE(v.average_rating, 0) AS average_rating,
                (SELECT MIN(pws.price) FROM pitch_weekly_slots pws WHERE pws.pitch_id = p.pitch_id AND pws.is_active = TRUE) AS min_price,
                (SELECT MAX(pws.price) FROM pitch_weekly_slots pws WHERE pws.pitch_id = p.pitch_id AND pws.is_active = TRUE) AS max_price
         FROM pitches p
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         LEFT JOIN v_pitch_rating_summary v ON v.pitch_id = p.pitch_id
         WHERE p.status = 'ACTIVE' AND pc.status = 'ACTIVE'
         ORDER BY p.pitch_id ASC`
      );

      let filtered = rows.map((r) => {
        const dist =
          lat !== null && lng !== null && r.latitude !== null && r.longitude !== null
            ? Number(haversineKm(lat, lng, Number(r.latitude), Number(r.longitude)).toFixed(2))
            : null;
        return { ...r, distance_km: dist };
      });

      if (q) {
        filtered = filtered.filter(
          (r) =>
            r.pitch_name.toLowerCase().includes(q) ||
            r.complex_name.toLowerCase().includes(q) ||
            r.address_line.toLowerCase().includes(q)
        );
      }
      if (district) {
        filtered = filtered.filter((r) => (r.district || "").toLowerCase().includes(district));
      }
      if (pitchType) {
        filtered = filtered.filter((r) => r.pitch_type.toLowerCase() === pitchType.toLowerCase());
      }
      if (radiusKm !== null && lat !== null && lng !== null) {
        filtered = filtered
          .filter((r) => r.distance_km !== null && r.distance_km <= radiusKm)
          .sort((a, b) => a.distance_km - b.distance_km);
      }

      return res.json({ success: true, data: filtered });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/pitches/:pitchId (FR-09)
  router.get("/pitches/:pitchId", async (req, res, next) => {
    try {
      const pitchId = Number(req.params.pitchId);
      const { rows } = await pool.query(
        `SELECT p.*, pc.complex_name, pc.address_line, pc.ward, pc.district, pc.province,
                pc.latitude, pc.longitude, pc.owner_user_id,
                pop.display_name AS owner_display_name, pop.contact_phone AS owner_phone,
                COALESCE(v.review_count, 0) AS review_count,
                COALESCE(v.average_rating, 0) AS average_rating
         FROM pitches p
         JOIN pitch_complexes pc ON pc.complex_id = p.complex_id
         LEFT JOIN pitch_owner_profiles pop ON pop.user_id = pc.owner_user_id
         LEFT JOIN v_pitch_rating_summary v ON v.pitch_id = p.pitch_id
         WHERE p.pitch_id = $1`,
        [pitchId]
      );
      if (rows.length === 0) throw new AppError(404, "PITCH_NOT_FOUND", "Không tìm thấy sân bóng");
      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/pitches/:pitchId/slots?date=YYYY-MM-DD (FR-10; FR-52; FR-53)
  router.get("/pitches/:pitchId/slots", async (req, res, next) => {
    try {
      const pitchId = Number(req.params.pitchId);
      const dateStr = String(req.query.date || new Date().toISOString().slice(0, 10));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        throw new AppError(400, "INVALID_DATE", "Định dạng ngày phải là YYYY-MM-DD");
      }

      // Compute ISO day_of_week (1=Monday .. 7=Sunday)
      const dt = new Date(`${dateStr}T00:00:00Z`);
      const jsDay = dt.getUTCDay(); // 0=Sun..6=Sat
      const isoDow = jsDay === 0 ? 7 : jsDay;

      const { rows } = await pool.query(
        `SELECT ts.time_slot_id, ts.slot_name, ts.start_time, ts.end_time,
                pws.price, pws.is_active,
                psb.slot_block_id, psb.reason AS block_reason,
                b.booking_id, b.status AS booking_status
         FROM time_slots ts
         JOIN pitch_weekly_slots pws
           ON pws.time_slot_id = ts.time_slot_id
          AND pws.pitch_id = $1
          AND pws.day_of_week = $2
         LEFT JOIN pitch_slot_blocks psb
           ON psb.pitch_id = $1
          AND psb.block_date = $3::date
          AND psb.time_slot_id = ts.time_slot_id
         LEFT JOIN bookings b
           ON b.pitch_id = $1
          AND b.booking_date = $3::date
          AND b.time_slot_id = ts.time_slot_id
          AND b.status IN ('PENDING', 'WAITING_FOR_DEPOSIT', 'CONFIRMED', 'COMPLETED', 'NO_SHOW')
         WHERE pws.is_active = TRUE
         ORDER BY ts.start_time ASC`,
        [pitchId, isoDow, dateStr]
      );

      const slots = rows.map((r) => {
        let availability = "AVAILABLE";
        if (r.slot_block_id) availability = "BLOCKED";
        else if (r.booking_id) availability = "BOOKED";
        return {
          time_slot_id: Number(r.time_slot_id),
          slot_name: r.slot_name,
          start_time: r.start_time,
          end_time: r.end_time,
          price: Number(r.price),
          availability,
          block_reason: r.block_reason || null,
          booking_status: r.booking_status || null,
        };
      });

      return res.json({ success: true, date: dateStr, dayOfWeek: isoDow, data: slots });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const updateMeSchema = z.object({
  fullName: z.string().trim().min(2).max(150).optional(),
  username: z.string().trim().min(2).max(150).optional(),
  phone: z.string().trim().min(9).max(20).optional(),
  phoneNumber: z.string().trim().min(9).max(20).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6, "Mật khẩu mới tối thiểu 6 ký tự"),
});

const ownerProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(150),
  contactEmail: z.string().trim().email().optional().or(z.literal("")),
  contactPhone: z.string().trim().max(20).optional().or(z.literal("")),
  facebookUrl: z.string().trim().optional().or(z.literal("")),
  otherContact: z.string().trim().optional().or(z.literal("")),
});

export function createUsersRouter(pool) {
  const router = express.Router();

  // GET /api/v1/users/me (FR-04)
  router.get("/users/me", requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT u.user_id, u.full_name, u.email, u.phone, u.status, u.email_verified_at, u.created_at,
                COALESCE(array_agg(r.code::text) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.user_id
         LEFT JOIN roles r ON r.role_id = ur.role_id
         WHERE u.user_id = $1
         GROUP BY u.user_id`,
        [req.user.userId]
      );
      if (rows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy người dùng");
      const u = rows[0];
      const primaryRole = u.roles.includes("PITCH_OWNER") ? "PITCH_OWNER" : "CLIENT";
      const profileDto = {
        id: Number(u.user_id),
        userId: Number(u.user_id),
        username: u.full_name,
        fullName: u.full_name,
        email: u.email,
        phone: u.phone,
        phoneNumber: u.phone,
        status: u.status,
        role: primaryRole,
        roles: u.roles,
        membershipPoints: 0,
        walletBalance: 0,
        createdAt: u.created_at,
      };
      return res.json({
        success: true,
        ...profileDto,
        data: profileDto,
      });
    } catch (err) {
      return next(err);
    }
  });

  // PATCH /api/v1/users/me (FR-04)
  router.patch("/users/me", requireAuth, async (req, res, next) => {
    try {
      const body = updateMeSchema.parse(req.body);
      const nextName = body.fullName || body.username || null;
      const nextPhone = body.phone || body.phoneNumber || null;

      const { rows } = await pool.query(
        `UPDATE users
         SET full_name = COALESCE($1, full_name),
             phone = COALESCE($2, phone),
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3
         RETURNING user_id, full_name, email, phone, status, created_at`,
        [nextName, nextPhone, req.user.userId]
      );
      const u = rows[0];
      return res.json({
        success: true,
        id: Number(u.user_id),
        username: u.full_name,
        fullName: u.full_name,
        email: u.email,
        phone: u.phone,
        phoneNumber: u.phone,
        data: u,
      });
    } catch (err) {
      return next(err);
    }
  });

  // PATCH /api/v1/users/me/password (Change password for Branch 1)
  router.patch("/users/me/password", requireAuth, async (req, res, next) => {
    try {
      const body = changePasswordSchema.parse(req.body);
      const { rows } = await pool.query("SELECT password_hash FROM users WHERE user_id = $1", [
        req.user.userId,
      ]);
      if (rows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy người dùng");
      const ok = rows[0].password_hash
        ? await bcrypt.compare(body.currentPassword, rows[0].password_hash)
        : false;
      if (!ok) {
        throw new AppError(400, "INVALID_PASSWORD", "Mật khẩu hiện tại không chính xác");
      }
      const newHash = await bcrypt.hash(body.newPassword, 10);
      await pool.query(
        "UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
        [newHash, req.user.userId]
      );
      return res.json({ success: true, message: "Đổi mật khẩu thành công" });
    } catch (err) {
      return next(err);
    }
  });

  // PUT /api/v1/owner/profile (FR-47)
  router.put("/owner/profile", requireAuth, requireRole("PITCH_OWNER"), async (req, res, next) => {
    try {
      const body = ownerProfileSchema.parse(req.body);
      const { rows } = await pool.query(
        `INSERT INTO pitch_owner_profiles (user_id, display_name, contact_email, contact_phone, facebook_url, other_contact)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           contact_email = EXCLUDED.contact_email,
           contact_phone = EXCLUDED.contact_phone,
           facebook_url = EXCLUDED.facebook_url,
           other_contact = EXCLUDED.other_contact,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [
          req.user.userId,
          body.displayName,
          body.contactEmail || null,
          body.contactPhone || null,
          body.facebookUrl || null,
          body.otherContact || null,
        ]
      );
      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/pitch-owners/:ownerId (FR-09; FR-47)
  router.get("/pitch-owners/:ownerId", async (req, res, next) => {
    try {
      const ownerId = Number(req.params.ownerId);
      const { rows } = await pool.query(
        `SELECT u.user_id, u.full_name, pop.display_name, pop.contact_email, pop.contact_phone, pop.facebook_url
         FROM users u
         LEFT JOIN pitch_owner_profiles pop ON pop.user_id = u.user_id
         WHERE u.user_id = $1`,
        [ownerId]
      );
      if (rows.length === 0) throw new AppError(404, "NOT_FOUND", "Không tìm thấy chủ sân");
      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

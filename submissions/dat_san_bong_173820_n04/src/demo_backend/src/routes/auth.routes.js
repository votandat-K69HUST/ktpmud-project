import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { withTransaction } from "../config/db.js";
import { signToken, requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const registerSchema = z
  .object({
    fullName: z.string().trim().min(2, "Họ tên tối thiểu 2 ký tự").optional(),
    username: z.string().trim().min(2, "Họ tên tối thiểu 2 ký tự").optional(),
    email: z.string().trim().email("Email không hợp lệ"),
    phone: z.string().trim().min(9, "Số điện thoại không hợp lệ").max(20).optional(),
    password: z.string().min(6, "Mật khẩu tối thiểu 6 ký tự"),
    asPitchOwner: z.boolean().optional(),
    role: z.string().optional(),
    autoVerifyDemo: z.boolean().optional().default(false),
  })
  .refine((d) => Boolean(d.fullName || d.username), {
    message: "Vui lòng nhập họ tên",
    path: ["fullName"],
  });

const loginSchema = z
  .object({
    email: z.string().trim().optional(),
    identifier: z.string().trim().optional(),
    password: z.string().min(1, "Vui lòng nhập mật khẩu"),
    role: z.string().optional(),
  })
  .refine((d) => Boolean((d.email || d.identifier || "").trim()), {
    message: "Vui lòng nhập email hoặc số điện thoại",
    path: ["email"],
  });

export function createAuthRouter(pool) {
  const router = express.Router();

  // POST /api/v1/auth/register (FR-01)
  router.post("/register", async (req, res, next) => {
    try {
      const body = registerSchema.parse(req.body);
      const fullName = (body.fullName || body.username).trim();
      const email = body.email.toLowerCase();
      const phone = body.phone || `09${Math.floor(10000000 + Math.random() * 89999999)}`;
      const isOwner =
        Boolean(body.asPitchOwner) ||
        body.role === "PITCH_OWNER" ||
        body.role === "ADMIN" ||
        body.role === "OWNER";
      const passwordHash = await bcrypt.hash(body.password, 10);
      const rawToken = crypto.randomBytes(24).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

      const result = await withTransaction(pool, async (client) => {
        const dup = await client.query(
          "SELECT user_id FROM users WHERE LOWER(email) = $1 OR phone = $2",
          [email, phone]
        );
        if (dup.rowCount > 0) {
          throw new AppError(409, "DUPLICATE_USER", "Email hoặc số điện thoại đã được đăng ký");
        }

        const initialStatus = body.autoVerifyDemo ? "ACTIVE" : "PENDING_VERIFICATION";
        const { rows: uRows } = await client.query(
          `INSERT INTO users (full_name, email, phone, password_hash, status, email_verified_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING user_id, full_name, email, phone, status, created_at`,
          [fullName, email, phone, passwordHash, initialStatus, body.autoVerifyDemo ? new Date() : null]
        );
        const user = uRows[0];

        const roleCodes = isOwner ? ["CLIENT", "PITCH_OWNER"] : ["CLIENT"];
        await client.query(
          `INSERT INTO user_roles (user_id, role_id)
           SELECT $1, role_id FROM roles WHERE code = ANY($2::role_code[])`,
          [user.user_id, roleCodes]
        );

        if (isOwner) {
          await client.query(
            `INSERT INTO pitch_owner_profiles (user_id, display_name, contact_email, contact_phone)
             VALUES ($1, $2, $3, $4)`,
            [user.user_id, fullName, email, phone]
          );
        }

        if (!body.autoVerifyDemo) {
          await client.query(
            `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '24 hours')`,
            [user.user_id, tokenHash]
          );
        }

        return { user, roleCodes };
      });

      const primaryRole = isOwner ? "PITCH_OWNER" : "CLIENT";
      const token = body.autoVerifyDemo ? signToken(result.user, result.roleCodes) : undefined;

      return res.status(201).json({
        success: true,
        ...(token ? { token, accessToken: token, type: "Bearer", tokenType: "Bearer" } : {}),
        id: Number(result.user.user_id),
        username: result.user.full_name,
        email: result.user.email,
        role: primaryRole,
        roles: result.roleCodes,
        message: body.autoVerifyDemo
          ? "Đăng ký và kích hoạt tài khoản thành công"
          : "Đăng ký thành công. Vui lòng xác thực email trước khi đăng nhập.",
        data: {
          userId: Number(result.user.user_id),
          email: result.user.email,
          fullName: result.user.full_name,
          phone: result.user.phone,
          status: result.user.status,
          roles: result.roleCodes,
          ...(body.autoVerifyDemo ? {} : { demoVerificationToken: rawToken }),
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/v1/auth/verify-email?token=... (FR-01)
  router.get("/verify-email", async (req, res, next) => {
    try {
      const token = String(req.query.token || "").trim();
      if (!token) {
        throw new AppError(400, "MISSING_TOKEN", "Thiếu mã xác thực email");
      }
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `SELECT verification_id, user_id, expires_at, used_at
           FROM email_verification_tokens
           WHERE token_hash = $1`,
          [tokenHash]
        );
        if (rows.length === 0) {
          throw new AppError(400, "INVALID_TOKEN", "Mã xác thực không hợp lệ");
        }
        const rec = rows[0];
        if (rec.used_at || new Date(rec.expires_at) < new Date()) {
          throw new AppError(400, "EXPIRED_TOKEN", "Mã xác thực đã được sử dụng hoặc hết hạn");
        }

        await client.query(
          "UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE verification_id = $1",
          [rec.verification_id]
        );
        await client.query(
          `UPDATE users
           SET status = 'ACTIVE', email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $1`,
          [rec.user_id]
        );
      });

      return res.json({ success: true, message: "Xác thực email thành công. Bạn có thể đăng nhập." });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/auth/login (FR-02)
  router.post("/login", async (req, res, next) => {
    try {
      const body = loginSchema.parse(req.body);
      const rawIdentifier = (body.email || body.identifier || "").trim().toLowerCase();

      const { rows } = await pool.query(
        `SELECT u.user_id, u.full_name, u.email, u.phone, u.password_hash, u.status,
                COALESCE(array_agg(r.code::text) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.user_id
         LEFT JOIN roles r ON r.role_id = ur.role_id
         WHERE LOWER(u.email) = $1 OR u.phone = $2
         GROUP BY u.user_id`,
        [rawIdentifier, (body.email || body.identifier || "").trim()]
      );

      if (rows.length === 0) {
        throw new AppError(401, "INVALID_CREDENTIALS", "Email/SĐT hoặc mật khẩu không đúng");
      }
      const user = rows[0];
      const valid = user.password_hash ? await bcrypt.compare(body.password, user.password_hash) : false;
      if (!valid) {
        throw new AppError(401, "INVALID_CREDENTIALS", "Email/SĐT hoặc mật khẩu không đúng");
      }
      if (user.status !== "ACTIVE") {
        throw new AppError(403, "ACCOUNT_NOT_ACTIVE", "Tài khoản chưa kích hoạt email hoặc đã bị khóa");
      }

      if ((body.role === "ADMIN" || body.role === "PITCH_OWNER" || body.role === "OWNER") && !user.roles.includes("PITCH_OWNER")) {
        throw new AppError(403, "FORBIDDEN", "Tài khoản này không có quyền Chủ sân (PITCH_OWNER)");
      }

      const token = signToken(user, user.roles);
      const primaryRole = user.roles.includes("PITCH_OWNER") ? "PITCH_OWNER" : "CLIENT";
      return res.json({
        success: true,
        token,
        accessToken: token,
        type: "Bearer",
        tokenType: "Bearer",
        id: Number(user.user_id),
        username: user.full_name,
        email: user.email,
        phone: user.phone,
        role: primaryRole,
        roles: user.roles,
        user: {
          userId: Number(user.user_id),
          fullName: user.full_name,
          username: user.full_name,
          email: user.email,
          phone: user.phone,
          role: primaryRole,
          roles: user.roles,
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/auth/forgot-password & reset-password (FR-02)
  router.post("/forgot-password", async (req, res, next) => {
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      if (!email) throw new AppError(400, "VALIDATION_ERROR", "Vui lòng nhập email");
      const { rows } = await pool.query("SELECT user_id FROM users WHERE LOWER(email) = $1", [email]);
      if (rows.length === 0) {
        return res.json({ success: true, message: "Nếu email tồn tại, hướng dẫn đặt lại mật khẩu đã được tạo." });
      }
      const rawToken = crypto.randomBytes(20).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      await pool.query(
        `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
        [rows[0].user_id, tokenHash]
      );
      return res.json({
        success: true,
        message: "Đã tạo mã khôi phục mật khẩu (Demo).",
        demoResetToken: rawToken,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/reset-password", async (req, res, next) => {
    try {
      const token = String(req.body?.token || "").trim();
      const newPassword = String(req.body?.newPassword || req.body?.password || "");
      if (!token || newPassword.length < 6) {
        throw new AppError(400, "VALIDATION_ERROR", "Token hoặc mật khẩu mới (>= 6 ký tự) không hợp lệ");
      }
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const newHash = await bcrypt.hash(newPassword, 10);
      await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          "SELECT verification_id, user_id, expires_at, used_at FROM email_verification_tokens WHERE token_hash = $1",
          [tokenHash]
        );
        if (rows.length === 0 || rows[0].used_at || new Date(rows[0].expires_at) < new Date()) {
          throw new AppError(400, "INVALID_TOKEN", "Mã khôi phục không hợp lệ hoặc đã hết hạn");
        }
        await client.query("UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE verification_id = $1", [rows[0].verification_id]);
        await client.query("UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2", [newHash, rows[0].user_id]);
      });
      return res.json({ success: true, message: "Đặt lại mật khẩu thành công" });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/v1/auth/logout (FR-03)
  router.post("/logout", requireAuth, (_req, res) => {
    return res.json({ success: true, message: "Đăng xuất thành công" });
  });

  return router;
}

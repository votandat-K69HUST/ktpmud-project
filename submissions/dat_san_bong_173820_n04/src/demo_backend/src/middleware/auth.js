import jwt from "jsonwebtoken";
import { AppError } from "./errorHandler.js";

const JWT_SECRET = () => process.env.JWT_SECRET || "soccer-booker-demo-secret-key-2026";

export function signToken(user, roles) {
  return jwt.sign(
    {
      sub: String(user.user_id),
      userId: Number(user.user_id),
      email: user.email,
      fullName: user.full_name,
      roles,
    },
    JWT_SECRET(),
    { expiresIn: process.env.JWT_EXPIRES_IN || "24h" }
  );
}

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return next(new AppError(401, "UNAUTHORIZED", "Yêu cầu đăng nhập (thiếu Bearer token)"));
  }
  const token = header.slice(7).trim();
  try {
    const payload = jwt.verify(token, JWT_SECRET());
    req.user = {
      userId: Number(payload.userId ?? payload.sub),
      email: payload.email,
      fullName: payload.fullName,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
    };
    return next();
  } catch {
    return next(new AppError(401, "INVALID_TOKEN", "Phiên đăng nhập không hợp lệ hoặc đã hết hạn"));
  }
}

export function requireRole(roleCode) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError(401, "UNAUTHORIZED", "Yêu cầu đăng nhập"));
    }
    if (!req.user.roles.includes(roleCode)) {
      return next(
        new AppError(403, "FORBIDDEN", `Bạn không có quyền ${roleCode} để thực hiện thao tác này`)
      );
    }
    return next();
  };
}

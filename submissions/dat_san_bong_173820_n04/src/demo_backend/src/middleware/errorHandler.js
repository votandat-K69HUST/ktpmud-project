import { ZodError } from "zod";

export class AppError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      code: "VALIDATION_ERROR",
      message: "Dữ liệu đầu vào không hợp lệ",
      details: err.errors.map((e) => ({ path: e.path.join("."), message: e.message })),
    });
  }

  // PostgreSQL error codes
  if (err && err.code) {
    // 23505: unique_violation (e.g., uq_booking_reserved_slot, uq_users_email)
    // 23P01: exclusion_violation (btree_gist ex_time_slots_no_overlap)
    // 40001: serialization_failure (concurrent REPEATABLE READ / SERIALIZABLE conflict)
    if (err.code === "23505" || err.code === "23P01" || err.code === "40001") {
      return res.status(409).json({
        success: false,
        code: "CONFLICT",
        message: "Xung đột dữ liệu hoặc khung giờ đã có người đặt/chồng lấn",
      });
    }
    if (err.code === "23503" || err.code === "23514") {
      return res.status(400).json({
        success: false,
        code: "CONSTRAINT_VIOLATION",
        message: "Dữ liệu tham chiếu không tồn tại hoặc vi phạm ràng buộc hệ thống",
      });
    }
  }

  console.error("[UnhandledError]", err);
  return res.status(500).json({
    success: false,
    code: "INTERNAL_ERROR",
    message: err?.message || "Lỗi máy chủ nội bộ",
  });
}

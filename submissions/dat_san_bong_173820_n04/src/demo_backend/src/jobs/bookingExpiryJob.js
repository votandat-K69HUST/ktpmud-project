/**
 * Finds all PENDING / WAITING_FOR_DEPOSIT bookings past expires_at
 * and transitions them to EXPIRED, releasing the slot via partial unique index.
 * Runs as a single query when 0 rows expire to minimize Neon RTTs.
 */
export async function expireOverdueBookings(pool) {
  const { rows } = await pool.query(
    `UPDATE bookings
     SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
     WHERE status IN ('PENDING', 'WAITING_FOR_DEPOSIT')
       AND expires_at IS NOT NULL
       AND expires_at < CURRENT_TIMESTAMP
     RETURNING booking_id, status`
  );

  if (rows.length > 0) {
    const ids = rows.map((r) => r.booking_id);
    await pool.query(
      `INSERT INTO booking_status_history (booking_id, old_status, new_status, reason)
       SELECT id, 'WAITING_FOR_DEPOSIT', 'EXPIRED', 'Tự động hết hạn giữ chỗ sau 4 giờ'
       FROM UNNEST($1::bigint[]) AS id`,
      [ids]
    );
  }
  return rows.length;
}

export function startBookingExpiryScheduler(pool, intervalMs = 300_000) {
  const timer = setInterval(async () => {
    try {
      const expiredCount = await expireOverdueBookings(pool);
      if (expiredCount > 0) {
        console.log(`[BookingExpiryJob] Expired ${expiredCount} overdue booking(s).`);
      }
    } catch (err) {
      console.error("[BookingExpiryJob] Error:", err.message);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

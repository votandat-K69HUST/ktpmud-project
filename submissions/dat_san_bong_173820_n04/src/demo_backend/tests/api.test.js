import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { expireOverdueBookings } from "../src/jobs/bookingExpiryJob.js";

/**
 * Stateful in-memory PostgreSQL-compatible mock pool that enforces:
 * - UNIQUE(email), UNIQUE(phone)
 * - Partial Unique Index uq_booking_reserved_slot on (pitch_id, booking_date, time_slot_id)
 *   for active statuses ('PENDING','WAITING_FOR_DEPOSIT','CONFIRMED','COMPLETED','NO_SHOW')
 * - 4-hour deposit expiry & financial_entries recording
 */
function createMockPgPool() {
  const state = {
    seq: { users: 1, complexes: 1, pitches: 1, slots: 1, banks: 1, bookings: 1, reports: 1, fin: 1, reviews: 1, comments: 1 },
    users: [],
    roles: [
      { role_id: 1, code: "CLIENT" },
      { role_id: 2, code: "PITCH_OWNER" },
    ],
    userRoles: [],
    verifTokens: [],
    ownerProfiles: [],
    complexes: [],
    pitches: [],
    timeSlots: [
      { time_slot_id: 1, slot_name: "Ca Vàng 1 (17:30 - 19:00)", start_time: "17:30:00", end_time: "19:00:00" },
    ],
    weeklySlots: [],
    slotBlocks: [],
    bankAccounts: [],
    bookings: [],
    depositReports: [],
    financialEntries: [],
    reviews: [],
    comments: [],
  };

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s === "SELECT 1") return { rows: [{ "?column?": 1 }], rowCount: 1 };
    if (s.startsWith("BEGIN") || s === "COMMIT" || s === "ROLLBACK") return { rows: [], rowCount: 0 };

    // Auth & Users
    if (s.includes("SELECT user_id FROM users WHERE LOWER(email)")) {
      const found = state.users.filter((u) => u.email.toLowerCase() === params[0] || u.phone === params[1]);
      return { rows: found, rowCount: found.length };
    }
    if (s.startsWith("INSERT INTO users")) {
      const u = {
        user_id: state.seq.users++,
        full_name: params[0],
        email: params[1],
        phone: params[2],
        password_hash: params[3],
        status: params[4],
        email_verified_at: params[5],
        created_at: new Date(),
      };
      state.users.push(u);
      return { rows: [u], rowCount: 1 };
    }
    if (s.startsWith("INSERT INTO user_roles")) {
      const [uid, codes] = params;
      for (const c of codes) {
        const role = state.roles.find((r) => r.code === c);
        if (role) state.userRoles.push({ user_id: uid, role_id: role.role_id });
      }
      return { rows: [], rowCount: codes.length };
    }
    if (s.startsWith("INSERT INTO pitch_owner_profiles")) {
      state.ownerProfiles.push({ user_id: params[0], display_name: params[1] });
      return { rows: [{ user_id: params[0], display_name: params[1] }], rowCount: 1 };
    }
    if (s.startsWith("INSERT INTO email_verification_tokens")) {
      state.verifTokens.push({
        verification_id: state.verifTokens.length + 1,
        user_id: params[0],
        token_hash: params[1],
        expires_at: new Date(Date.now() + 86400000),
        used_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("FROM email_verification_tokens WHERE token_hash")) {
      const found = state.verifTokens.filter((t) => t.token_hash === params[0]);
      return { rows: found, rowCount: found.length };
    }
    if (s.startsWith("UPDATE email_verification_tokens SET used_at")) {
      const t = state.verifTokens.find((x) => x.verification_id === params[0]);
      if (t) t.used_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE users SET status = 'ACTIVE'")) {
      const u = state.users.find((x) => x.user_id === params[0]);
      if (u) u.status = "ACTIVE";
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("FROM users u LEFT JOIN user_roles")) {
      const key = params[0];
      const u = typeof key === "number"
        ? state.users.find((x) => x.user_id === key)
        : state.users.find((x) => x.email.toLowerCase() === String(key).toLowerCase());
      if (!u) return { rows: [], rowCount: 0 };
      const roles = state.userRoles
        .filter((ur) => ur.user_id === u.user_id)
        .map((ur) => state.roles.find((r) => r.role_id === ur.role_id).code);
      return { rows: [{ ...u, roles }], rowCount: 1 };
    }

    // Pitches & Complexes
    if (s.startsWith("INSERT INTO pitch_complexes")) {
      const c = {
        complex_id: state.seq.complexes++,
        owner_user_id: params[0],
        complex_name: params[1],
        address_line: params[2],
        district: params[3],
        province: params[4],
        latitude: params[5],
        longitude: params[6],
        status: "ACTIVE",
      };
      state.complexes.push(c);
      return { rows: [c], rowCount: 1 };
    }
    if (s.startsWith("INSERT INTO pitches")) {
      const p = {
        pitch_id: state.seq.pitches++,
        complex_id: params[0],
        pitch_name: params[1],
        pitch_type: params[2],
        surface_type: params[3],
        description: params[4],
        deposit_amount: params[5],
        status: "ACTIVE",
      };
      state.pitches.push(p);
      return { rows: [p], rowCount: 1 };
    }
    if (s.includes("SELECT p.pitch_id, pc.owner_user_id, p.status FROM pitches")) {
      const p = state.pitches.find((x) => x.pitch_id === params[0]);
      if (!p) return { rows: [], rowCount: 0 };
      const c = state.complexes.find((x) => x.complex_id === p.complex_id);
      return { rows: [{ pitch_id: p.pitch_id, owner_user_id: c.owner_user_id, status: p.status }], rowCount: 1 };
    }
    if (s.startsWith("INSERT INTO pitch_weekly_slots")) {
      const [pitchId, dow, slotId, price, isActive] = params;
      let ws = state.weeklySlots.find((x) => x.pitch_id === pitchId && x.day_of_week === dow && x.time_slot_id === slotId);
      if (!ws) {
        ws = { pitch_id: pitchId, day_of_week: dow, time_slot_id: slotId, price, is_active: isActive };
        state.weeklySlots.push(ws);
      } else {
        ws.price = price;
        ws.is_active = isActive;
      }
      return { rows: [ws], rowCount: 1 };
    }
    if (s.startsWith("INSERT INTO pitch_slot_blocks")) {
      const [pitchId, blockDate, slotId, reason, createdBy] = params;
      const blk = { slot_block_id: state.slotBlocks.length + 1, pitch_id: pitchId, block_date: blockDate, time_slot_id: slotId, reason, created_by: createdBy };
      state.slotBlocks.push(blk);
      return { rows: [blk], rowCount: 1 };
    }
    if (s.startsWith("INSERT INTO owner_bank_accounts")) {
      const ba = {
        bank_account_id: state.seq.banks++,
        owner_user_id: params[0],
        bank_name: params[1],
        account_number: params[2],
        account_holder: params[3],
        transfer_instruction: params[5],
        is_default: params[6],
        is_active: true,
      };
      state.bankAccounts.push(ba);
      return { rows: [ba], rowCount: 1 };
    }

    // Booking flow
    if (s.includes("SELECT p.pitch_id, p.status, p.deposit_amount, pc.owner_user_id FROM pitches")) {
      const p = state.pitches.find((x) => x.pitch_id === params[0]);
      if (!p) return { rows: [], rowCount: 0 };
      const c = state.complexes.find((x) => x.complex_id === p.complex_id);
      return { rows: [{ ...p, owner_user_id: c.owner_user_id }], rowCount: 1 };
    }
    if (s.includes("SELECT price, is_active FROM pitch_weekly_slots")) {
      const ws = state.weeklySlots.find((x) => x.pitch_id === params[0] && x.day_of_week === params[1] && x.time_slot_id === params[2]);
      return { rows: ws ? [ws] : [], rowCount: ws ? 1 : 0 };
    }
    if (s.includes("SELECT slot_block_id FROM pitch_slot_blocks")) {
      const blk = state.slotBlocks.find((x) => x.pitch_id === params[0] && x.block_date === params[1] && x.time_slot_id === params[2]);
      return { rows: blk ? [blk] : [], rowCount: blk ? 1 : 0 };
    }
    if (s.includes("FROM owner_bank_accounts WHERE owner_user_id")) {
      const ba = state.bankAccounts.find((x) => x.owner_user_id === params[0]);
      return { rows: ba ? [ba] : [], rowCount: ba ? 1 : 0 };
    }
    if (s.startsWith("INSERT INTO bookings")) {
      const activeStatuses = ["PENDING", "WAITING_FOR_DEPOSIT", "CONFIRMED", "COMPLETED", "NO_SHOW"];
      const conflict = state.bookings.find(
        (b) => b.pitch_id === params[2] && b.booking_date === params[3] && b.time_slot_id === params[4] && activeStatuses.includes(b.status)
      );
      if (conflict) {
        const err = new Error("duplicate key value violates unique constraint uq_booking_reserved_slot");
        err.code = "23505";
        throw err;
      }
      const b = {
        booking_id: state.seq.bookings++,
        booking_code: params[0],
        client_user_id: params[1],
        pitch_id: params[2],
        booking_date: params[3],
        time_slot_id: params[4],
        status: "WAITING_FOR_DEPOSIT",
        pitch_price: params[5],
        deposit_amount: params[6],
        expires_at: new Date(Date.now() + 4 * 3600 * 1000),
      };
      state.bookings.push(b);
      return { rows: [b], rowCount: 1 };
    }
    if (s.startsWith("INSERT INTO booking_status_history")) {
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("SELECT booking_id, client_user_id, status FROM bookings")) {
      const b = state.bookings.find((x) => x.booking_id === params[0]);
      return { rows: b ? [b] : [], rowCount: b ? 1 : 0 };
    }
    if (s.includes("SELECT b.*, pc.owner_user_id FROM bookings b")) {
      const b = state.bookings.find((x) => x.booking_id === params[0]);
      if (!b) return { rows: [], rowCount: 0 };
      const p = state.pitches.find((x) => x.pitch_id === b.pitch_id);
      const c = state.complexes.find((x) => x.complex_id === p.complex_id);
      return { rows: [{ ...b, owner_user_id: c.owner_user_id }], rowCount: 1 };
    }
    if (s.startsWith("INSERT INTO booking_deposit_reports")) {
      const r = { deposit_report_id: state.seq.reports++, booking_id: params[0], reported_by: params[1], reported_amount: params[2], status: "REPORTED" };
      state.depositReports.push(r);
      return { rows: [r], rowCount: 1 };
    }
    if (s.startsWith("UPDATE bookings SET status = 'CONFIRMED'")) {
      const b = state.bookings.find((x) => x.booking_id === params[1]);
      b.status = "CONFIRMED";
      return { rows: [b], rowCount: 1 };
    }
    if (s.startsWith("UPDATE booking_deposit_reports")) {
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("INSERT INTO financial_entries")) {
      const fe = { financial_entry_id: state.seq.fin++, owner_user_id: params[0], booking_id: params[1], entry_type: "RECEIVED", amount: params[2], status: "RECORDED" };
      state.financialEntries.push(fe);
      return { rows: [fe], rowCount: 1 };
    }
    if (s.startsWith("UPDATE bookings SET status = 'COMPLETED'")) {
      const b = state.bookings.find((x) => x.booking_id === params[0]);
      b.status = "COMPLETED";
      return { rows: [b], rowCount: 1 };
    }
    if (s.startsWith("UPDATE bookings SET status = 'EXPIRED'")) {
      const now = new Date();
      const expired = state.bookings.filter((b) => ["PENDING", "WAITING_FOR_DEPOSIT"].includes(b.status) && b.expires_at && b.expires_at < now);
      for (const b of expired) b.status = "EXPIRED";
      return { rows: expired, rowCount: expired.length };
    }
    if (s.includes("FROM financial_entries WHERE owner_user_id")) {
      const entries = state.financialEntries.filter((e) => e.owner_user_id === params[0] && e.status === "RECORDED");
      const total = entries.reduce((acc, e) => acc + Number(e.amount), 0);
      return { rows: [{ total_received: total, total_refund: 0, total_outstanding: 0 }], rowCount: 1 };
    }
    if (s.includes("COUNT(*) FILTER")) {
      return { rows: [{ confirmed_bookings: 1, pending_deposit_bookings: 0, expired_bookings: 0 }], rowCount: 1 };
    }
    if (s.includes("SELECT booking_id, client_user_id, pitch_id, status FROM bookings")) {
      const b = state.bookings.find((x) => x.booking_id === params[0]);
      return { rows: b ? [b] : [], rowCount: b ? 1 : 0 };
    }
    if (s.startsWith("INSERT INTO reviews")) {
      const rv = { review_id: state.seq.reviews++, booking_id: params[0], pitch_id: params[1], client_user_id: params[2], rating: params[3], content: params[4] };
      state.reviews.push(rv);
      return { rows: [rv], rowCount: 1 };
    }
    if (s.startsWith("INSERT INTO comments")) {
      const cm = { comment_id: state.seq.comments++, author_user_id: params[0], target_type: params[1], target_id: params[2], content: params[3] };
      state.comments.push(cm);
      return { rows: [cm], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    state,
    query,
    connect: async () => ({ query, release: () => {} }),
  };
}

describe("Soccer Booker Demo API (Branches 1, 2, 4) - Acceptance Tests", () => {
  let pool;
  let app;
  let ownerToken;
  let clientToken;
  let pitchId;

  beforeEach(async () => {
    pool = createMockPgPool();
    app = createApp(pool);

    // Register & verify Owner
    await request(app).post("/api/v1/auth/register").send({
      fullName: "Chủ sân Test",
      email: "owner@test.vn",
      phone: "0911111111",
      password: "Password123",
      asPitchOwner: true,
      autoVerifyDemo: true,
    });
    const loginOwner = await request(app).post("/api/v1/auth/login").send({
      email: "owner@test.vn",
      password: "Password123",
    });
    ownerToken = loginOwner.body.accessToken;

    // Register & verify Client via email token
    const regClient = await request(app).post("/api/v1/auth/register").send({
      fullName: "Khách Test",
      email: "client@test.vn",
      phone: "0922222222",
      password: "Password123",
      asPitchOwner: false,
      autoVerifyDemo: false,
    });
    const verifyRes = await request(app).get(`/api/v1/auth/verify-email?token=${regClient.body.data.demoVerificationToken}`);
    expect(verifyRes.status).toBe(200);

    const loginClient = await request(app).post("/api/v1/auth/login").send({
      email: "client@test.vn",
      password: "Password123",
    });
    clientToken = loginClient.body.accessToken;

    // Owner creates pitch & weekly slot (2026-12-01 is Tuesday = ISO day 2)
    const pRes = await request(app)
      .post("/api/v1/owner/pitches")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        complexName: "Sân Bách Khoa",
        addressLine: "Số 1 Đại Cồ Việt",
        pitchName: "Sân 7A",
        pitchType: "7v7",
        depositAmount: 200000,
      });
    expect(pRes.status).toBe(201);
    pitchId = pRes.body.data.pitch_id;

    await request(app)
      .put(`/api/v1/owner/pitches/${pitchId}/weekly-slots`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        slots: [{ dayOfWeek: 2, timeSlotId: 1, price: 650000, isActive: true }],
      });
  });

  it("TC-AUTH & RBAC: CLIENT cannot access /api/v1/owner/* (403 Forbidden)", async () => {
    const res = await request(app)
      .post("/api/v1/owner/pitches")
      .set("Authorization", `Bearer ${clientToken}`)
      .send({ complexName: "Fake", addressLine: "Fake", pitchName: "Fake", pitchType: "5v5" });
    expect(res.status).toBe(403);
  });

  it("TC-BOOK-03: 10 concurrent booking requests on same slot -> exactly 1 succeeds (201), 9 fail (409)", async () => {
    const reqs = Array.from({ length: 10 }, () =>
      request(app)
        .post("/api/v1/bookings")
        .set("Authorization", `Bearer ${clientToken}`)
        .send({ pitchId, bookingDate: "2026-12-01", timeSlotId: 1 })
    );
    const results = await Promise.all(reqs);
    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
  });

  it("TC-BOOK-05 & TC-REV-01 & TC-COMM-01: Full E2E Booking -> Deposit -> Confirm -> Revenue -> Complete -> Review", async () => {
    const bRes = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${clientToken}`)
      .send({ pitchId, bookingDate: "2026-12-01", timeSlotId: 1 });
    expect(bRes.status).toBe(201);
    const bookingId = bRes.body.data.booking_id;

    // Client reports deposit
    const repRes = await request(app)
      .post(`/api/v1/bookings/${bookingId}/deposit-reports`)
      .set("Authorization", `Bearer ${clientToken}`)
      .send({ reportedAmount: 200000, clientMessage: "Đã CK MB Bank" });
    expect(repRes.status).toBe(201);

    // Owner confirms deposit -> financial_entries RECEIVED
    const confRes = await request(app)
      .post(`/api/v1/owner/bookings/${bookingId}/confirm-deposit`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ note: "Đã nhận 200k" });
    expect(confRes.status).toBe(200);
    expect(confRes.body.data.status).toBe("CONFIRMED");

    // Check owner revenue summary
    const revRes = await request(app)
      .get("/api/v1/owner/revenue/summary")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(revRes.status).toBe(200);
    expect(revRes.body.data.totalReceived).toBe(200000);

    // Review before COMPLETED -> 400
    const badRev = await request(app)
      .post(`/api/v1/bookings/${bookingId}/review`)
      .set("Authorization", `Bearer ${clientToken}`)
      .send({ rating: 5, content: "Rất tốt" });
    expect(badRev.status).toBe(400);

    // Owner completes -> Client reviews 5 stars
    await request(app)
      .post(`/api/v1/owner/bookings/${bookingId}/complete`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const okRev = await request(app)
      .post(`/api/v1/bookings/${bookingId}/review`)
      .set("Authorization", `Bearer ${clientToken}`)
      .send({ rating: 5, content: "Mặt cỏ đẹp!" });
    expect(okRev.status).toBe(201);
  });

  it("TC-BOOK-06: Expired booking (> 4 hours) is auto-expired by scheduler and slot becomes available again", async () => {
    const bRes = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${clientToken}`)
      .send({ pitchId, bookingDate: "2026-12-01", timeSlotId: 1 });
    expect(bRes.status).toBe(201);

    // Fast-forward expires_at to 1 minute in the past
    pool.state.bookings[0].expires_at = new Date(Date.now() - 60_000);

    const expiredCount = await expireOverdueBookings(pool);
    expect(expiredCount).toBe(1);
    expect(pool.state.bookings[0].status).toBe("EXPIRED");

    // Slot can now be booked again
    const bRes2 = await request(app)
      .post("/api/v1/bookings")
      .set("Authorization", `Bearer ${clientToken}`)
      .send({ pitchId, bookingDate: "2026-12-01", timeSlotId: 1 });
    expect(bRes2.status).toBe(201);
  });
});

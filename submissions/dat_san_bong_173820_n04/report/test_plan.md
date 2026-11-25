# KẾ HOẠCH KIỂM THỬ VÀ NGHIỆM THU BẢN DEMO (TEST PLAN)
## Dự án: Soccer Booker – Phạm vi MVP: Nhánh 1 (Tài khoản), Nhánh 2 (Đặt sân & Cọc), Nhánh 4 (Quản lý sân)

**Mục tiêu:** Bảo đảm mọi yêu cầu chức năng (FR) và phi chức năng (NFR) trong phạm vi bản Demo đều được định lượng rõ ràng, có kịch bản kiểm thử cụ thể (Input → Action → Expected Output) và đạt tiêu chuẩn nghiệm thu 100% trước khi demo trên lớp.

---

## 1. PHẠM VI VÀ CHIẾN LƯỢC KIỂM THỬ

### 1.1. Phạm vi kiểm thử
* **Trong phạm vi:** Toàn bộ API và giao diện thuộc Nhánh 1 (Auth & Users), Nhánh 2 (Search, Booking, Deposit 4h, Cancel/Complete/No-Show, Reviews, Comments), Nhánh 4 (Pitch Management, Weekly Slots, Slot Blocks, Bank Accounts, Revenue Summary).
* **Ngoài phạm vi:** Nhánh 3 (Quản lý giải đấu – tạm chưa phát triển).

### 1.2. Các cấp độ kiểm thử
1. **Unit & Service Tests (JUnit 5 + Mockito):** Kiểm tra logic tính tiền cọc, quy tắc chuyển trạng thái booking, kiểm tra quyền sở hữu tài nguyên.
2. **Integration & Concurrency Tests (Spring Boot Test + PostgreSQL thật):** Kiểm tra migration Flyway, Partial Unique Index, xung đột đặt sân đa luồng (`ExecutorService` + `CountDownLatch`), và Scheduled Job hết hạn 4 giờ.
3. **API Contract Tests (MockMvc / REST Assured):** Kiểm tra mã HTTP (`200`, `201`, `400`, `401`, `403`, `404`, `409`) và cấu trúc JSON.
4. **Frontend Unit & E2E Flow Tests (Vitest + Testing Library / Manual Walkthrough):** Kiểm tra validate form (Zod), luồng người dùng Client & Pitch Owner.

---

## 2. TIÊU CHÍ NGHIỆM THU ĐỊNH LƯỢNG (ACCEPTANCE CRITERIA)

| Mã tiêu chí | Hạng mục | Tiêu chí đo lường cụ thể | Ngưỡng đạt |
|:---:|---|---|---|
| **AC-01** | **Đúng đắn nghiệp vụ** | Tỷ lệ pass các test case chức năng Nhánh 1, 2, 4 | **100%** test cases mức High/Critical đạt |
| **AC-02** | **Chống đặt trùng lịch** | 10 luồng đồng thời đặt cùng 1 `(pitch_id, date, slot_id)` | Duy nhất **1** request `201 Created`, **9** request `409 Conflict` |
| **AC-03** | **Tự động hủy giữ chỗ 4h** | Booking `WAITING_FOR_DEPOSIT` quá `deposit_deadline_at` | Job chuyển sang `EXPIRED` và slot trở lại `AVAILABLE` |
| **AC-04** | **Bảo mật & Phân quyền** | Truy cập endpoint `/owner/**` bằng token `CLIENT` | Trả về **403 Forbidden** 100% trường hợp |
| **AC-05** | **Hiệu năng API** | Thời gian phản hồi trung bình của `GET /pitches`, `POST /bookings` | **< 1.0 giây** ở môi trường local |
| **AC-06** | **Chất lượng mã (SQA)** | Độ phủ mã nguồn tầng Service (JaCoCo) & Vitest Frontend | **>= 80%** cho các module Nhánh 1, 2, 4 |

---

## 3. BỘ CA KIỂM THỬ CHI TIẾT (TEST CASES)

### 3.1. Nhánh 1 – Quản lý tài khoản & Xác thực
| ID | Tên Test Case | Điều kiện tiên quyết | Đầu vào & Thao tác | Kết quả mong đợi (Có thể kiểm chứng) |
|---|---|---|---|---|
| **TC-AUTH-01** | Đăng ký tài khoản `CLIENT` thành công | Email & SĐT chưa tồn tại | `POST /auth/register` với `fullName`, `email`, `phone`, `password` (>=8 ký tự) | HTTP `201`; DB tạo `users` (`status=PENDING_VERIFICATION`), gán role `CLIENT`; MailHog nhận được 1 email chứa link verify. |
| **TC-AUTH-02** | Đăng ký trùng Email / SĐT | Email `a@test.vn` đã tồn tại | `POST /auth/register` với `email="a@test.vn"` | HTTP `409 Conflict`; thông báo lỗi rõ ràng; không tạo bản ghi mới. |
| **TC-AUTH-03** | Xác thực Email & Đăng nhập JWT | User ở trạng thái `PENDING_VERIFICATION` | 1) Thử `POST /auth/login` → 2) Gọi `GET /auth/verify-email?token=...` → 3) Gọi lại `POST /auth/login` | Bước 1: HTTP `403` (chưa kích hoạt). Bước 2: `users.status = ACTIVE`. Bước 3: HTTP `200`, trả về JWT token hợp lệ chứa role `CLIENT`. |
| **TC-AUTH-04** | Quên & Đặt lại mật khẩu | User `ACTIVE` | `POST /auth/password/forgot` → lấy token từ MailHog → `POST /auth/password/reset` với `newPassword` | Đăng nhập bằng mật khẩu cũ bị `401`; đăng nhập bằng mật khẩu mới thành công (`200`). |
| **TC-AUTH-05** | Cập nhật hồ sơ cá nhân & Chủ sân | Đã đăng nhập | `PATCH /users/me` (đổi SĐT); `PUT /owner/profile` (bằng token `CLIENT` vs `PITCH_OWNER`) | `CLIENT` sửa `/users/me` thành công (`200`), gọi `/owner/profile` bị `403`. `PITCH_OWNER` sửa `/owner/profile` thành công (`200`). |

### 3.2. Nhánh 4 – Quản lý sân bóng & Thống kê Chủ sân
| ID | Tên Test Case | Điều kiện tiên quyết | Đầu vào & Thao tác | Kết quả mong đợi (Có thể kiểm chứng) |
|---|---|---|---|---|
| **TC-PITCH-01** | Tạo cụm sân & sân con mới | Đăng nhập `PITCH_OWNER` | `POST /owner/pitches` với tên cụm sân, địa chỉ, tọa độ `(21.0285, 105.8542)`, loại sân `7v7` | HTTP `201`; DB có bản ghi `pitch_complexes` và `pitches` (`status=ACTIVE`); tìm kiếm công khai `GET /pitches` hiển thị sân mới. |
| **TC-PITCH-02** | Cấu hình khung giờ & giá tuần | Có `pitch_id` thuộc Owner | `PUT /owner/pitches/{id}/weekly-slots` với 2 khung giờ: `17:00-18:30` (500k), `18:30-20:00` (600k) | HTTP `200`; `GET /pitches/{id}/slots?date=...` hiển thị đúng 2 khung giờ và giá tương ứng. |
| **TC-PITCH-03** | Chặn cấu hình khung giờ chồng lấn | Đã có slot `17:00-18:30` | Thêm slot `18:00-19:30` cùng ngày trong tuần | HTTP `400/409` (bị ràng buộc `btree_gist` / validation từ chối); dữ liệu không bị sai lệch. |
| **TC-PITCH-04** | Khóa khung giờ đột xuất (`Slot Block`) | Sân đang `ACTIVE` | `PUT /owner/pitches/{id}/slot-blocks` khóa slot `18:30-20:00` ngày `2026-12-01` lý do "Bảo trì đèn" | HTTP `200`; Client xem lịch ngày `2026-12-01` thấy slot `18:30-20:00` có trạng thái `BLOCKED`, không thể đặt. |
| **TC-PITCH-05** | Ngừng hoạt động sân (`Deactivate`) | Sân thuộc Owner | `POST /owner/pitches/{id}/deactivate` | HTTP `200`; `pitches.status = INACTIVE`; sân ẩn khỏi kết quả tìm kiếm mới nhưng booking cũ vẫn tra cứu được. |
| **TC-PITCH-06** | Chủ sân B sửa sân của Chủ sân A | Có 2 Owner A và B | Owner B gọi `PATCH /owner/pitches/{pitchA_id}` | HTTP `403 Forbidden`; dữ liệu sân A không thay đổi. |
| **TC-REV-01** | Thống kê doanh thu chủ sân | Đã có ít nhất 1 booking `CONFIRMED` | `GET /owner/revenue/summary?from=...&to=...` | HTTP `200`; tổng tiền `RECEIVED` khớp chính xác tổng các bút toán trong `financial_entries` (chỉ tính `RECORDED`, bỏ qua `VOIDED`). |

### 3.3. Nhánh 2 – Tìm sân, Đặt sân 4h, Cọc, Đánh giá & Bình luận
| ID | Tên Test Case | Điều kiện tiên quyết | Đầu vào & Thao tác | Kết quả mong đợi (Có thể kiểm chứng) |
|---|---|---|---|---|
| **TC-BOOK-01** | Tìm sân theo GPS & Bộ lọc | Có 3 cụm sân với tọa độ khác nhau | `GET /pitches?lat=21.005&lng=105.843&radiusKm=5&pitchType=7v7` | HTTP `200`; chỉ trả về các sân `ACTIVE` loại `7v7` nằm trong bán kính 5 km, sắp xếp theo khoảng cách tăng dần. |
| **TC-BOOK-02** | Tạo Booking & giữ chỗ 4 giờ | Slot ngày mai đang `AVAILABLE` | `CLIENT` gọi `POST /bookings` (`pitchId`, `bookingDate`, `timeSlotId`) | HTTP `201`; trả về `bookingCode`; `status=WAITING_FOR_DEPOSIT` (hoặc `PENDING`), `depositDeadlineAt = now + 4h`; slot chuyển sang `BOOKED`. |
| **TC-BOOK-03** | **Kiểm thử Race Condition (Đặt trùng)** | 1 slot đang `AVAILABLE` | Dùng 10 thread đồng thời gọi `POST /bookings` vào cùng 1 `(pitchId, date, timeSlotId)` | Đúng **1** thread nhận HTTP `201`; **9** thread còn lại nhận HTTP `409 Conflict`; DB chỉ có 1 dòng active booking cho slot đó. |
| **TC-BOOK-04** | Chặn đặt vào slot đã bị khóa (`BLOCKED`) | Slot có bản ghi `pitch_slot_blocks` | `CLIENT` gọi `POST /bookings` vào slot đang bị khóa | HTTP `409 Conflict` hoặc `400 Bad Request`; không tạo được booking. |
| **TC-BOOK-05** | Báo chuyển khoản & Chủ sân xác nhận cọc | Booking đang `WAITING_FOR_DEPOSIT` | 1) Client gọi `POST /bookings/{id}/deposit-reports` → 2) Owner gọi `POST /owner/bookings/{id}/confirm-deposit` | Bước 1: `deposit_reports.status = REPORTED`. Bước 2: `bookings.status = CONFIRMED`; `financial_entries` tự động thêm 1 dòng `RECEIVED` đúng số tiền cọc. |
| **TC-BOOK-06** | **Tự động hết hạn sau 4 giờ** | Booking `WAITING_FOR_DEPOSIT` có `deposit_deadline_at` lùi về quá khứ 1 phút | Kích hoạt / chờ Scheduler chạy | `bookings.status` chuyển thành `EXPIRED`; gọi lại `POST /bookings` cho chính slot đó bởi Client khác thành công (`201`). |
| **TC-BOOK-07** | Client hủy booking vs Owner hoàn thành | Có 2 booking hợp lệ | Client gọi `POST /bookings/{id}/cancel`; Owner gọi `POST /owner/bookings/{id2}/complete` | Booking 1 chuyển `CANCELLED` và giải phóng slot; Booking 2 chuyển `COMPLETED`. |
| **TC-COMM-01** | Đánh giá sân 1–5 sao sau khi đá | Booking 1 (`COMPLETED`), Booking 2 (`WAITING_FOR_DEPOSIT`) | Client gọi `POST /bookings/{id}/review` (`rating=5`, `comment="Mặt cỏ đẹp"`) cho cả 2 booking | Booking 1: HTTP `201`, lưu `reviews` và cập nhật điểm TB sân. Booking 2: HTTP `400/403` (chưa hoàn thành không được đánh giá). |
| **TC-COMM-02** | Bình luận đa hình trên trang sân | Đã đăng nhập | `POST /comments` (`targetType="PITCH"`, `targetId=pitchId`, `content="Sân có chỗ gửi xe không?"`) → `GET /pitches/{id}/comments` | HTTP `201` khi tạo; `GET` trả về đúng bình luận kèm tên tác giả và thời gian. |

---

## 4. QUY TRÌNH THỰC THI & BÁO CÁO NGHIỆM THU

1. **Chuẩn bị môi trường:** Khởi chạy `docker compose up -d` (PostgreSQL 15 + MailHog) → chạy Flyway migration & seed data.
2. **Chạy kiểm thử tự động:**
   * Backend: `mvnw.cmd test` (bao gồm cả Integration Test đa luồng và Scheduler).
   * Frontend: `npm test` (Vitest) và `npm run build` (TypeScript check).
3. **Kịch bản Demo trực tiếp (E2E Walkthrough):**
   * Chủ sân đăng nhập → tạo sân con + cấu hình khung giờ tuần + tài khoản ngân hàng.
   * Khách hàng đăng ký (xác thực qua MailHog) → tìm sân trên bản đồ GPS → đặt sân thấy bộ đếm ngược 4 giờ → gửi thông tin chuyển khoản.
   * Chủ sân nhận đơn → xác nhận tiền cọc → kiểm tra bảng Doanh thu tăng lên đúng số tiền cọc.
   * Hoàn thành lượt đặt → Khách hàng gửi đánh giá 5 sao và bình luận.
4. **Điều kiện bàn giao:** 100% test cases trong bảng trên đạt trạng thái **PASS** và không còn lỗi mức Critical/Major.

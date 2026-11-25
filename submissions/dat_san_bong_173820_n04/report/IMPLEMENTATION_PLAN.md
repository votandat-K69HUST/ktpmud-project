# KẾ HOẠCH CHI TIẾT XÂY DỰNG BẢN DEMO HỆ THỐNG SOCCER BOOKER
**Phạm vi:** Nhánh 1 (Tài khoản), Nhánh 2 (Đặt sân, Giữ chỗ 4h, Cọc & Cộng đồng), Nhánh 4 (Quản lý sân & Doanh thu) — *Tạm hoãn Nhánh 3 (Giải đấu)*  
**Môi trường thực thi thực tế:** Node.js `v20.20.2` + React/Vite + **Cloud PostgreSQL (Neon / Supabase)**

---

## 1. KIẾN TRÚC TRIỂN KHAI TỐI ƯU CHO MÁY HIỆN TẠI

Qua kiểm tra thực tế, máy hiện có sẵn **Node.js v20.20.2**, **npm 10.8.2**, **Python 3.14.6**, nhưng chưa cài đặt Java JDK, Docker Desktop hay PostgreSQL local. Do đó, kế hoạch triển khai được thiết kế để **chạy ngay lập tức** mà vẫn bảo đảm **100% Database PostgreSQL thật (`btree_gist`)**:

1. **Database (Cloud PostgreSQL – Neon.tech / Supabase):**
   - Dùng trực tiếp 2 file SQL đã thiết kế tại `submission/database/V1__soccer_booker_demo_schema.sql` và `V2__seed_demo_data.sql`.
   - Có sẵn giao diện Web Table Editor để giảng viên kiểm tra dữ liệu thật khi demo.
2. **Backend API (`demo_backend/` – Node.js + Express + `pg` + `jsonwebtoken` + `bcryptjs`):**
   - Tạo thư mục `demo_backend/` riêng (giữ nguyên thư mục `backend/` Java cũ làm tham chiếu).
   - Chạy tại `http://localhost:8080/api/v1`, kết nối trực tiếp tới Cloud PostgreSQL qua biến môi trường `DATABASE_URL`.
   - Thực thi đầy đủ Transaction `REPEATABLE READ`, bắt lỗi Partial Unique Index `uq_booking_reserved_slot` (`23505` → HTTP `409 Conflict`), và Scheduler tự động hết hạn đơn giữ chỗ 4 giờ.
3. **Frontend Web (`frontend/` – React 19 + TypeScript + Vite + Tailwind + Leaflet):**
   - Kế thừa giao diện và thư viện đã cài sẵn trong `frontend/`.
   - Điều chỉnh API client & các trang cho khớp hoàn toàn với API của Nhánh 1, 2, 4; tạm ẩn menu **Giải đấu (Nhánh 3)** trên thanh điều hướng.

---

## 2. LỘ TRÌNH THỰC HIỆN CHI TIẾT (4 GIAI ĐOẠN)

### Giai đoạn 1: Khởi tạo Cloud PostgreSQL & Kết nối Backend Skeleton
* **1.1. Thiết lập Cloud DB (User thực hiện 2 phút):** Tạo project trên Neon/Supabase, chạy `V1__soccer_booker_demo_schema.sql` + `V2__seed_demo_data.sql`, cung cấp `DATABASE_URL`.
* **1.2. Dựng khung `demo_backend/`:**
  - Khởi tạo `package.json` (`express`, `pg`, `cors`, `dotenv`, `bcryptjs`, `jsonwebtoken`, `zod`, `vitest`, `supertest`).
  - Cấu hình `db.js` (Connection Pool kết nối SSL tới Neon/Supabase), `middleware/auth.js` (xác thực JWT & kiểm tra role `CLIENT` / `PITCH_OWNER`), `middleware/errorHandler.js` (chuẩn hóa JSON error `400/401/403/404/409`).
  - Cài đặt Background Job (`jobs/bookingExpiryJob.js`) chạy mỗi 60 giây chuyển các booking `PENDING` / `WAITING_FOR_DEPOSIT` quá `expires_at` (4 giờ) sang `EXPIRED`.

### Giai đoạn 2: Hiện thực Backend API theo 3 Nhánh (1, 2, 4)
* **2.1. Nhánh 1 – Quản lý tài khoản & Xác thực (`/api/v1/auth/*`, `/api/v1/users/*`, `/api/v1/owner/profile`):**
  - `POST /auth/register`: Validate input (Zod), check trùng email/phone (`409`), hash mật khẩu BCrypt, gán role `CLIENT` (tùy chọn `PITCH_OWNER`), tạo verification token (trả thêm link verify trong log/dev response để demo nhanh không cần MailHog).
  - `GET /auth/verify-email`: Kích hoạt tài khoản (`ACTIVE`).
  - `POST /auth/login` & `POST /auth/google` (hỗ trợ demo login): Trả JWT chứa `userId`, `roles`, thông tin user.
  - `GET/PATCH /users/me`, `PUT /owner/profile`.
* **2.2. Nhánh 4 – Quản lý sân bóng & Thống kê (`/api/v1/owner/pitches/*`, `/owner/bank-accounts/*`, `/owner/revenue/*`):**
  - `POST /owner/pitches`, `PATCH /owner/pitches/{id}`, `POST /owner/pitches/{id}/deactivate`.
  - `PUT /owner/pitches/{id}/weekly-slots` (cấu hình giá & trạng thái khung giờ theo ngày trong tuần).
  - `PUT /owner/pitches/{id}/slot-blocks` (khóa/mở khóa khung giờ ngày cụ thể).
  - `POST/PUT /owner/bank-accounts` (cấu hình STK nhận cọc).
  - `GET /owner/revenue/summary` & `GET /owner/financial-entries` (tổng hợp tiền cọc `RECEIVED`, `REFUND`, `OUTSTANDING`).
* **2.3. Nhánh 2 – Tìm sân, Đặt sân 4h, Cọc, Đánh giá & Bình luận (`/api/v1/pitches/*`, `/api/v1/bookings/*`, `/api/v1/owner/bookings/*`, `/api/v1/comments/*`):**
  - `GET /pitches` (lọc từ khóa, loại sân, quận/huyện, bán kính GPS Haversine), `GET /pitches/{id}`, `GET /pitches/{id}/slots?date=YYYY-MM-DD` (trả trạng thái `AVAILABLE` / `BOOKED` / `BLOCKED`).
  - `POST /bookings` (Transaction `REPEATABLE READ` + bắt lỗi trùng `uq_booking_reserved_slot` → `409 Conflict`, set `expires_at = NOW() + 4h`).
  - `GET /bookings/me`, `GET /owner/bookings`, `GET /bookings/{id}`.
  - `POST /owner/bookings/{id}/accept|reject|confirm-deposit|cancel|complete|no-show` (khi `confirm-deposit` tự động ghi `financial_entries` `RECEIVED`).
  - `POST /bookings/{id}/deposit-reports` (Client gửi thông tin đã chuyển khoản) & `POST /bookings/{id}/cancel`.
  - `POST /bookings/{id}/review` (chỉ cho phép khi `COMPLETED`), `GET /pitches/{id}/reviews`, `GET/POST /comments`.

### Giai đoạn 3: Kết nối & Tinh chỉnh Giao diện Frontend (`frontend/`)
* **3.1. Điều hướng & Phân quyền:**
  - Cập nhật `PlayerNavBar` và `AdminSideBar`: Giữ các mục Tìm sân, Lịch sử đặt sân, Hồ sơ (Client) và Tổng quan doanh thu, Quản lý sân & Lịch tuần, Quản lý đơn đặt sân, Cài đặt ngân hàng (Pitch Owner). **Ẩn/gỡ bỏ** các mục Giải đấu (`League`, `Teams`, `Matchmaking`).
* **3.2. Luồng Client:**
  - Trang Tìm sân + Bản đồ Leaflet GPS (`LandingPage` / `BookingPage`).
  - Trang Chi tiết sân (`PitchDetailPage`): Chọn ngày xem slot trống/đã đặt/bị khóa, xem đánh giá sao & bình luận.
  - Trang Đặt sân (`CheckoutPage`): Hiển thị thông tin TK ngân hàng Chủ sân, đếm ngược giữ chỗ **4 giờ**, form báo đã chuyển khoản cọc.
  - Trang Lịch sử đặt sân (`ProfilePage` / `MyBookings`): Theo dõi trạng thái, hủy đơn, gửi đánh giá 5 sao sau khi `COMPLETED`.
* **3.3. Luồng Pitch Owner:**
  - Quản lý cụm sân & sân con, bảng cấu hình khung giờ tuần & khóa slot đột xuất.
  - Quản lý đơn đặt sân (Chấp nhận / Từ chối / Xác nhận đã nhận cọc / Hoàn thành / No-Show).
  - Dashboard Doanh thu (biểu đồ + tổng hợp cọc `RECEIVED`).

### Giai đoạn 4: Kiểm thử & Nghiệm thu theo `test_plan.md`
* **4.1.** Chạy bộ test tự động Backend (`vitest` + `supertest`) kiểm chứng toàn bộ 19 Test Cases (`TC-AUTH`, `TC-PITCH`, `TC-REV`, `TC-BOOK`, `TC-COMM`), đặc biệt là **test đa luồng 10 request đặt cùng 1 slot** (`1` thành công `201`, `9` lỗi `409`).
* **4.2.** Chạy `npm run build` & `npm test` ở `frontend/` bảo đảm 0 lỗi TypeScript/UI.
* **4.3.** Chạy thử End-to-End kết nối trực tiếp Cloud PostgreSQL và kiểm tra dữ liệu hiển thị trên Neon/Supabase Table Editor.

---

## 3. ĐIỀU KIỆN BẮT ĐẦU

Sau khi bạn xác nhận **duyệt kế hoạch** này (và gửi `DATABASE_URL` từ Neon/Supabase nếu đã tạo sẵn, hoặc tôi có thể bắt đầu dựng `demo_backend/` + kết nối mẫu ngay để bạn chỉ việc điền `DATABASE_URL` vào `.env`), tôi sẽ tiến hành code theo đúng 4 giai đoạn trên.

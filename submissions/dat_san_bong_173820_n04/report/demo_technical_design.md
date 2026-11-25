# TÀI LIỆU PHƯƠNG PHÁP KỸ THUẬT & THIẾT KẾ HỆ THỐNG BẢN DEMO
## Dự án: Soccer Booker – Hệ thống Đặt sân bóng đá trực tuyến & Quản lý Sân bóng (Phạm vi MVP: Nhánh 1, 2, 4)

**Phiên bản:** 1.0 (Pre-Implementation Design)  
**Tham chiếu chuẩn:** Báo cáo Tuần 11 Nhóm 04, Hồ sơ Drive Tuần 2–5 (`V1__create_soccer_booker_schema.sql`, `endpoint-catalogue.md`, `openapi.yaml`), và tham khảo cấu trúc mã nguồn/thiết kế tại `D:\2026\2026.1\KTPMUD\docs`, `backend/`, `frontend/`.

---

## 1. PHẠM VI TRIỂN KHAI BẢN DEMO

Theo định hướng của Nhóm 04, bản Demo tập trung hoàn thiện **3 nhánh chức năng cốt lõi** để bảo đảm độ ổn định, tính đúng đắn nghiệp vụ và khả năng kiểm thử 100%:

| Nhánh | Tên phân hệ | Trạng thái Demo | Mã FR / UC tương ứng |
|:---:|---|:---:|---|
| **Nhánh 1** | **Quản lý tài khoản & Xác thực** | **Triển khai** | `FR-01`..`FR-04`, `FR-47` \| `UC-01` |
| **Nhánh 2** | **Quản lý đặt sân, Giữ chỗ 4h, Cọc & Cộng đồng** | **Triển khai** | `FR-05`..`FR-29`, `FR-43`..`FR-44`, `FR-55` \| `UC-02`..`UC-04`, `UC-07`, `UC-10` |
| **Nhánh 4** | **Quản lý sân bóng, Khung giờ & Thống kê doanh thu** | **Triển khai** | `FR-48`..`FR-54`, `FR-56` \| `UC-08`, `UC-09`, `UC-12` |
| **Nhánh 3** | **Quản lý giải đấu phong trào** (`tournaments`, `matches`, `standings`) | **Tạm hoãn** | `FR-30`..`FR-42`, `FR-45`..`FR-46` \| `UC-05`, `UC-06`, `UC-11` *(Mở rộng ở giai đoạn sau)* |

> **Nguyên tắc kiến trúc mở rộng:** CSDL và Backend giữ nguyên ranh giới Modular Monolith. Các bảng/module liên quan đến Nhánh 3 chưa kích hoạt trên UI Demo nhưng giao diện kiểm tra xung đột lịch (`SlotAvailabilityChecker`) được thiết kế dạng interface để sau này cắm thêm module Giải đấu mà không phải sửa code lõi đặt sân.

---

## 2. PHƯƠNG PHÁP KỸ THUẬT & CÔNG NGHỆ SỬ DỤNG

Kế thừa và nâng cấp từ cấu trúc dự án hiện có (`backend/`, `frontend/`, `docs/`), bản Demo áp dụng các phương pháp kỹ thuật sau:

### 2.1. Ngăn xếp công nghệ (Tech Stack)
* **Backend:** Java + **Spring Boot** (Modular Monolith), **Spring Security + JWT** (xác thực Stateless, 24h), **Spring Data JPA / Hibernate**, **Flyway** (quản lý schema migration tự động), **Spring `@Scheduled` & `@Async`** (tự động hủy đơn quá hạn 4h và gửi email không đồng bộ).
* **Cơ sở dữ liệu:** **PostgreSQL 15+** (chạy qua Docker Compose kèm extension `btree_gist`), thay thế cấu hình MySQL cũ trong `backend/docker-compose.yml` để tận dụng **Exclusion Constraint** và **Partial Unique Index** chống đặt trùng lịch ở mức vật lý.
* **Email Sandbox (Demo):** **MailHog** (SMTP port `1025`, Web UI `8025`) để kiểm thử luồng xác thực email (`FR-01`), quên mật khẩu (`FR-02`) và thông báo xác nhận cọc mà không cần SMTP thật.
* **Frontend:** **React 19 + TypeScript + Vite**, **Tailwind CSS**, **TanStack React Query** (caching & đồng bộ trạng thái API), **React Hook Form + Zod** (validate form chặt chẽ), **Leaflet / React-Leaflet** (bản đồ tìm sân theo GPS `FR-06`), **Zustand** (lưu trạng thái phiên đăng nhập).
* **Kiểm thử tự động:** **JUnit 5 + Mockito + MockMvc / Testcontainers** (Backend) và **Vitest + React Testing Library** (Frontend).

### 2.2. Các cơ chế kỹ thuật trọng tâm
1. **Phân quyền RBAC 2 vai trò chuẩn (`CLIENT`, `PITCH_OWNER`):**
   * Khi đăng ký tài khoản chủ sân hoặc nâng cấp hồ sơ chủ sân, user được gán cả `CLIENT` và `PITCH_OWNER` trong bảng `user_roles`.
   * Mọi endpoint `/owner/**` bắt buộc `@PreAuthorize("hasRole('PITCH_OWNER')")` và kiểm tra quyền sở hữu tài nguyên (`complex.owner_user_id == currentUserId`).
2. **Chống đặt trùng lịch đa luồng (Zero Double-Booking):**
   * **Tầng Service:** Mở transaction với mức cô lập `REPEATABLE_READ` (hoặc Pessimistic Lock trên hàng lịch/slot) để kiểm tra `pitch_weekly_slots` (đang hoạt động), `pitch_slot_blocks` (không bị khóa đột xuất) và `bookings`.
   * **Tầng CSDL (Lớp bảo vệ cuối):** Sử dụng Partial Unique Index `uq_booking_reserved_slot` trên `(pitch_id, booking_date, time_slot_id) WHERE status IN ('PENDING', 'WAITING_FOR_DEPOSIT', 'CONFIRMED')`. Khi hai người bấm đặt cùng 1 slot ở cùng mili-giây, PostgreSQL đảm bảo chỉ 1 transaction commit thành công, transaction còn lại nhận `DataIntegrityViolationException` → trả về **HTTP 409 Conflict**.
3. **Cơ chế giữ chỗ 4 giờ & Chuyển khoản ngoài hệ thống:**
   * Đơn mới tạo có trạng thái `PENDING` (chờ chủ sân accept) hoặc `WAITING_FOR_DEPOSIT` với `deposit_deadline_at = accepted_at + 4 hours`.
   * Background Job chạy mỗi 1 phút (`@Scheduled(fixedRate = 60000)`) quét các đơn `WAITING_FOR_DEPOSIT` có `deposit_deadline_at < NOW()` (hoặc `PENDING` quá hạn) để chuyển sang `EXPIRED` → Partial Unique Index tự động giải phóng slot cho khách khác đặt ngay lập tức.
4. **Tính toán cấu hình khung giờ không chồng lấn (`btree_gist`):**
   * Bảng `time_slots` / `pitch_weekly_slots` sử dụng kiểu `tsrange` kết hợp `EXCLUDE USING gist` để ngăn chủ sân tạo 2 khung giờ giao nhau trong cùng một ngày của tuần.

---

## 3. THIẾT KẾ CƠ SỞ DỮ LIỆU (PHẠM VI NHÁNH 1, 2, 4)

Trích xuất và tinh gọn trực tiếp từ `V1__create_soccer_booker_schema.sql` trên Drive (giữ nguyên tên bảng, cột và ràng buộc):

### Nhóm 1: Quản lý tài khoản (Nhánh 1)
* `users`: `user_id` (PK), `full_name`, `email` (UNIQUE), `phone` (UNIQUE), `password_hash` (BCrypt), `status` (`PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`, `CLOSED`), `email_verified_at`.
* `roles` & `user_roles`: Phân quyền `CLIENT`, `PITCH_OWNER`.
* `oauth_accounts`: Liên kết đăng nhập Google (`provider`, `provider_subject`).
* `email_verification_tokens` & `password_reset_tokens`: Token băm SHA-256 có thời hạn (`expires_at`, `used_at`).
* `pitch_owner_profiles`: `display_name`, `contact_email`, `contact_phone`, `facebook_url`, `other_contact`.

### Nhóm 2: Quản lý sân bóng (Nhánh 4)
* `pitch_complexes`: `complex_id`, `owner_user_id` (FK), `complex_name`, `address_line`, `ward`, `district`, `province`, `latitude`, `longitude`, `status`.
* `pitches`: `pitch_id`, `complex_id` (FK), `pitch_name`, `pitch_type` (`5v5`, `7v7`, `11v11`), `surface_type`, `status` (`ACTIVE`, `INACTIVE`, `SUSPENDED`).
* `pitch_images`: Lưu URL ảnh sân (`image_url`, `is_cover`).
* `time_slots`: `slot_id`, `start_time`, `end_time` (ràng buộc `start_time < end_time`).
* `pitch_weekly_slots`: `weekly_slot_id`, `pitch_id`, `day_of_week` (1..7), `slot_id`, `price_vnd`, `deposit_percent` / `deposit_amount`, `is_active`.
* `pitch_slot_blocks`: `block_id`, `pitch_id`, `block_date`, `slot_id`, `block_type` (`BLOCKED`, `UNAVAILABLE`), `reason`.
* `bank_accounts`: `bank_account_id`, `owner_user_id` (FK), `bank_name`, `account_number`, `account_holder`, `is_default`.

### Nhóm 3: Quản lý đặt sân, Cọc, Đánh giá & Tài chính (Nhánh 2 & 4)
* `bookings`: `booking_id`, `booking_code` (UNIQUE), `client_user_id`, `pitch_id`, `booking_date`, `time_slot_id`, `total_price`, `deposit_required`, `status` (`PENDING`, `WAITING_FOR_DEPOSIT`, `CONFIRMED`, `REJECTED`, `CANCELLED`, `EXPIRED`, `COMPLETED`, `NO_SHOW`), `deposit_deadline_at`, `cancel_reason`.
* `deposit_reports`: `report_id`, `booking_id`, `reported_amount`, `transfer_reference`, `proof_image_url`, `status` (`REPORTED`, `CONFIRMED`, `REJECTED`, `WITHDRAWN`).
* `financial_entries`: `entry_id`, `owner_user_id`, `booking_id`, `entry_type` (`RECEIVED`, `REFUND`, `OUTSTANDING`), `amount`, `status` (`RECORDED`, `VOIDED`).
* `reviews`: `review_id`, `booking_id` (UNIQUE – mỗi booking hoàn thành chỉ đánh giá 1 lần), `pitch_id`, `client_user_id`, `rating` (1..5), `comment`.
* `comments`: `comment_id`, `author_user_id`, `target_type` (`PITCH`, `PITCH_SLOT`), `target_id`, `content`, `is_hidden`.

---

## 4. THIẾT KẾ CHI TIẾT THEO TỪNG YÊU CẦU CHỨC NĂNG

### 4.1. Nhánh 1 – Quản lý tài khoản & Xác thực (9 Endpoints)
| Chức năng / FR | Endpoint | Xử lý Backend & Quy tắc nghiệp vụ | Màn hình Frontend |
|---|---|---|---|
| Đăng ký (`FR-01`) | `POST /api/v1/auth/register` | Validate email/phone duy nhất; băm password bằng BCrypt; gán role `CLIENT` (tùy chọn đăng ký kèm `PITCH_OWNER`); tạo token xác thực gửi qua MailHog. | `RegisterPage` |
| Xác thực Email (`FR-01`) | `GET /api/v1/auth/verify-email?token=...` | Kiểm tra token chưa hết hạn & chưa dùng → chuyển `status = ACTIVE`. | `VerifyEmailPage` |
| Đăng nhập (`FR-02`) | `POST /api/v1/auth/login` | Kiểm tra `ACTIVE` + khớp BCrypt → sinh JWT Access Token (chứa `userId`, `roles`). | `LoginPage` |
| Đăng nhập Google (`FR-02`) | `POST /api/v1/auth/google` | Verify Google ID Token (hỗ trợ mock mode khi chạy local demo nếu chưa cấu hình Client ID). | `LoginPage` |
| Quên / Đặt lại MK (`FR-02`) | `POST /api/v1/auth/password/forgot`, `reset` | Sinh token reset gửi MailHog; cập nhật `password_hash` mới. | `ForgotPasswordPage`, `ResetPasswordPage` |
| Hồ sơ cá nhân (`FR-04`) | `GET /PATCH /api/v1/users/me` | Xem/cập nhật `full_name`, `phone`. | `ProfilePage` |
| Hồ sơ Chủ sân (`FR-47`) | `PUT /api/v1/owner/profile` | Cập nhật thông tin liên hệ hiển thị công khai (`display_name`, `contact_phone`, `facebook_url`). | `OwnerSettingsPage` |

### 4.2. Nhánh 4 – Quản lý sân bóng & Thống kê Chủ sân (11 Endpoints)
| Chức năng / FR | Endpoint | Xử lý Backend & Quy tắc nghiệp vụ | Màn hình Frontend |
|---|---|---|---|
| Thêm / Sửa cụm sân & sân (`FR-48`, `FR-49`) | `POST /api/v1/owner/pitches`, `PATCH /api/v1/owner/pitches/{id}` | Tạo `pitch_complexes` (nếu chưa có) + `pitches` kèm tọa độ GPS (`lat`, `lng`), loại sân (`5v5`/`7v7`/`11v11`), mô tả. | `OwnerPitchesPage` |
| Ngừng nhận booking (`FR-50`) | `POST /api/v1/owner/pitches/{id}/deactivate` | Chuyển `status = INACTIVE` (không xóa vật lý để bảo toàn lịch sử booking). | `OwnerPitchesPage` |
| Cấu hình khung giờ tuần (`FR-51`, `FR-52`) | `PUT /api/v1/owner/pitches/{id}/weekly-slots` | Thiết lập giá & % cọc theo `day_of_week` + `time_slot_id`. | `FieldSchedulePage` |
| Khóa khung giờ đột xuất (`FR-11`, `FR-53`) | `PUT /api/v1/owner/pitches/{id}/slot-blocks` | Tạo/gỡ `pitch_slot_blocks` cho ngày cụ thể (bảo trì, mưa bão). Chặn khóa nếu đã có booking `CONFIRMED` trừ khi hủy kèm lý do. | `FieldSchedulePage` |
| Quản lý ảnh & TK Ngân hàng (`FR-54`, `FR-16`) | `POST .../images`, `POST/PUT /owner/bank-accounts` | Lưu ảnh sân và cấu hình STK nhận cọc hiển thị cho khách khi booking. | `OwnerSettingsPage` |
| Thống kê doanh thu (`FR-56`) | `GET /api/v1/owner/revenue/summary`, `/financial-entries` | Tổng hợp tiền cọc `RECEIVED`, `REFUND`, `OUTSTANDING` và tỷ lệ lấp đầy slot theo khoảng ngày. | `OwnerDashboardPage` |

### 4.3. Nhánh 2 – Tìm sân, Đặt sân 4h, Cọc & Đánh giá (20 Endpoints)
| Chức năng / FR | Endpoint | Xử lý Backend & Quy tắc nghiệp vụ | Màn hình Frontend |
|---|---|---|---|
| Tìm kiếm & Lọc sân (`FR-05`..`FR-08`) | `GET /api/v1/pitches` | Lọc theo từ khóa, quận/huyện, loại sân, khoảng giá, bán kính GPS (công thức Haversine). | `LandingPage` / `SearchPage` |
| Xem chi tiết & Lịch trống (`FR-09`, `FR-10`) | `GET /api/v1/pitches/{id}`, `GET /api/v1/pitches/{id}/slots?date=...` | Trả về danh sách slot trong ngày kèm trạng thái thực tế: `AVAILABLE`, `BOOKED`, `BLOCKED`, `EXPIRED`. | `PitchDetailPage` |
| Tạo Booking giữ chỗ 4h (`FR-12`, `FR-13`, `FR-19`) | `POST /api/v1/bookings` | Kiểm tra slot `AVAILABLE` → tạo `bookings` (`PENDING` hoặc `WAITING_FOR_DEPOSIT` với `deposit_deadline_at = now + 4h`). Chống trùng bằng Partial Unique Index. | `CheckoutPage` |
| Báo đã chuyển khoản (`FR-17`) | `POST /api/v1/bookings/{id}/deposit-reports` | Client nhập mã giao dịch / tải ảnh ủy nhiệm chi → tạo `deposit_reports` (`REPORTED`). | `MyBookingsPage` |
| Duyệt / Từ chối / Xác nhận cọc (`FR-15`, `FR-18`) | `POST /owner/bookings/{id}/accept\|reject\|confirm-deposit` | `accept` mở đếm ngược 4h; `confirm-deposit` chuyển `CONFIRMED` + tự động ghi bút toán `RECEIVED` vào `financial_entries`. | `OwnerOrdersPage` |
| Hủy / Hoàn thành / No-Show (`FR-20`, `FR-21`, `FR-55`) | `POST .../cancel`, `.../complete`, `.../no-show` | Cập nhật trạng thái booking và giải phóng slot nếu hủy trước giờ đá. | `MyBookingsPage`, `OwnerOrdersPage` |
| Đánh giá & Bình luận (`FR-25`..`FR-29`, `FR-43`..`FR-44`) | `POST /bookings/{id}/review`, `GET /pitches/{id}/reviews`, `GET/POST /comments` | Chỉ cho phép đánh giá 1–5 sao khi booking ở trạng thái `COMPLETED`. Bình luận công khai gắn với `PITCH`. | `PitchDetailPage`, `MyBookingsPage` |

---

## 5. KẾ HOẠCH TRIỂN KHAI BẢN DEMO (SAU KHI DUYỆT)

1. **Bước 1 – Hạ tầng & CSDL:** Cập nhật `backend/docker-compose.yml` dùng **PostgreSQL 15** + **MailHog**; đưa `V1__create_soccer_booker_schema.sql` vào Flyway migration kèm seed data mẫu (4 cụm sân Hà Nội, 10 sân con, tài khoản demo `client@demo.vn` & `owner@demo.vn`).
2. **Bước 2 – Backend (Nhánh 1, 2, 4):** Chuẩn hóa lại các module `auth`, `user`, `pitch`, `booking`, `review`, `comment`, `statistics` theo đúng API contract & 2 role `CLIENT`/`PITCH_OWNER`; cài đặt Scheduled Job 4h và cơ chế chống trùng lịch `REPEATABLE_READ` + Partial Unique Index.
3. **Bước 3 – Frontend (Nhánh 1, 2, 4):** Kết nối giao diện React/Vite với các API mới; ẩn/tạm khóa menu Giải đấu (Nhánh 3); hoàn thiện luồng Demo End-to-End (Tìm sân GPS → Đặt sân đếm ngược 4h → Gửi minh chứng cọc → Chủ sân xác nhận → Doanh thu & Đánh giá).
4. **Bước 4 – Chạy kiểm thử theo `test_plan.md`:** Thực thi toàn bộ bộ test tự động Backend + Frontend và nghiệm thu từng tiêu chí.

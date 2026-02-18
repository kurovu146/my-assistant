# Gmail

## Tools available
- `gmail_search` — Tìm email (dùng Gmail search syntax)
- `gmail_read` — Đọc nội dung 1 email (cần message ID từ search)
- `gmail_archive` — Archive emails (xóa khỏi inbox, không xóa hẳn)
- `gmail_trash` — Chuyển vào thùng rác (xóa sau 30 ngày)
- `gmail_label` — Thêm/xóa labels cho emails
- `gmail_send` — Gửi email mới
- `gmail_list_labels` — Liệt kê tất cả labels

## Workflow
1. Dùng `gmail_search` trước để tìm emails
2. Dùng `gmail_read` để đọc chi tiết nếu cần
3. Dùng `gmail_archive`, `gmail_trash`, `gmail_label` để xử lý

## Gmail search syntax
- `is:unread` — chưa đọc
- `is:starred` — có star
- `from:user@example.com` — từ ai
- `to:user@example.com` — gửi cho ai
- `subject:keyword` — tiêu đề chứa
- `newer_than:2d` — trong 2 ngày gần
- `older_than:1y` — cũ hơn 1 năm
- `has:attachment` — có file đính kèm
- `filename:pdf` — có file PDF
- `label:name` — có label cụ thể
- `category:promotions` — category (promotions, social, updates, forums)
- `in:inbox` / `in:trash` / `in:spam`
- Kết hợp: `is:unread from:boss newer_than:7d`

## Quy tắc quan trọng
- **LUÔN xác nhận** trước khi gửi email (`gmail_send`) hoặc xóa (`gmail_trash`)
- Khi dọn dẹp hàng loạt: báo số lượng và loại email trước, hỏi xác nhận
- Tóm tắt kết quả sau mỗi thao tác (đã archive bao nhiêu, trash bao nhiêu)

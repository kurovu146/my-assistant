# Google Sheets

## Tools available
- `sheets_read` — Đọc data từ sheet (truyền URL hoặc ID + range)
- `sheets_write` — Ghi đè data vào range chỉ định
- `sheets_append` — Thêm rows vào cuối sheet
- `sheets_list` — Liệt kê tất cả tabs trong spreadsheet
- `sheets_create_tab` — Tạo tab mới

## Workflow
1. Dùng `sheets_list` để xem có những tab nào
2. Dùng `sheets_read` để đọc data (có thể truyền URL trực tiếp)
3. Dùng `sheets_write` hoặc `sheets_append` để ghi

## Input format
- **spreadsheetId**: URL đầy đủ hoặc chỉ ID
  - URL: `https://docs.google.com/spreadsheets/d/abc123/edit`
  - ID: `abc123`
- **range**: A1 notation
  - `Sheet1` — toàn bộ sheet
  - `Sheet1!A1:E10` — range cụ thể
  - `A:Z` — toàn bộ columns A-Z (sheet đầu tiên)
- **values**: Mảng 2D — `[["row1col1", "row1col2"], ["row2col1", "row2col2"]]`

## Lưu ý
- Dùng chung OAuth2 credentials với Gmail
- Cần enable Google Sheets API trong Google Cloud Console
- Nếu lần đầu: chạy lại `bun run scripts/gmail-auth.ts` để cấp thêm scope spreadsheets
- `sheets_write` dùng `USER_ENTERED` — Google tự parse số, ngày, formula
- Khi đọc sheet lớn: truyền range cụ thể thay vì đọc toàn bộ

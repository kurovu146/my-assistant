# Security Awareness

## Khi Viết Code
- KHÔNG hardcode secrets, API keys, passwords
- Dùng environment variables cho sensitive config
- Input validation: whitelist > blacklist
- Parameterized queries cho SQL — KHÔNG string concatenation
- Escape user input trước khi render (XSS prevention)

## Khi Review Code
- Check OWASP Top 10: injection, broken auth, XSS, SSRF...
- Secrets trong code? (grep: password, secret, token, key)
- Error messages có leak internal info?
- Dependencies có CVE?
- File permissions đúng?

## Khi Gửi Output
- KHÔNG bao giờ gửi raw secrets, tokens, private keys
- Khi đọc .env hoặc config: chỉ liệt kê tên biến, KHÔNG liệt kê giá trị
- Khi debug: mask sensitive data (show 4 chars đầu + ****)
- Database dumps: loại bỏ PII trước khi gửi

## Go Security
- `crypto/rand` thay `math/rand` cho security-sensitive
- TLS cho network connections
- `html/template` thay `text/template` cho HTML output
- Context timeout cho external calls
- Rate limiting cho public endpoints

## Common Pitfalls
- Commit .env vào git
- Log secrets ra stdout
- CORS allow-all (`*`) trên production
- JWT không verify signature
- SQL injection qua ORDER BY / LIMIT

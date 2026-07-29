Thư mục này từng chứa 12 file .md được gộp thẳng vào system prompt của bot.

Đã bỏ ngày 2026-07-29. Lý do: số liệu trong query_logs cho thấy agent gọi tool `Skill`
của Claude Code 9 lần, nhưng chưa lần nào tự Read một file trong thư mục này — mục lục
đặt trong system prompt là một lời dặn bằng văn xuôi, không cạnh tranh nổi với một tool
thật có `description` được đưa vào danh sách tool.

Các skill đã chuyển đi (nguyên văn, chỉ thêm frontmatter):

  ~/.claude/skills/            telegram-ux, security-awareness, gmail, google-sheets
  <repo basotien>/.claude/     godot, go-gamedev

Đã xoá vì đã có bản Claude Code đầy đủ hơn (gấp 3-4 lần nội dung):
  code-review, database-sql, git-workflow, project-management

Đã xoá vì quá mỏng, không đáng giữ:
  docker-devops, research

Đặt file .md mới vào đây thì loader ở src/claude/skills.ts vẫn hoạt động như cũ. Nhưng
cân nhắc viết thành skill Claude Code thật (~/.claude/skills/<tên>/SKILL.md) — agent chủ
động gọi được, thay vì chờ nó chịu đọc file.

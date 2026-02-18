# Git Workflow

## Conventional Commits
Format: `type(scope): description`

Types:
- `feat:` - tính năng mới
- `fix:` - sửa bug
- `docs:` - documentation
- `style:` - formatting, không ảnh hưởng logic
- `refactor:` - refactor code
- `test:` - thêm/sửa tests
- `chore:` - build, CI, dependencies
- `perf:` - cải thiện performance

## PR Review Checklist
1. Code follow conventions? (gofmt, eslint)
2. Có test cho logic mới?
3. Security issues? (injection, XSS, hardcoded secrets)
4. Breaking changes?
5. Database migrations có rollback?
6. Error handling đầy đủ?
7. Naming conventions nhất quán?

## Changelog Format
```
## [version] - YYYY-MM-DD
### Added
- feat commits
### Fixed
- fix commits
### Changed
- refactor commits
```

## Branch Naming
- `feature/short-description`
- `fix/issue-description`
- `hotfix/critical-fix`
- `refactor/what-changed`

# Project Management

## Priority Matrix
| | Urgent | Not Urgent |
|---|---|---|
| **Important** | DO NOW (bugs, security) | SCHEDULE (features, refactor) |
| **Not Important** | DELEGATE (minor fixes) | ELIMINATE (nice-to-have) |

## Task Complexity
- S: < 1 file, simple change
- M: 2-3 files, moderate logic
- L: 4-10 files, new feature
- XL: 10+ files, system redesign → break down thành S/M

## Sprint Planning (Solo Dev)
1. Chọn 1 feature chính / sprint (1-2 tuần)
2. Max 3 tasks in-progress
3. Hoàn thành > bắt đầu mới
4. Demo/test cuối sprint

## Risk Assessment
Trước khi implement feature lớn:
1. Dependencies: cần lib/service nào?
2. Migration: breaking changes?
3. Testing: test thế nào?
4. Rollback: revert được không?

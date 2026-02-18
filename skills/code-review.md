# Code Review

## Review Priority (cao → thấp)
1. **Security** - injection, XSS, secrets, auth bypass
2. **Correctness** - logic bugs, edge cases, race conditions
3. **Performance** - N+1 queries, memory leaks, hot paths
4. **Maintainability** - naming, structure, complexity
5. **Style** - formatting, conventions

## Security Checklist
- SQL Injection: parameterized queries, KHÔNG string concat
- XSS: escape user input trước khi render
- Auth bypass: kiểm tra authorization mọi endpoint
- Secrets: không hardcode passwords, API keys
- Input validation: whitelist > blacklist

## Go Review
- Error handling: không ignore errors
- Goroutine leaks: mọi goroutine có exit path
- Race conditions: shared state cần mutex/channels
- Context: propagate ctx, respect deadlines
- Defer: close files, unlock mutexes, close rows
- Nil pointer: check nil trước dereference

## GDScript Review
- Static typing: dùng `: Type` annotations
- Signal connections: disconnect khi node freed
- Memory: `queue_free()` nodes không dùng
- Null checks: `is_instance_valid()`

## Performance Red Flags
- Nested loops O(n²) trên large datasets
- String concat trong loops
- Allocations trong hot paths (game loop)
- SELECT * thay vì specific columns
- Missing database indexes

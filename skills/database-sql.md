# Database & SQL

## PostgreSQL Patterns

### Query Optimization
- EXPLAIN ANALYZE trước khi optimize
- Index cho columns hay WHERE/JOIN/ORDER BY
- Tránh SELECT *, chỉ lấy columns cần
- Keyset pagination cho large datasets
- Batch INSERT thay vì INSERT từng row

### Common SQL
```sql
-- Keyset pagination
SELECT * FROM items WHERE id > $1 ORDER BY id LIMIT $2;

-- Upsert
INSERT INTO table (key, value) VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- JSONB query
SELECT data->>'name' FROM items WHERE data @> '{"type": "weapon"}';

-- Materialized view
CREATE MATERIALIZED VIEW leaderboard AS
SELECT username, level FROM characters ORDER BY level DESC;
REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard;
```

### pgx/v5 (Go)
```go
// Single row
err := pool.QueryRow(ctx, "SELECT name FROM users WHERE id=$1", id).Scan(&name)

// Transaction
tx, _ := pool.Begin(ctx)
defer tx.Rollback(ctx)
tx.Commit(ctx)

// Batch
batch := &pgx.Batch{}
batch.Queue("INSERT INTO ...", args...)
results := pool.SendBatch(ctx, batch)
defer results.Close()
```

### Migration Best Practices
- Mỗi migration có UP và DOWN
- Thêm column: luôn DEFAULT hoặc NULL
- Index: CREATE CONCURRENTLY trên production
- Test trên staging trước

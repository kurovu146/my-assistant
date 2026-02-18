# Docker & DevOps

## Docker Debug Checklist
1. Container running? `docker ps`
2. Exit code? `docker ps -a` (0=OK, 1=error, 137=OOM)
3. Logs? `docker logs <container> --tail 200`
4. Network? `docker network ls`
5. Resources? `docker stats`
6. Ports? `docker port <container>`

## Essential Commands
```bash
# Compose
docker-compose up -d
docker-compose down
docker-compose logs -f <service>
docker-compose restart <service>
docker-compose build --no-cache

# Debug
docker exec -it <container> sh
docker inspect <container>

# Cleanup
docker system prune -f
docker volume prune -f
```

## Health Check
```yaml
healthcheck:
  test: ["CMD", "pg_isready", "-U", "basotien"]
  interval: 10s
  timeout: 5s
  retries: 5
```

## CI/CD Basics
- Go: `go test ./...` → `go build` → Docker build
- GitHub Actions cho automation
- Docker build → push registry → deploy

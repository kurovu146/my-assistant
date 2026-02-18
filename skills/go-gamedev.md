# Go Game Development

## Go + Godot Integration

### Kiến trúc tổng quan
- Go xử lý game logic, networking, server-side (performance-critical)
- Godot xử lý rendering, UI, input, audio (client-side)
- Giao tiếp qua: GDExtension bindings, WebSocket, gRPC, hoặc shared memory

### go-godot bindings (GDExtension)

```go
// Đăng ký custom class từ Go
package main

import (
    "grow.graphics/gd"
    "grow.graphics/gd/gdextension"
)

type Player struct {
    gd.Class[Player, gd.CharacterBody2D]

    Speed gd.Float `gd:"speed" default:"300.0"`
    Health gd.Int   `gd:"health" default:"100"`
}

func (p *Player) Ready() {
    // Khởi tạo khi node vào scene tree
}

func (p *Player) PhysicsProcess(delta gd.Float) {
    // Game logic mỗi physics frame
    velocity := p.GetVelocity()
    // ...
    p.SetVelocity(velocity)
    p.MoveAndSlide()
}

func main() {
    godot, ok := gdextension.Link()
    if !ok {
        return
    }
    gd.Register[Player](godot)
}
```

### Go game server pattern

```go
// Game server với goroutines
type GameServer struct {
    players   map[string]*Player
    mu        sync.RWMutex
    broadcast chan Message
}

func (s *GameServer) Run(ctx context.Context) {
    ticker := time.NewTicker(16 * time.Millisecond) // ~60 FPS
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            s.update()
        case msg := <-s.broadcast:
            s.handleMessage(msg)
        }
    }
}

// WebSocket handler cho Godot client
func (s *GameServer) HandleWS(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        return
    }
    defer conn.Close()

    for {
        var msg Message
        if err := conn.ReadJSON(&msg); err != nil {
            break
        }
        s.broadcast <- msg
    }
}
```

## Go Game Patterns

### Entity Component System (ECS)

```go
// Lightweight ECS pattern
type EntityID uint64

type World struct {
    nextID     EntityID
    positions  map[EntityID]*Position
    velocities map[EntityID]*Velocity
    sprites    map[EntityID]*Sprite
}

type Position struct{ X, Y float64 }
type Velocity struct{ DX, DY float64 }

// System: cập nhật position dựa trên velocity
func (w *World) MovementSystem(dt float64) {
    for id, vel := range w.velocities {
        if pos, ok := w.positions[id]; ok {
            pos.X += vel.DX * dt
            pos.Y += vel.DY * dt
        }
    }
}
```

### State Machine

```go
type State int

const (
    StateIdle State = iota
    StateRunning
    StateJumping
    StateFalling
)

type StateMachine struct {
    current     State
    transitions map[State]map[State]bool // allowed transitions
    onEnter     map[State]func()
    onExit      map[State]func()
}

func (sm *StateMachine) TransitionTo(next State) bool {
    if !sm.transitions[sm.current][next] {
        return false
    }
    if fn, ok := sm.onExit[sm.current]; ok {
        fn()
    }
    sm.current = next
    if fn, ok := sm.onEnter[next]; ok {
        fn()
    }
    return true
}
```

### Game Loop

```go
func GameLoop(ctx context.Context) {
    const targetFPS = 60
    const frameDuration = time.Second / targetFPS

    var (
        lastTime  = time.Now()
        accumulator time.Duration
    )

    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        now := time.Now()
        elapsed := now.Sub(lastTime)
        lastTime = now
        accumulator += elapsed

        // Fixed timestep update
        for accumulator >= frameDuration {
            Update(frameDuration.Seconds())
            accumulator -= frameDuration
        }

        // Render với interpolation
        alpha := float64(accumulator) / float64(frameDuration)
        Render(alpha)
    }
}
```

## Performance Tips

### Go-specific
- `sync.Pool` cho object pooling (bullets, particles)
- Tránh allocations trong hot path: pre-allocate slices, dùng fixed-size arrays
- `runtime.LockOSThread()` cho goroutine cần thread-affinity (OpenGL, CGo)
- Profile với `pprof`: `go tool pprof http://localhost:6060/debug/pprof/profile`
- Dùng `unsafe.Pointer` cẩn thận khi cần zero-copy với CGo

### Concurrency cho games
- Game logic trên 1 goroutine chính (tránh race conditions)
- Networking, AI, pathfinding trên goroutines riêng
- Channels cho communication, không share memory
- `sync.RWMutex` khi cần shared state (player list, world state)
- Context cancellation cho graceful shutdown

### CGo optimization
- Giảm thiểu CGo calls (mỗi call có overhead ~100ns)
- Batch operations: gom nhiều calls thành 1
- Dùng `//go:nosplit` cho critical functions
- Cache CGo results phía Go khi có thể

## Serialization & Networking

```go
// Binary protocol cho game networking (nhẹ hơn JSON)
type PacketType byte

const (
    PacketMove PacketType = iota
    PacketShoot
    PacketDamage
    PacketSync
)

type Packet struct {
    Type      PacketType
    Timestamp int64
    Data      []byte
}

// Encode/Decode với encoding/binary
func (p *Packet) Encode() []byte {
    buf := make([]byte, 0, 9+len(p.Data))
    buf = append(buf, byte(p.Type))
    buf = binary.LittleEndian.AppendUint64(buf, uint64(p.Timestamp))
    buf = append(buf, p.Data...)
    return buf
}
```

## Testing game code

```go
// Table-driven tests cho game logic
func TestCollisionDetection(t *testing.T) {
    tests := []struct {
        name     string
        a, b     Rect
        expected bool
    }{
        {"overlap", Rect{0, 0, 10, 10}, Rect{5, 5, 10, 10}, true},
        {"no overlap", Rect{0, 0, 10, 10}, Rect{20, 20, 10, 10}, false},
        {"edge touch", Rect{0, 0, 10, 10}, Rect{10, 0, 10, 10}, false},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := Collides(tt.a, tt.b)
            if got != tt.expected {
                t.Errorf("Collides(%v, %v) = %v, want %v", tt.a, tt.b, got, tt.expected)
            }
        })
    }
}

// Benchmark cho performance-critical code
func BenchmarkMovementSystem(b *testing.B) {
    world := createTestWorld(10000) // 10k entities
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        world.MovementSystem(0.016)
    }
}
```

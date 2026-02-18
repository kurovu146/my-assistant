# Godot Engine (v4.x)

## Kiến thức cốt lõi

### Scene & Node system
- Mọi thứ trong Godot là Node, tổ chức theo cây (Scene Tree)
- Scene = tập hợp nodes có thể tái sử dụng (instancing)
- Ưu tiên composition hơn inheritance: ghép nhiều scene nhỏ thành scene lớn
- Mỗi scene nên có 1 root node phù hợp (Node2D, Control, CharacterBody2D...)

### GDScript patterns

```gdscript
# Signal pattern — loose coupling giữa các nodes
signal health_changed(new_value: int)

func take_damage(amount: int) -> void:
    health -= amount
    health_changed.emit(health)

# Export variables — chỉnh từ Inspector
@export var speed: float = 200.0
@export var jump_force: float = -400.0
@export_range(0, 100) var health: int = 100

# Onready — lấy reference đúng lúc
@onready var sprite: Sprite2D = $Sprite2D
@onready var anim: AnimationPlayer = $AnimationPlayer

# State machine pattern
enum State { IDLE, RUN, JUMP, FALL }
var current_state: State = State.IDLE

func _physics_process(delta: float) -> void:
    match current_state:
        State.IDLE: _state_idle(delta)
        State.RUN: _state_run(delta)
        State.JUMP: _state_jump(delta)
        State.FALL: _state_fall(delta)
```

### Physics & Movement

```gdscript
# CharacterBody2D movement template
extends CharacterBody2D

@export var speed: float = 300.0
@export var gravity: float = 980.0
@export var jump_force: float = -500.0

func _physics_process(delta: float) -> void:
    # Gravity
    if not is_on_floor():
        velocity.y += gravity * delta

    # Jump
    if Input.is_action_just_pressed("jump") and is_on_floor():
        velocity.y = jump_force

    # Horizontal
    var direction := Input.get_axis("move_left", "move_right")
    velocity.x = direction * speed

    move_and_slide()
```

### Scene management
- Autoload (singleton): dùng cho GameManager, AudioManager, SaveManager
- `get_tree().change_scene_to_file()` hoặc `change_scene_to_packed()`
- SceneTree groups: `add_to_group("enemies")`, `get_tree().get_nodes_in_group("enemies")`
- `call_deferred()` khi cần thay đổi scene tree trong process

### Resource & Data
- Custom Resource cho game data (items, stats, configs)
- `@export var item_data: ItemData` — drag & drop trong Inspector
- `ResourceLoader.load()` cho dynamic loading
- `.tres` (text) cho dev, `.res` (binary) cho production

### Animation
- AnimationPlayer cho complex sequences
- AnimationTree + StateMachine cho character animation
- Tween cho simple transitions: `create_tween().tween_property()`
- `await get_tree().create_timer(1.0).timeout` cho delays

### Input handling
- Input Map trong Project Settings
- `Input.is_action_pressed()` — giữ liên tục
- `Input.is_action_just_pressed()` — chỉ frame đầu
- `_unhandled_input()` cho game input, `_input()` cho UI input

## Best practices

- Dùng typed GDScript (static typing) cho performance và code clarity
- Signal up, call down: parent lắng nghe signal từ child, gọi method xuống child
- Tách logic và presentation: script xử lý logic, AnimationPlayer xử lý visual
- Dùng `class_name` để register custom types globally
- Preload vs Load: `preload()` lúc compile, `load()` lúc runtime
- Tránh `get_node()` với path dài, dùng `@onready` hoặc `%UniqueNode`
- Object pooling cho bullets, particles, enemies spawn nhiều
- Dùng TileMap cho level design 2D, GridMap cho 3D

## Debug tips

- Remote tab trong Scene dock: xem scene tree runtime
- `print_debug()` in kèm file + line number
- Debugger breakpoints trong script editor
- Performance monitor: `Engine.get_frames_per_second()`
- Physics debug: bật Visible Collision Shapes trong Debug menu

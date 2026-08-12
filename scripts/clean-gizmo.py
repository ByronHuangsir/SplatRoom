"""Remove old drawGrid, drawGizmo, pickGizmo, gizmoDrag and related state from merge-scene.ts."""
import re

p = r'C:\Users\Byon Huang\WorkBuddy\SplatRoom\src\merge\merge-scene.ts'
with open(p, encoding='utf-8') as f:
    s = f.read()

# 1. Remove drawGrid method (the whole thing - we use InfiniteGrid now)
s = re.sub(
    r'\n    /\*\* 在 XZ 平面.*?\n    private drawGrid\(\): void \{[^}]*?\n    \}\n',
    '\n',
    s,
    flags=re.DOTALL
)

# 2. Remove gizmoHit state variables
s = s.replace(
    '    /** 当前拖拽的 gizmo 手柄 */\n    private gizmoHit: string | null = null;\n    private gizmoHitStartX = 0;\n    private gizmoHitStartY = 0;\n\n',
    '\n'
)

# 3. Remove drawGizmo method
s = re.sub(
    r'\n    /\*\* 每帧绘制 gizmo.*?\n    private drawGizmo\(\): void \{[^}]*?\n    \}\n',
    '\n',
    s,
    flags=re.DOTALL
)

# 4. Remove pickGizmo method
s = re.sub(
    r'\n    /\*\* 拾取 gizmo 手柄.*?\n    private pickGizmo\([^)]+\): string \| null \{[^}]*?\n    \}\n',
    '\n',
    s,
    flags=re.DOTALL
)

# 5. Remove gizmoDrag method
s = re.sub(
    r'\n    /\*\* gizmo 拖拽.*?\n    private gizmoDrag\([^)]+\): void \{[^}]*?\n    \}\n',
    '\n',
    s,
    flags=re.DOTALL
)

# 6. Remove applyDragTransform method
s = re.sub(
    r'\n    /\*\*\n     \* 拖拽变换.*?\n    private applyDragTransform\([^)]+\): void \{[^}]*?\n    \}\n',
    '\n',
    s,
    flags=re.DOTALL
)

# 7. Clean up mouse handler references to gizmoHit/pickGizmo/dragModel/applyDragTransform
# Remove gizmo pick block in mousedown
s = re.sub(
    r'                    // gizmo 手柄优先拾取.*?\n                    if \(gizmoHit\) \{.*?\n                        return;\n                    \}\n',
    '',
    s,
    flags=re.DOTALL
)

# Remove gizmoDrag reference in mousemove
s = re.sub(
    r'            // gizmo 拖拽\n            if \(this\.gizmoHit && this\.activeButton === 0\) \{\n                this\.gizmoDrag\(this\.gizmoHit, dx, dy\);\n                return;\n            \}\n',
    '',
    s
)

# Remove dragModel transform reference in mousemove
s = re.sub(
    r'            // 拖拽变换.*?\n            if \(this\.dragModel && this\.activeButton === 0\) \{\n                this\.applyDragTransform\(this\.dragModel, e\.clientX, e\.clientY, dx, dy\);\n                return;\n            \}\n',
    '',
    s
)

# Remove gizmoHit = null from mouseup
s = s.replace('            this.gizmoHit = null;\n', '')

# Remove dragModel = null from mouseup
s = s.replace('            this.dragModel = null;\n', '')

with open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(s)

print('patched')

"""
Mascot animation source — run inside Blender (Blender MCP or Text Editor) with the
props file open (art/models/jungle-plinko-props.blend, objects "Mascot" + "MascotRig").

    exec(open("/path/to/scripts/blender/mascot_animations.py").read())

What it does (idempotent — safe to re-run after tweaking):
  1. Adds eyelid geometry + lid bones (upper lids blink/droop, lower lids "smile").
  2. Authors every action from eased key tracks (anticipation, arcs with apex hang,
     contact squash, overshoot recovery) instead of evenly spaced keys.
  3. Bakes secondary motion: ears and the tail chain are driven by a damped-spring
     simulation of the body's acceleration and spin, giving automatic follow-through
     and overlapping action, then layered on top of the authored poses.

Axis map (measured on this rig): lean/nod forward = +X (spine, neck, head);
head turn = Y, head tilt = Z; ears perk = +X, droop = -X; tail lift = +X, sink = -X,
side wag = Z; arm raise = +X; root (points up): vertical = loc Y, spin = rot Y,
squash = scale Y. Lid bones point down (upper) / up (lower): close = scale Y up.
"""
import math

import bmesh
import bpy
from mathutils import Vector

FPS = 24
RIG = bpy.data.objects["MascotRig"]
MESH = bpy.data.objects["Mascot"]

# ---------------------------------------------------------------------------
# Eyelids
# ---------------------------------------------------------------------------
# Iris centres/normals ray-cast on the model (Blender space: Z up, face towards -Y).
EYES = {
    "L": {"center": Vector((-0.0486, -0.5693, 0.659)), "normal": Vector((-0.4782, -0.8374, 0.2648)), "r": 0.0696},
    "R": {"center": Vector((0.1998, -0.5838, 0.6914)), "normal": Vector((0.2068, -0.8928, 0.4001)), "r": 0.0712},
}
LID_SLIVER = 0.04  # rest pose: lids are a thin band at the eye's edge (reads as a lash line)
LID_CLOSED = 1.0 / LID_SLIVER  # bone Y scale that unfolds a sliver into a full lid


def eye_frame(e):
    n = e["normal"].normalized()
    up = Vector((0, 0, 1))
    y = (up - n * up.dot(n)).normalized()
    x = y.cross(n)
    return x, y, n


def build_eyelids():
    # Remove previous lid objects/bones.
    if "MascotLids" in bpy.data.objects:
        bpy.data.objects.remove(bpy.data.objects["MascotLids"], do_unlink=True)
    bpy.context.view_layer.objects.active = RIG
    for s in bpy.context.selected_objects:
        s.select_set(False)
    RIG.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = RIG.data.edit_bones
    for name in [b.name for b in eb if b.name.startswith("lid")]:
        eb.remove(eb[name])

    bm = bmesh.new()
    groups = {}
    for side, e in EYES.items():
        x, y, n = eye_frame(e)
        R = e["r"] * 1.6
        centre = e["center"] + n * 0.016 - y * 0.008
        top, bottom = centre + y * R, centre - y * R
        for kind, pivot, direction in (("lid", top, -1), ("lidLow", bottom, 1)):
            name = f"{kind}.{side}"
            b = eb.new(name)
            b.head = pivot
            b.tail = pivot + y * (2 * R * direction)
            b.parent = eb["head"]
            # Curved disk hugging the head, squashed to a sliver at its pivot edge.
            verts = []
            for i in range(32):
                a = 2 * math.pi * i / 32
                lx, ly = math.cos(a) * R, math.sin(a) * R
                lz = -(lx * lx + ly * ly) / (2 * 0.22)
                pivot_y = R if kind == "lid" else -R
                ly = pivot_y + (ly - pivot_y) * LID_SLIVER
                verts.append(bm.verts.new(centre + x * lx + y * ly + n * lz))
            bm.faces.new(verts)
            groups[name] = verts
    bpy.ops.object.mode_set(mode="OBJECT")

    me = bpy.data.meshes.new("MascotLids")
    bm.verts.index_update()
    index_of = {v: v.index for v in bm.verts}
    group_indices = {name: [index_of[v] for v in vs] for name, vs in groups.items()}
    bm.to_mesh(me)
    bm.free()
    lids = bpy.data.objects.new("MascotLids", me)
    MESH.users_collection[0].objects.link(lids)
    for name, idx in group_indices.items():
        vg = lids.vertex_groups.new(name=name)
        vg.add(idx, 1.0, "REPLACE")
    lids.modifiers.new("Armature", "ARMATURE").object = RIG
    lids.parent = RIG
    mat = bpy.data.materials.get("LidMat") or bpy.data.materials.new("LidMat")
    mat.use_nodes = True
    bsdf = next(nd for nd in mat.node_tree.nodes if nd.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (0.07, 0.03, 0.015, 1)  # the painted dark-brown eye mask
    bsdf.inputs["Roughness"].default_value = 0.85
    me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = True
    for pb in RIG.pose.bones:
        pb.rotation_mode = "XYZ"


# ---------------------------------------------------------------------------
# Easing + key tracks
# ---------------------------------------------------------------------------
def ease(kind, t):
    t = min(max(t, 0.0), 1.0)
    if kind == "lin":
        return t
    if kind == "in":  # accelerate (falling)
        return t * t
    if kind == "out":  # decelerate (take-off, rising)
        return 1 - (1 - t) * (1 - t)
    if kind == "in3":
        return t * t * t
    if kind == "out3":
        return 1 - (1 - t) ** 3
    if kind == "hold":
        return 0.0 if t < 1 else 1.0
    if kind == "back":  # overshoot then settle
        s = 1.70158
        t -= 1
        return t * t * ((s + 1) * t + s) + 1
    return t * t * (3 - 2 * t)  # "io": smooth in/out


class Clip:
    """Channels are (bone, kind, axis) with kind in rot/loc/scale; keys are (frame, value, ease-to-next)."""

    def __init__(self, length):
        self.length = length
        self.tracks = {}
        self.funcs = []  # per-frame procedural layers: f(frame) -> {(bone, kind, axis): delta}

    def key(self, bone, kind, axis, frame, value, curve="io"):
        self.tracks.setdefault((bone, kind, axis), []).append((frame, value, curve))
        return self

    def pose(self, frame, curve="io", **bones):
        """pose(10, head=(x,y,z), spine=(x,y,z)) — rotations in degrees."""
        for bone, v in bones.items():
            bone = bone.replace("_", ".")
            for axis, val in enumerate(v):
                if val is not None:
                    self.key(bone, "rot", axis, frame, val, curve)
        return self

    def layer(self, fn):
        self.funcs.append(fn)
        return self

    def value(self, ch, f):
        keys = sorted(self.tracks[ch])
        if f <= keys[0][0]:
            return keys[0][1]
        for (f0, v0, c), (f1, v1, _) in zip(keys, keys[1:]):
            if f0 <= f <= f1:
                return v0 + (v1 - v0) * ease(c, (f - f0) / max(f1 - f0, 1e-6))
        return keys[-1][1]

    def evaluate(self, f):
        out = {ch: self.value(ch, f) for ch in self.tracks}
        for fn in self.funcs:
            for ch, d in fn(f).items():
                out[ch] = out.get(ch, 0.0) + d
        return out


# Volume-preserving squash around the feet (root bone Y is vertical).
def squash_channels(s):
    y = 1 - s
    x = 1 / math.sqrt(max(y, 0.3))
    return {("root", "scale", 0): x, ("root", "scale", 1): y, ("root", "scale", 2): x}


# ---------------------------------------------------------------------------
# Secondary motion: damped springs driven by body acceleration and spin
# ---------------------------------------------------------------------------
def spring_response(inputs, k, c, sub=8):
    x = v = 0.0
    out = []
    h = 1.0 / FPS / sub
    for u in inputs:
        for _ in range(sub):
            v += (k * (u - x) - c * v) * h
            x += v * h
        out.append(x)
    return out


def secondary(frames, cyclic):
    """frames: list of per-frame channel dicts (primary). Returns per-frame additive deltas."""
    n = len(frames)
    reps = 3 if cyclic else 1  # cyclic: simulate several loops and keep the last (steady state)
    seq = frames * reps

    def series(ch, default=0.0):
        return [fr.get(ch, default) for fr in seq]

    h = series(("root", "loc", 1))
    spin = series(("root", "rot", 1))
    head_x = series(("head", "rot", 0))
    head_z = series(("head", "rot", 2))
    spine_z = series(("spine", "rot", 2))
    sq = [1 - v for v in series(("root", "scale", 1), 1.0)]

    def deriv(a):
        return [(a[min(i + 1, len(a) - 1)] - a[max(i - 1, 0)]) * FPS / 2 for i in range(len(a))]

    acc = deriv(deriv(h))  # m/s²
    spin_v = deriv(spin)  # deg/s
    head_xv, head_zv = deriv(head_x), deriv(head_z)
    sq_v = deriv(sq)

    # Ears: lag behind vertical acceleration (rise → swept back/down, land → whip forward),
    # nods and squash velocity; side flop from head tilt velocity and spin.
    ear_x_in = [max(-45, min(45, -0.55 * a - 0.05 * hx - 30 * s)) for a, hx, s in zip(acc, head_xv, sq_v)]
    ear_z_in = [max(-30, min(30, -0.04 * hz - 0.02 * sv)) for hz, sv in zip(head_zv, spin_v)]
    ear_x = spring_response(ear_x_in, k=170, c=9)
    ear_z = spring_response(ear_z_in, k=140, c=8)

    # Tail: lifts/sinks against vertical acceleration, swings opposite to spin and sway.
    tail_x_in = [max(-35, min(35, -0.35 * a)) for a in acc]
    tail_z_in = [max(-40, min(40, -0.05 * sv - 0.8 * sz)) for sv, sz in zip(spin_v, spine_z)]
    t1x = spring_response(tail_x_in, k=90, c=7)
    t1z = spring_response(tail_z_in, k=80, c=6)

    def delayed(a, d, gain):
        return [gain * a[max(i - d, 0)] for i in range(len(a))]

    chain = {
        "tail.1": (t1x, t1z),
        "tail.2": (delayed(t1x, 2, 1.15), delayed(t1z, 2, 1.2)),
        "tail.3": (delayed(t1x, 4, 1.3), delayed(t1z, 4, 1.4)),
        "tail.4": (delayed(t1x, 6, 1.4), delayed(t1z, 6, 1.6)),
    }
    out = []
    start = n * (reps - 1)
    for i in range(start, start + n):
        d = {
            ("ear.L", "rot", 0): ear_x[i], ("ear.R", "rot", 0): ear_x[i],
            ("ear.L", "rot", 2): ear_z[i], ("ear.R", "rot", 2): -ear_z[i],
        }
        for bone, (cx, cz) in chain.items():
            d[(bone, "rot", 0)] = cx[i]
            d[(bone, "rot", 2)] = cz[i]
        out.append(d)
    return out


# ---------------------------------------------------------------------------
# Baking
# ---------------------------------------------------------------------------
def all_fcurves(act):
    if hasattr(act, "layers") and act.layers:
        return [fc for layer in act.layers for strip in layer.strips for bag in strip.channelbags for fc in bag.fcurves]
    return list(act.fcurves)


def bake(name, clip, cyclic=False, squash=None):
    frames = []
    for f in range(clip.length + 1):
        fr = clip.evaluate(f)
        if squash is not None:
            fr.update(squash_channels(squash(f)))
        frames.append(fr)
    sec = secondary(frames, cyclic)
    for fr, d in zip(frames, sec):
        for ch, v in d.items():
            fr[ch] = fr.get(ch, 0.0) + v

    act = bpy.data.actions.get(name)
    if act:
        bpy.data.actions.remove(act)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    RIG.animation_data_create()
    RIG.animation_data.action = act
    # Key every bone channel that moves anywhere in the clip; everything else is keyed at rest so
    # actions never inherit a pose from the previous one (e.g. a half-finished pirouette).
    moving = {ch for fr in frames for ch, v in fr.items()}
    for f, fr in enumerate(frames):
        for pb in RIG.pose.bones:
            b = pb.name
            if any((b, "rot", a) in moving for a in range(3)) or f in (0, clip.length):
                pb.rotation_euler = tuple(math.radians(fr.get((b, "rot", a), 0.0)) for a in range(3))
                pb.keyframe_insert("rotation_euler", frame=f, group=b)
            if any((b, "loc", a) in moving for a in range(3)) or f in (0, clip.length):
                pb.location = tuple(fr.get((b, "loc", a), 0.0) for a in range(3))
                pb.keyframe_insert("location", frame=f, group=b)
            if any((b, "scale", a) in moving for a in range(3)) or f in (0, clip.length):
                pb.scale = tuple(fr.get((b, "scale", a), 1.0) for a in range(3))
                pb.keyframe_insert("scale", frame=f, group=b)
    for fc in all_fcurves(act):
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"  # baked every frame: no extra easing between samples
        if cyclic:
            fc.modifiers.new("CYCLES")
    return act


def lid(clip, frame, upper=None, lower=None, curve="io"):
    """Lids in 0..1 (0 = open, 1 = fully closed) → lid bone Y scale."""
    for side in ("L", "R"):
        if upper is not None:
            clip.key(f"lid.{side}", "scale", 1, frame, 1 + upper * (LID_CLOSED - 1), curve)
        if lower is not None:
            clip.key(f"lidLow.{side}", "scale", 1, frame, 1 + lower * (LID_CLOSED - 1), curve)


def blink(clip, frame):
    lid(clip, frame - 1, upper=0.0, curve="in")
    lid(clip, frame + 2, upper=1.0, curve="hold")
    lid(clip, frame + 3, upper=1.0, curve="out")
    lid(clip, frame + 7, upper=0.0)


def sinus(amp, period, phase=0.0):
    return lambda f: amp * math.sin(2 * math.pi * f / period + phase)


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
def make_all():
    acts = {}

    # IDLE — 144 f (6 s) loop: breathing, a look around, blinks, ear twitches, a tail flick.
    c = Clip(144)
    c.pose(0, head=(0, 0, 0)).pose(30, head=(2, 10, 4)).pose(52, head=(2, 10, 4), curve="io")
    c.pose(74, head=(-2, -13, -4)).pose(96, head=(-2, -13, -4)).pose(118, head=(0, 0, 0)).pose(144, head=(0, 0, 0))
    for ear, f in (("ear_L", 56), ("ear_R", 120)):
        c.pose(f - 2, curve="out", **{ear: (0, 0, 0)}).pose(f, curve="io", **{ear: (22, 0, 0)})
        c.pose(f + 3, **{ear: (-9, 0, 0)}).pose(f + 7, **{ear: (3, 0, 0)}).pose(f + 11, **{ear: (0, 0, 0)})
    c.pose(0, tail_1=(0, 0, 0)).pose(126, tail_1=(0, 0, 0), curve="out").pose(129, tail_1=(10, 0, 18), curve="io").pose(140, tail_1=(0, 0, 0))
    c.pose(0, arm_R=(0, 0, 0)).pose(72, arm_R=(4, 0, 0)).pose(144, arm_R=(0, 0, 0))
    lid(c, 0, upper=0, lower=0)
    lid(c, 144, upper=0, lower=0)
    for f in (20, 98, 104):
        blink(c, f)
    breathe = sinus(1.6, 48)
    sway = sinus(10, 72)
    c.layer(lambda f: {("spine", "rot", 0): breathe(f), ("tail.2", "rot", 2): sway(f), ("tail.3", "rot", 2): sway(f - 6)})
    acts["idle"] = bake("idle", c, cyclic=True, squash=lambda f: 0.012 * math.sin(2 * math.pi * f / 48))

    # WAVE — 60 f: dip, raise, three friendly waves, smiling eyes, settle.
    c = Clip(60)
    c.pose(0, arm_R=(0, 0, 0), head=(0, 0, 0)).pose(5, arm_R=(-8, 0, 0), curve="out")
    c.pose(13, arm_R=(68, 0, 0), head=(-6, -14, 10), curve="io").pose(44, arm_R=(66, 0, 0), head=(-6, -14, 10))
    c.pose(56, arm_R=(0, 0, 0), head=(0, 0, 0), curve="io").pose(60, arm_R=(0, 0, 0), head=(0, 0, 0))
    paw = sinus(32, 10)
    c.layer(lambda f: {("paw.R", "rot", 0): paw(f) if 13 <= f <= 44 else 0.0, ("arm.R", "rot", 2): 0.0})
    lid(c, 0, upper=0, lower=0)
    lid(c, 10, lower=0.45)
    lid(c, 46, lower=0.45)
    lid(c, 56, lower=0)
    lid(c, 60, upper=0, lower=0)
    blink(c, 50)
    acts["wave"] = bake("wave", c, squash=lambda f: 0.06 * math.exp(-((f - 5) ** 2) / 8))

    # TENSION — 48 f loop: leaning in, ears perked, tail held up, nervous tremble, wide eyes.
    c = Clip(48)
    c.pose(0, spine=(14, 0, 0), neck=(10, 0, 0), head=(6, 0, 0), ear_L=(24, 0, 0), ear_R=(24, 0, 0), tail_1=(22, 0, 0))
    c.pose(48, spine=(14, 0, 0), neck=(10, 0, 0), head=(6, 0, 0), ear_L=(24, 0, 0), ear_R=(24, 0, 0), tail_1=(22, 0, 0))
    lid(c, 0, upper=0, lower=0)
    lid(c, 48, upper=0, lower=0)
    c.layer(lambda f: {("head", "rot", 2): 1.8 * math.sin(f * 2.3), ("spine", "rot", 2): 0.7 * math.sin(f * 1.7 + 1),
                       ("tail.4", "rot", 2): 3 * math.sin(f * 2.9)})
    acts["tension"] = bake("tension", c, cyclic=True, squash=lambda f: 0.05)

    # HAPPY — 48 f: crouch → take-off → apex hang → fall → contact squash → overshoot settle.
    c = Clip(48)
    h = Clip(48)  # root height track, evaluated separately for the squash timing
    for f, v, cv in ((0, 0, "io"), (5, 0, "out"), (9, 0.24, "out"), (15, 0.42, "io"), (18, 0.41, "in"), (23, 0, "hold"), (48, 0, "lin")):
        c.key("root", "loc", 1, f, v, cv)
    sq_keys = ((0, 0, "io"), (5, 0.2, "out"), (9, -0.18, "io"), (15, 0, "in"), (22, -0.08, "out"), (24, 0.18, "out"),
               (30, -0.05, "io"), (36, 0.02, "io"), (42, 0, "lin"), (48, 0, "lin"))
    for f, v, cv in sq_keys:
        h.key("root", "sq", 0, f, v, cv)
    c.pose(0, head=(0, 0, 0), arm_R=(0, 0, 0)).pose(5, head=(8, 0, 0), arm_R=(-6, 0, 0))
    c.pose(12, head=(-12, 0, 6), arm_R=(72, 0, 0), curve="out").pose(20, head=(-10, 0, 6), arm_R=(68, 0, 0))
    c.pose(25, head=(7, 0, -4), arm_R=(35, 0, 0), curve="out").pose(32, head=(-2, 0, 2), arm_R=(12, 0, 0))
    c.pose(42, head=(0, 0, 0), arm_R=(0, 0, 0)).pose(48, head=(0, 0, 0), arm_R=(0, 0, 0))
    lid(c, 0, upper=0, lower=0)
    lid(c, 6, lower=0.0)
    lid(c, 11, lower=0.55)
    lid(c, 36, lower=0.55)
    lid(c, 44, lower=0)
    lid(c, 48, upper=0, lower=0)
    wag = sinus(24, 7)
    c.layer(lambda f: {("tail.2", "rot", 2): wag(f) * min(1, max(0, (f - 6) / 4)) * min(1, max(0, (42 - f) / 6))})
    acts["happy"] = bake("happy", c, squash=lambda f: h.value(("root", "sq", 0), f))

    # BIG WIN — 84 f: deep crouch, high jump with a full pirouette, hang, landing, victory pumps.
    c = Clip(84)
    s = Clip(84)
    for f, v, cv in ((0, 0, "io"), (7, 0, "out"), (11, 0.32, "out"), (19, 0.7, "io"), (23, 0.68, "in"), (29, 0, "hold"),
                     (48, 0, "out"), (51, 0.1, "in"), (54, 0, "hold"), (60, 0, "out"), (63, 0.1, "in"), (66, 0, "hold"), (84, 0, "lin")):
        c.key("root", "loc", 1, f, v, cv)
    for f, v, cv in ((0, 0, "io"), (9, 0, "io"), (30, 360, "hold"), (84, 360, "lin")):
        c.key("root", "rot", 1, f, v, cv)
    for f, v, cv in ((0, 0, "io"), (7, 0.26, "out"), (11, -0.24, "io"), (19, 0, "in"), (28, -0.07, "out"), (30, 0.22, "out"),
                     (37, -0.07, "io"), (43, 0.02, "io"), (48, 0, "out"), (50, -0.06, "in"), (54, 0.1, "out"), (58, 0, "io"),
                     (62, -0.06, "in"), (66, 0.1, "out"), (72, 0, "io"), (84, 0, "lin")):
        s.key("root", "sq", 0, f, v, cv)
    c.pose(0, head=(0, 0, 0), arm_R=(0, 0, 0), spine=(0, 0, 0)).pose(7, head=(10, 0, 0), arm_R=(-8, 0, 0), spine=(6, 0, 0))
    c.pose(14, head=(-14, 0, 0), arm_R=(82, 0, 0), spine=(-6, 0, 0), curve="out").pose(26, head=(-10, 0, 0), arm_R=(78, 0, 0), spine=(0, 0, 0))
    c.pose(31, head=(6, 0, 0), arm_R=(30, 0, 0), spine=(4, 0, 0), curve="out")
    for i, f in enumerate(range(40, 73, 8)):  # victory pumps alternating tilt
        side = 1 if i % 2 == 0 else -1
        c.pose(f, head=(-8, 0, 12 * side), arm_R=(76, 0, 0), spine=(0, 0, 7 * side), curve="out")
        c.pose(f + 4, head=(-6, 0, 8 * side), arm_R=(38, 0, 0), spine=(0, 0, 4 * side))
    c.pose(84, head=(0, 0, 0), arm_R=(0, 0, 0), spine=(0, 0, 0))
    lid(c, 0, upper=0, lower=0)
    lid(c, 8, lower=0.0)
    lid(c, 14, lower=0.6)
    lid(c, 76, lower=0.6)
    lid(c, 84, upper=0, lower=0)
    wag = sinus(30, 6)
    c.layer(lambda f: {("tail.2", "rot", 2): wag(f) if 31 <= f <= 78 else 0.0})
    acts["bigWin"] = bake("bigWin", c, squash=lambda f: s.value(("root", "sq", 0), f))

    # SAD — 72 f: slump with droopy lids, hold, a big sigh, then shake it off.
    c = Clip(72)
    s = Clip(72)
    slump = dict(spine=(14, 0, -5), neck=(16, 0, 0), head=(19, 7, -12), ear_L=(-42, 0, 0), ear_R=(-42, 0, 0), tail_1=(-26, 0, 0))
    c.pose(0, spine=(0, 0, 0), neck=(0, 0, 0), head=(0, 0, 0), ear_L=(0, 0, 0), ear_R=(0, 0, 0), tail_1=(0, 0, 0))
    c.pose(14, curve="io", **slump).pose(34, **slump)
    c.pose(40, spine=(6, 0, -2), neck=(10, 0, 0), head=(10, 4, -6), ear_L=(-30, 0, 0), ear_R=(-30, 0, 0), tail_1=(-18, 0, 0))  # inhale
    c.pose(48, curve="io", **slump)  # exhale
    c.pose(56, spine=(-2, 0, 0), neck=(0, 0, 0), head=(-3, 8, 2), ear_L=(4, 0, 0), ear_R=(4, 0, 0), tail_1=(0, 0, 0))
    c.pose(60, head=(-2, -8, -2)).pose(64, head=(-1, 5, 1)).pose(72, spine=(0, 0, 0), neck=(0, 0, 0), head=(0, 0, 0), ear_L=(0, 0, 0), ear_R=(0, 0, 0), tail_1=(0, 0, 0))
    for f, v, cv in ((0, 0, "io"), (14, 0.1, "io"), (34, 0.1, "io"), (40, -0.03, "io"), (48, 0.12, "io"), (56, -0.03, "io"), (64, 0, "io"), (72, 0, "lin")):
        s.key("root", "sq", 0, f, v, cv)
    lid(c, 0, upper=0, lower=0)
    lid(c, 8, upper=0.0)
    lid(c, 16, upper=0.5)
    lid(c, 48, upper=0.55)
    lid(c, 58, upper=0.0)
    lid(c, 72, upper=0, lower=0)
    acts["sad"] = bake("sad", c, squash=lambda f: s.value(("root", "sq", 0), f))
    return acts


build_eyelids()
ACTIONS = make_all()
RIG.animation_data.action = ACTIONS["idle"]
print("mascot animations:", {k: int(a.frame_range[1]) for k, a in ACTIONS.items()})

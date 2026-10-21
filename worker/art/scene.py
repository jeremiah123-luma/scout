# Scout background art, modeled in code: a striped lighthouse at night (dark theme) and a warm sun (light theme).
# Run: blender -b --python scene.py -- <lighthouse|sun> <out.png>
import bpy, sys, math

which, out = sys.argv[sys.argv.index("--") + 1:][:2]
brand = which == "lighthouse-brand"
if brand:
    which = "lighthouse"
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 96
scene.cycles.use_denoising = True
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "AgX"
scene.render.filepath = out


def mat(name, color, rough=0.5, emit=None, strength=0.0, alpha=1.0, transmission=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = strength
    if transmission:
        b.inputs["Transmission Weight"].default_value = transmission
    return m


def put(obj, m):
    obj.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    return obj


def world(color, strength):
    w = bpy.data.worlds.new("w")
    scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (*color, 1)
    bg.inputs[1].default_value = strength


if which == "lighthouse":
    scene.render.resolution_x, scene.render.resolution_y = 800, 1400
    world((0.05, 0.06, 0.16), 0.6)
    red = mat("red", (0.62, 0.08, 0.07), 0.45) if not brand else mat("navy", (0.035, 0.025, 0.09), 0.4)
    white = mat("white", (0.86, 0.84, 0.78), 0.5) if not brand else mat("cream", (0.88, 0.92, 0.66), 0.5)
    dark = mat("dark", (0.04, 0.035, 0.06), 0.35)
    rock = mat("rock", (0.09, 0.09, 0.12), 0.9)
    glass = mat("lamp", (1, 0.85, 0.5), 0.1, emit=(1, 0.78, 0.38), strength=18)

    # rocks at the foot
    for x, y, s in [(-0.9, 0.2, 1.1), (0.8, -0.1, 0.9), (0.1, 0.6, 1.0), (-0.3, -0.7, 0.8), (1.3, 0.6, 0.6)]:
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=s, location=(x, y, -0.25))
        o = bpy.context.object
        o.scale = (1.2, 1.0, 0.55)
        o.rotation_euler = (0.2 * x, 0.3 * y, x)
        o.data.materials.append(rock)

    # the tower: six stacked bands, red and white, narrowing as it rises
    h, r0, r1, bands = 6.0, 1.15, 0.72, 6
    for i in range(bands):
        z0, z1 = h * i / bands, h * (i + 1) / bands
        ra, rb = r0 + (r1 - r0) * i / bands, r0 + (r1 - r0) * (i + 1) / bands
        bpy.ops.mesh.primitive_cone_add(vertices=64, radius1=ra, radius2=rb, depth=z1 - z0, location=(0, 0, (z0 + z1) / 2 + 0.2))
        put(bpy.context.object, red if i % 2 == 0 else white)
    top = h + 0.2
    # a small window on the white bands
    for z in (2.2, 4.2):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -0.98 + 0.13 * (z - 2.2) / 2, z))
        o = bpy.context.object
        o.scale = (0.14, 0.05, 0.22)
        o.data.materials.append(mat("win", (1, 0.8, 0.45), 0.2, emit=(1, 0.72, 0.35), strength=4))

    # gallery deck and railing
    bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=1.02, depth=0.14, location=(0, 0, top + 0.07))
    put(bpy.context.object, dark)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.98, minor_radius=0.025, location=(0, 0, top + 0.42))
    put(bpy.context.object, dark)
    for k in range(16):
        a = 2 * math.pi * k / 16
        bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.018, depth=0.36, location=(0.98 * math.cos(a), 0.98 * math.sin(a), top + 0.25))
        bpy.context.object.data.materials.append(dark)

    # lantern room: glowing glass with dark mullions, a red roof and a ball on top
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.56, depth=0.85, location=(0, 0, top + 0.57))
    put(bpy.context.object, glass)
    for k in range(8):
        a = 2 * math.pi * k / 8
        bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=0.03, depth=0.86, location=(0.57 * math.cos(a), 0.57 * math.sin(a), top + 0.57))
        bpy.context.object.data.materials.append(dark)
    bpy.ops.mesh.primitive_cone_add(vertices=64, radius1=0.74, radius2=0.05, depth=0.62, location=(0, 0, top + 1.3))
    put(bpy.context.object, red if not brand else mat("gold", (1.0, 0.62, 0.08), 0.35))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.09, location=(0, 0, top + 1.66))
    put(bpy.context.object, dark)

    # light: a cool moon from the left, the lamp inside, a faint warm fill on the tower
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(55), 0, math.radians(-50)))
    bpy.context.object.data.energy = 1.6
    bpy.context.object.data.color = (0.6, 0.7, 1.0)
    bpy.ops.object.light_add(type="POINT", location=(0, 0, top + 0.57))
    bpy.context.object.data.energy = 900
    bpy.context.object.data.color = (1, 0.75, 0.4)
    bpy.ops.object.light_add(type="AREA", location=(3, -4, 2))
    bpy.context.object.data.energy = 120
    bpy.context.object.data.size = 4
    bpy.context.object.data.color = (0.5, 0.55, 1.0)
    bpy.context.object.rotation_euler = (math.radians(70), 0, math.radians(35))

    bpy.ops.object.camera_add(location=(0, -16, 3.6), rotation=(math.radians(88), 0, 0))
    cam = bpy.context.object
    cam.data.lens = 50
    scene.camera = cam

else:  # the sun: a warm glowing ball with a soft, slightly mottled face
    scene.render.resolution_x, scene.render.resolution_y = 900, 900
    scene.view_settings.view_transform = "Standard"  # AgX washes a bright emitter out to beige
    world((0, 0, 0), 0)
    m = bpy.data.materials.new("sun")
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 3.5
    noise.inputs["Detail"].default_value = 6
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (1.0, 0.32, 0.02, 1)
    ramp.color_ramp.elements[1].color = (1.0, 0.78, 0.12, 1)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Emission Color"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Emission Strength"].default_value = 0.95
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, radius=1.0)
    o = bpy.context.object
    o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    bpy.ops.object.camera_add(location=(0, -5.2, 0), rotation=(math.radians(90), 0, 0))
    scene.camera = bpy.context.object

bpy.ops.render.render(write_still=True)

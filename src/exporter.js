// Export: the model (with any added bones and the baked clips) as GLB, a Procemotion config (JSON),
// and a Python script that builds the runtime Control Rig inside Unreal Engine from that config.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { buildFBX } from './fbx.js';

/**
 * Export as GLB. With `refPose`, a copy of the model is re-bound in that pose first, so the file's bind pose
 * (which UE uses as the skeleton's reference pose, and the Locomotor starts from) is the standing pose —
 * not whatever the original rig was bound in (some rips are bound lying down). The live model is untouched.
 */
export async function exportGLB(creature, clips, refPose = null) {
  const pose = creature.snapshot();
  let root = creature.root;
  try {
    if (refPose && creature.meshes.length) root = rebindCopy(creature, refPose);
    else { creature.restore(); creature.update(); }
    const exporter = new GLTFExporter();
    const data = await exporter.parseAsync(root, { binary: true, animations: clips, onlyVisible: false });
    return new Blob([data], { type: 'model/gltf-binary' });
  } finally {
    creature.applySnapshot(pose);
    creature.update();
  }
}

/**
 * Export as binary FBX (cm, Y up): the same model, skeleton, bind pose and clips as the GLB, with the textures
 * embedded. cm = centimetres per model unit (the GLB path gets the same size from UE's metre -> cm conversion).
 */
export async function exportFBX(creature, clips, refPose, cm) {
  const pose = creature.snapshot();
  try {
    // a detached copy: world matrices then are relative to the model itself (the live one rides on the mover)
    let root;
    if (refPose && creature.meshes.length) root = rebindCopy(creature, refPose);
    else { creature.restore(); creature.update(); root = SkeletonUtils.clone(creature.root); }
    const { bytes, stats } = await buildFBX(root, clips, cm, (creature.name || 'creature').replace(/[^\w-]+/g, '_'));
    return { blob: new Blob([bytes], { type: 'application/octet-stream' }), stats };
  } finally {
    creature.applySnapshot(pose);
    creature.update();
  }
}

/** Bones of a hierarchy in the same order Creature.collectBones uses (tree order, plus skeleton bones). */
function bonesOf(root) {
  const set = new Set();
  root.traverse((o) => { if (o.isBone) set.add(o); });
  root.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.bones.forEach((b) => set.add(b)); });
  const list = [];
  root.traverse((o) => { if (set.has(o)) list.push(o); });
  return list;
}

/** A copy of the model whose meshes are baked into `refPose` and bound there (positions, normals, tangents). */
export function rebindCopy(creature, refPose) {
  const copy = SkeletonUtils.clone(creature.root);
  // the clone shares inverse-bind matrices with the original: give it its own before rebinding
  const skels = new Set();
  copy.traverse((o) => { if (o.isSkinnedMesh) skels.add(o.skeleton); });
  for (const sk of skels) sk.boneInverses = sk.boneInverses.map((m) => m.clone());
  const bones = bonesOf(copy);
  bones.forEach((b, i) => { const s = refPose[i]; if (s) { b.position.copy(s.p); b.quaternion.copy(s.q); b.scale.copy(s.s); } });
  copy.updateMatrixWorld(true);
  const meshes = [];
  copy.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  for (const sk of skels) sk.update();
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const M = new THREE.Matrix4(), S = new THREE.Matrix4(), B = new THREE.Matrix4(), N = new THREE.Matrix3();
  for (const mesh of meshes) {
    const g = mesh.geometry.clone();
    mesh.geometry = g;
    const pos = g.attributes.position, nrm = g.attributes.normal, tan = g.attributes.tangent;
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const bm = mesh.skeleton.boneMatrices;
    const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      mesh.getVertexPosition(i, v); // skinned, in mesh space
      v.toArray(out, i * 3);
      if (!nrm && !tan) continue;
      // blended skin matrix in mesh space: bindMatrixInverse * sum(w * boneMatrix) * bindMatrix
      S.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (!w) continue;
        B.fromArray(bm, si.getComponent(i, k) * 16);
        for (let e = 0; e < 16; e++) S.elements[e] += B.elements[e] * w;
      }
      M.copy(mesh.bindMatrixInverse).multiply(S).multiply(mesh.bindMatrix);
      N.setFromMatrix4(M);
      if (nrm) { n.fromBufferAttribute(nrm, i).applyMatrix3(N).normalize(); nrm.setXYZ(i, n.x, n.y, n.z); }
      if (tan) { n.set(tan.getX(i), tan.getY(i), tan.getZ(i)).applyMatrix3(N).normalize(); tan.setXYZ(i, n.x, n.y, n.z); }
    }
    pos.array.set(out);
    pos.needsUpdate = true;
    // morph targets were relative to the old shape; they would no longer line up
    g.morphAttributes = {};
    mesh.morphTargetInfluences = undefined; mesh.morphTargetDictionary = undefined;
  }
  // bind where the bones are now (inverses from the current pose, bind matrix = mesh world)
  for (const mesh of meshes) mesh.bind(mesh.skeleton);
  return copy;
}

/** The deepest bone that is an ancestor of (or equal to) both a and b. */
function lowestCommonBone(a, b) {
  const up = new Set();
  for (let x = a; x; x = x.parent) up.add(x);
  for (let x = b; x; x = x.parent) if (up.has(x) && x.isBone) return x;
  return null;
}

/** Everything UE needs, in UE units (cm). scale = cm per model unit. */
export function buildConfig({ creature, info, motion, footSets, clips, scale, addedChains }) {
  const P = motion.params;
  const L = motion.legLen;
  const cm = (v) => +(v * scale).toFixed(3);
  const r3 = (v) => +(+v).toFixed(3);
  const legs = motion.legs;
  const D2R = Math.PI / 180;
  const allFours = !!(motion.allFours && P.movement.allFours !== false && P.movement.runStyle === 'gallop');
  // UE's Locomotor moves only its pelvis bone. When the spine is not under the pelvis (Hips and Spine siblings
  // under a Waist bone) the upper body would stay behind, so it drives the bone that carries both.
  const locoPelvis = info.pelvis && info.head ? lowestCommonBone(info.pelvis, info.head) || info.pelvis : info.pelvis;
  return {
    tool: 'Procemotion', version: 1,
    model: creature.name,
    units: { cmPerModelUnit: scale, heightCm: cm(info.H), legLengthCm: cm(L) },
    forward: info.frame.key,
    style: info.style,
    pelvisBone: info.pelvis ? info.pelvis.name : null,
    headBone: info.head ? info.head.name : null,
    spineBones: info.spine.map((b) => b.name),
    limbs: info.limbs.map((l) => ({
      id: l.id, label: l.label, type: l.type, side: l.side,
      bones: l.bones.map((b) => b.name),
      ikBones: l.type === 'leg' ? l.bones.slice(l.ikStart, l.effector + 1).map((b) => b.name) : undefined,
      effector: l.type === 'leg' ? l.bones[l.effector].name : undefined,
      // a serpent's tail is part of its body (driven by the baked clips), so it gets no spring of its own
      dynamics: l.dyn && l.dyn.on && ['ear', 'tail', 'tentacle', 'appendage'].includes(l.type)
        && !(motion.snake && l.bones.some((b) => motion.snake.set.has(b))) ? { ...l.dyn } : undefined,
    })),
    partSwap: motion.swapList().map((x) => ({ bone: x.bone.name, showIn: x.show })),
    // collision volume detected from the mesh: one capsule per bone (cm)
    collision: [...(info.capsules || new Map())].map(([b, c]) => ({ bone: b.name, radiusCm: cm(c.radius * P.collision.scale), lengthCm: cm(c.length) })),
    // keep the body's volume out of the ground: lift `root` by the deepest penetration of these capsules
    bodyLift: P.collision.on && info.capsules && motion.liftRoot ? {
      root: motion.liftRoot.name,
      bones: motion.bodyBones.filter((b) => info.capsules.get(b)).map((b) => ({ bone: b.name, radiusCm: cm(info.capsules.get(b).radius * P.collision.scale) })),
    } : undefined,
    // chains that collide with the ground; joints with hug > 0.5 lie on it at clearCm over the local terrain
    groundChains: P.collision.on ? motion.chains.filter((c) => c.limb.dyn && c.limb.dyn.on && c.limb.dyn.collide).map((c) => {
      const R = motion.jointRadii(c);
      return {
        label: c.limb.label, bones: c.bones.map((b) => b.name),
        hug: c.bones.map((_, i) => r3(c.hug[i] || 0)), clearCm: c.bones.map((_, i) => cm(c.clear[i])), radiusCm: c.bones.map((_, i) => cm(R[i])),
      };
    }) : [],
    locomotor: {
      pelvisBone: locoPelvis ? locoPelvis.name : null,
      footSets: footSets.map((s) => ({
        phaseOffset: r3((1 - s.offset) % 1),
        feet: s.feet.map((id) => {
          const leg = legs.find((g) => g.limb.id === id);
          return leg ? { ankleBone: leg.eff.name, ikBones: leg.joints.map((j) => j.name), collisionRadiusCm: cm(P.stepping.footRadius * L) } : null;
        }).filter(Boolean),
      })).filter((s) => s.feet.length),
      // gallop for the running rig: every foot in a set of its own at its exact phase (UE's Locomotor keeps two feet
      // of one set half a stride apart, and its built-in movement styles are not implemented yet)
      // (UE's Locomotor lifts feet in the opposite phase order to Procemotion - measured in a Play session - so the
      // offsets are mirrored: 1 - offset keeps the same leading leg)
      // (arms join as front feet when the creature drops onto all fours - see allFours)
      footSetsRun: legs.length >= 2 && legs.length <= 4 && P.movement.runStyle === 'gallop' ? legs.filter((leg) => !leg.armLeg || allFours).map((leg) => ({
        phaseOffset: r3((1 - (leg.gallopOffset ?? 0)) % 1),
        feet: [{
          ankleBone: leg.eff.name, ikBones: leg.joints.map((j) => j.name), collisionRadiusCm: cm(P.stepping.footRadius * L),
          ...(leg.armLeg ? { arm: true, armLenCm: cm(leg.legLen), handHeightCm: cm(leg.effHeight) } : {}),
        }],
      })) : undefined,
      // two legs + two arms: when running, the upper body pitches forward about `upper` by thetaDeg and the hands
      // become front feet (a bear dropping onto all fours); the head turns back up by headCounter of that angle
      allFours: allFours ? { upper: motion.allFours.upper.name, thetaDeg: r3(motion.allFours.theta / D2R), headCounter: 0.85 } : undefined,
      runAir: r3(Math.min(0.9, Math.max(P.stepping.air + P.stepping.airExt, 0.65))),
      movement: {
        minimumStepLength: cm(P.movement.minStep * L),
        speedMax: cm(P.movement.maxSpeed * motion.unit), speedMin: cm(P.movement.maxSpeed * motion.unit * 0.25),
        phaseSpeedMax: r3(P.movement.phaseMax), phaseSpeedMin: r3(P.movement.phaseMin),
        acceleration: cm(P.movement.accel * motion.unit), deceleration: cm(P.movement.decel * motion.unit),
      },
      stepping: {
        percentOfStrideInAir: r3(P.stepping.air), airExtensionAtMaxSpeed: r3(P.stepping.airExt),
        stepHeight: cm(P.stepping.stepHeight * L), stepEaseIn: r3(P.stepping.easeIn), stepEaseOut: r3(P.stepping.easeOut),
        enableGroundCollision: !!P.stepping.groundCollision, maxCollisionHeight: cm(P.stepping.maxCollision * L),
        orientFootToGroundPitch: r3(P.stepping.footPitch), orientFootToGroundRoll: r3(P.stepping.footRoll),
      },
      pelvis: {
        positionDampingHalfLife: r3(P.pelvis.halfLife), bobOffset: -cm(P.pelvis.bob * L), leadAmount: r3(1 + P.pelvis.lead * 20),
        // UE: positive for quadrupeds, negative for bipeds
        orientToGroundPitch: r3((motion.quadLike ? 1 : -0.4) * P.pelvis.pitch), orientToGroundRoll: r3((motion.quadLike ? 1 : -0.4) * P.pelvis.roll),
      },
    },
    flight: info.hasWings ? { ...P.flight } : undefined,
    addedBones: addedChains.map((c) => ({ type: c.type, parent: c.parent, bones: c.bones })),
    clips: clips.map((c) => ({ name: c.name, seconds: r3(c.duration), loop: !!(c.userData && c.userData.loop) })),
  };
}

export function ueScript(config) {
  const json = JSON.stringify(config, null, 1);
  return `# Procemotion -> Unreal Engine 5.8: builds a procedural Control Rig for "${config.model}".
#
# 1. Enable plugins (Edit > Plugins): "Locomotor" (Experimental), "Python Editor Script Plugin". Control Rig is on by default.
# 2. Import ${config.model}.glb or ${config.model}.fbx (drag it into the Content Browser; for the FBX keep
#    "Import Animations" on). Check the size: the creature should be about ${config.units.heightCm} cm tall.
# 3. Select the imported Skeletal Mesh in the Content Browser, then Tools > Execute Python Script... > this file.
# 4. Quick look: drag BP_${config.model}_Procemotion (created next to the rig) into a level and press Play.
#    It walks a circle with the rig running and puts its feet on whatever is below them.
#    BP_${config.model}_Procemotion_Run gallops (rig ${config.model}_Procemotion_Run: each pair of legs moves together${config.locomotor.allFours ? ';\n#    the upper body bends forward and the hands run as front feet, like a bear dropping onto all fours' : ''}).
#    In an Anim Blueprint, blend the two Control Rig nodes by speed.
# 5. In your own character: Anim Blueprint AnimGraph -> (idle / locomotion pose) -> "Control Rig" node
#    (pick ${config.model}_Procemotion) -> Output Pose, and move the character with CharacterMovement.

import json
import math
import unreal

CFG = json.loads(r'''${json}''')

def log(msg):
    unreal.log('[Procemotion] ' + msg)

def warn(msg):
    unreal.log_warning('[Procemotion] ' + msg)

def bone(name):
    return '(Type=Bone,Name="%s")' % name

def vec(x, y, z):
    return '(X=%f,Y=%f,Z=%f)' % (x, y, z)

def find_mesh():
    try:
        for a in unreal.EditorUtilityLibrary.get_selected_assets():
            if isinstance(a, unreal.SkeletalMesh):
                return a
    except Exception:
        pass
    # nothing selected: a skeletal mesh named like the model, or inside a folder named like it
    want = CFG['model'].lower()
    reg = unreal.AssetRegistryHelpers.get_asset_registry()
    for data in reg.get_assets_by_class(unreal.TopLevelAssetPath('/Script/Engine', 'SkeletalMesh')):
        name = str(data.asset_name).lower()
        path = str(data.package_path).lower()
        if want in name or ('/' + want) in path:
            return data.get_asset()
    return None

class Graph:
    def __init__(self, rig):
        self.rig = rig
        self.c = rig.get_controller_by_name('RigVMModel') or rig.get_controller()
        self.x = 400
        self.prev = None
        for n in self.c.get_graph().get_nodes():
            s = n.get_script_struct() if hasattr(n, 'get_script_struct') else None
            if s and s.get_name() == 'RigUnit_BeginExecution':
                self.prev = n.get_node_path()
        if not self.prev:
            node = self.c.add_unit_node_from_struct_path('/Script/ControlRig.RigUnit_BeginExecution', 'Execute', unreal.Vector2D(0, 0), 'BeginExecution')
            self.prev = node.get_node_path()

    def unit(self, path, name, y=0):
        node = self.c.add_unit_node_from_struct_path(path, 'Execute', unreal.Vector2D(self.x, y), name)
        if node is None:
            raise RuntimeError('could not add ' + path + ' (is its plugin enabled?)')
        self.x += 360
        n = node.get_node_path()
        self.link(self.prev + '.ExecuteContext', n + '.ExecuteContext')
        self.prev = n
        return n

    def link(self, a, b):
        try:
            if self.c.add_link(a, b):
                return True
        except Exception as e:
            warn('link %s -> %s failed: %s' % (a, b, e))
            return False
        warn('could not link %s -> %s' % (a, b))
        return False

    def set(self, pin, value):
        try:
            ok = self.c.set_pin_default_value(pin, str(value), True)
        except Exception as e:
            ok = False
        if not ok:
            warn('could not set ' + pin + ' = ' + str(value))

    def array_at(self, array_pin, index, name, y):
        """An "At" node reading one element of an output array; returns its Element pin path."""
        node = None
        for notation in ('DISPATCH_RigVMDispatch_ArrayGetAtIndex(in Array,in Index,out Element)',
                         'DISPATCH_RigVMDispatch_ArrayGetAtIndex(io Array,in Index,out Element)'):
            try:
                node = self.c.add_template_node(notation, unreal.Vector2D(self.x - 200, y), name)
            except Exception:
                node = None
            if node:
                break
        if not node:
            warn('could not add an array "At" node')
            return None
        n = node.get_node_path()
        if not self.link(array_pin, n + '.Array'):
            return None
        self.set(n + '.Index', index)
        return n + '.Element'

    # ---- pure (data) nodes: no execution wire, evaluated when a later node needs them
    def node(self, path, name):
        self.k = getattr(self, 'k', 0) + 1
        node = self.c.add_unit_node_from_struct_path(path, 'Execute', unreal.Vector2D(self.x - 260, 600 + 90 * (self.k % 12)), name)
        if node is None:
            raise RuntimeError('could not add ' + path)
        return node.get_node_path()

    def uid(self, base):
        self.u = getattr(self, 'u', 0) + 1
        return '%s_%d' % (base, self.u)

    def bone_pos(self, b):
        n = self.node('/Script/ControlRig.RigUnit_GetTransform', self.uid('PM_Get_' + b))
        self.set(n + '.Item', bone(b))
        self.set(n + '.Space', 'GlobalSpace')
        return n + '.Transform.Translation'

    def vadd(self, a_pin, b_pin=None, b_const=None):
        n = self.node('/Script/RigVM.RigVMFunction_MathVectorAdd', self.uid('PM_VAdd'))
        self.link(a_pin, n + '.A')
        if b_pin: self.link(b_pin, n + '.B')
        else: self.set(n + '.B', vec(*b_const))
        return n + '.Result'

    def z_of(self, v_pin):
        n = self.node('/Script/RigVM.RigVMFunction_MathVectorDot', self.uid('PM_Z'))
        self.link(v_pin, n + '.A')
        self.set(n + '.B', vec(0, 0, 1))
        return n + '.Result'

    def fop(self, op, a_pin, b_pin=None, b_const=None):
        n = self.node('/Script/RigVM.RigVMFunction_MathFloat' + op, self.uid('PM_' + op))
        self.link(a_pin, n + '.A')
        if b_pin: self.link(b_pin, n + '.B')
        else: self.set(n + '.B', b_const)
        return n + '.Result'

    def fselect(self, cond_pin, true_pin, false_const):
        n = self.node('/Script/RigVM.RigVMFunction_MathFloatSelectBool', self.uid('PM_Select'))
        self.link(cond_pin, n + '.Condition')
        self.link(true_pin, n + '.IfTrue')
        self.set(n + '.IfFalse', false_const)
        return n + '.Result'

    def up_by(self, z_pin):
        n = self.node('/Script/RigVM.RigVMFunction_MathVectorMake', self.uid('PM_Up'))
        self.set(n + '.X', 0)
        self.set(n + '.Y', 0)
        self.link(z_pin, n + '.Z')
        return n + '.Result'

    def trace_down(self, start_pin, end_pin, radius):
        n = self.node('/Script/ControlRig.RigUnit_SphereTraceByTraceChannel', self.uid('PM_Trace'))
        self.link(start_pin, n + '.Start')
        self.link(end_pin, n + '.End')
        self.set(n + '.Radius', max(0.1, radius))
        self.set(n + '.TraceChannel', 'TraceTypeQuery1')
        return n

def build_body_lift(g):
    """Keep the body's volume out of the ground: under every body capsule trace down to the ground; the deepest
    penetration lifts the whole body (the legs' IK runs after this and still reaches the ground)."""
    bl = CFG.get('bodyLift')
    if not bl or not bl.get('bones'):
        return 0
    H = CFG['units']['heightCm']
    best = None
    for b in bl['bones']:
        r = b['radiusCm']
        p = g.bone_pos(b['bone'])
        tr = g.trace_down(g.vadd(p, b_const=(0, 0, r + 0.3 * H)), g.vadd(p, b_const=(0, 0, -0.6 * H)), 0.6 * r)
        # penetration = ground under it + 85 % of its radius - its height
        pen = g.fop('Sub', g.fop('Add', g.z_of(tr + '.HitLocation'), b_const=0.85 * r), b_pin=g.z_of(p))
        pen = g.fselect(tr + '.bHit', pen, -1000000.0)
        best = pen if best is None else g.fop('Max', best, b_pin=pen)
    need = g.fop('Max', best, b_const=0.0)
    root = bl['root']
    n = g.unit('/Script/ControlRig.RigUnit_SetTranslation', 'PM_BodyOutOfGround', 120)
    g.set(n + '.Item', bone(root))
    g.set(n + '.Space', 'GlobalSpace')
    g.set(n + '.bPropagateToChildren', 'True')
    g.link(g.vadd(g.bone_pos(root), b_pin=g.up_by(need)), n + '.Value')
    return len(bl['bones'])

def build_ground_chains(g, rig):
    """Chains that lie on the ground (a seal's tail) keep their reference height over the terrain under each joint,
    so they bend over slopes and steps; other colliding chains are only kept above it. Each joint: trace down,
    then aim the bone before it at the corrected point (bone lengths stay)."""
    H = CFG['units']['heightCm']
    hier = rig.get_hierarchy_controller().get_hierarchy()
    count = 0
    for ch in CFG.get('groundChains', []):
        bones = ch['bones']
        for i in range(1, len(bones)):
            parent, child = bones[i - 1], bones[i]
            # the parent's axis that points at this joint, from the rig's own reference pose (UE axes)
            t = hier.get_local_transform(unreal.RigElementKey(unreal.RigElementType.BONE, child), True).translation
            ln = (t.x * t.x + t.y * t.y + t.z * t.z) ** 0.5
            if ln < 1e-4:
                continue
            axis = (t.x / ln, t.y / ln, t.z / ln)
            hug, clear, r = ch['hug'][i], ch['clearCm'][i], ch['radiusCm'][i]
            p = g.bone_pos(child)
            reach = min(r, clear) if hug > 0.5 else r
            tr = g.trace_down(g.vadd(p, b_const=(0, 0, clear + 0.4 * H)), g.vadd(p, b_const=(0, 0, -0.5 * H)), 0.5 * reach)
            ground = g.z_of(tr + '.HitLocation')
            if hug > 0.5:
                # lie on the ground: same height over it as in the reference pose (up or down)
                dz = g.fop('Sub', g.fop('Add', ground, b_const=clear), b_pin=g.z_of(p))
            else:
                # only push up out of the ground
                dz = g.fop('Max', g.fop('Sub', g.fop('Add', ground, b_const=reach), b_pin=g.z_of(p)), b_const=0.0)
            dz = g.fselect(tr + '.bHit', dz, 0.0)
            target = g.vadd(p, b_pin=g.up_by(dz))
            n = g.unit('/Script/ControlRig.RigUnit_AimItem', 'PM_Ground_%s' % child, 360)
            g.set(n + '.Item', bone(parent))
            g.set(n + '.Primary', '(Weight=1.000000,Axis=%s,Target=(X=0,Y=0,Z=0),Kind=Location)' % vec(*axis))
            g.set(n + '.Secondary.Weight', 0)
            g.link(target, n + '.Primary.Target')
            count += 1
    return count

# ---- small vector / quaternion helpers (plain tuples; quaternions are (x, y, z, w) like UE's FQuat)
def v_add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def v_sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def v_mul(a, s): return (a[0] * s, a[1] * s, a[2] * s)
def v_dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def v_cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def v_norm(a):
    ln = math.sqrt(v_dot(a, a))
    return v_mul(a, 1.0 / ln) if ln > 1e-9 else (0.0, 0.0, 0.0)
def q_axis_angle(axis, ang):
    s = math.sin(ang * 0.5)
    return (axis[0] * s, axis[1] * s, axis[2] * s, math.cos(ang * 0.5))
def q_rotate(q, v):
    u, w = (q[0], q[1], q[2]), q[3]
    t = v_mul(v_cross(u, v), 2.0)
    return v_add(v_add(v, v_mul(t, w)), v_cross(u, t))
def q_unrotate(q, v):
    return q_rotate((-q[0], -q[1], -q[2], q[3]), v)
def quat_str(q):
    return '(Rotation=(X=%f,Y=%f,Z=%f,W=%f),Translation=(X=0,Y=0,Z=0),Scale3D=(X=1,Y=1,Z=1))' % q

def all_fours_plan(rig, feet):
    """Two legs + two arms running on all fours (a bear): from the rig's reference pose (UE axes), the upper body
    pitches nose-down about the "upper" bone, and each hand gets a landing point under its pitched shoulder
    (a bit ahead and wider) - given to the Locomotor as the foot's StaticLocalOffset. Returns None if not used."""
    af = CFG['locomotor'].get('allFours')
    if not af:
        return None
    hier = rig.get_hierarchy_controller().get_hierarchy()
    names = set(str(k.name) for k in hier.get_bones())
    need = [af['upper'], CFG.get('headBone'), CFG.get('pelvisBone')] + [f['ikBones'][0] for f in feet if f.get('arm')] + [f['ankleBone'] for f in feet if f.get('arm')]
    if not all(n in names for n in need if n) or not CFG.get('headBone') or not CFG.get('pelvisBone'):
        warn('all fours: bones missing in the rig, the arms stay arms')
        return None
    def xf(b): return hier.get_global_transform(unreal.RigElementKey(unreal.RigElementType.BONE, b), True)
    def pos(b):
        t = xf(b).translation
        return (t.x, t.y, t.z)
    def rot(b):
        r = xf(b).rotation
        return (r.x, r.y, r.z, r.w)
    U = (0.0, 0.0, 1.0)
    F = v_norm(v_sub(pos(CFG['headBone']), pos(CFG['pelvisBone'])))
    F = v_norm((F[0], F[1], 0.0))
    if v_dot(F, F) < 0.5:
        warn('all fours: cannot tell which way the creature faces')
        return None
    th = math.radians(af['thetaDeg'])
    A = v_norm(v_cross(U, F))
    if q_rotate(q_axis_angle(A, th), F)[2] > 0:   # the nose must go down
        A = v_mul(A, -1.0)
    pivot = pos(af['upper'])
    c, s = math.cos(th), math.sin(th)
    def pitched(p):
        d = v_sub(p, pivot)
        f, u = v_dot(d, F), v_dot(d, U)
        lat = v_sub(d, v_add(v_mul(F, f), v_mul(U, u)))
        return v_add(pivot, v_add(lat, v_add(v_mul(F, f * c + u * s), v_mul(U, u * c - f * s))))
    L = v_cross(U, F)
    arms = [f for f in feet if f.get('arm')]
    sh = {f['ankleBone']: pitched(pos(f['ikBones'][0])) for f in arms}
    mid = sum(v_dot(p, L) for p in sh.values()) / max(1, len(sh))
    offsets = {}
    for f in arms:
        p = sh[f['ankleBone']]
        lat = mid + (v_dot(p, L) - mid) * 1.15
        fwd = v_dot(p, F) + 0.12 * f['armLenCm']
        D = v_add(v_add(v_mul(L, lat), v_mul(F, fwd)), v_mul(U, f.get('handHeightCm', 0.0)))
        offsets[f['ankleBone']] = q_unrotate(rot(f['ankleBone']), v_sub(D, pos(f['ankleBone'])))
    # the same world-axis turn expressed in each bone's own frame (the offset node applies it locally)
    upper_q = q_axis_angle(v_norm(q_unrotate(rot(af['upper']), A)), th)
    head_q = q_axis_angle(v_norm(q_unrotate(rot(CFG['headBone']), A)), -af.get('headCounter', 0.85) * th)
    log('all fours: upper body pitches %.0f deg about %s, hands land under the shoulders' % (af['thetaDeg'], af['upper']))
    return {'upper': af['upper'], 'upper_q': upper_q, 'head_q': head_q, 'offsets': offsets}

def build_all_fours(g, plan):
    n = g.unit('/Script/ControlRig.RigUnit_OffsetTransformForItem', 'PM_AllFours_Pitch', 0)
    g.set(n + '.Item', bone(plan['upper']))
    g.set(n + '.OffsetTransform', quat_str(plan['upper_q']))
    g.set(n + '.Weight', 1.0)
    g.set(n + '.bPropagateToChildren', 'True')
    n = g.unit('/Script/ControlRig.RigUnit_OffsetTransformForItem', 'PM_AllFours_HeadUp', 0)
    g.set(n + '.Item', bone(CFG['headBone']))
    g.set(n + '.OffsetTransform', quat_str(plan['head_q']))
    g.set(n + '.Weight', 1.0)
    g.set(n + '.bPropagateToChildren', 'True')

def build(mesh, run=False):
    """The runtime rig. run=True builds <model>_Procemotion_Run: the same rig with the gallop foot pattern."""
    path = unreal.Paths.get_path(mesh.get_path_name())
    rig = unreal.ControlRigBlueprintFactory.create_control_rig_from_skeletal_mesh_or_skeleton(mesh, False)
    if rig is None:
        raise RuntimeError('Control Rig could not be created from ' + mesh.get_name())
    target = path + '/' + CFG['model'] + '_Procemotion' + ('_Run' if run else '')
    if unreal.EditorAssetLibrary.does_asset_exist(target):
        unreal.EditorAssetLibrary.delete_asset(target)
    unreal.EditorAssetLibrary.rename_asset(rig.get_path_name(), target)
    rig = unreal.load_asset(target)
    log('Control Rig: ' + target)

    hier = rig.get_hierarchy_controller()
    settings = unreal.RigControlSettings()
    settings.control_type = unreal.RigControlType.EULER_TRANSFORM
    settings.display_name = 'PM_Root'
    value = unreal.RigHierarchy.make_control_value_from_euler_transform(unreal.EulerTransform())
    hier.add_control('PM_Root', unreal.RigElementKey(), settings, value)

    g = Graph(rig)
    # this rig runs on the ground: hide parts that only exist in the air (e.g. open wings of a bird that also has
    # folded ones), the same way the model's own clips do it - by shrinking their bone
    for p in CFG.get('partSwap', []):
        if p['showIn'] != 'air':
            continue
        n = g.unit('/Script/ControlRig.RigUnit_SetScale', 'PM_HideOnGround_' + p['bone'], -440)
        g.set(n + '.Item', bone(p['bone']))
        g.set(n + '.Space', 'LocalSpace')
        g.set(n + '.Scale', vec(0.02, 0.02, 0.02))
    loco = CFG['locomotor']
    foot_sets = loco['footSetsRun'] if run and loco.get('footSetsRun') else loco['footSets']
    legs = [f for s in foot_sets for f in s['feet']]
    four = all_fours_plan(rig, legs) if run and any(f.get('arm') for f in legs) else None
    if not four and any(f.get('arm') for f in legs):
        # no all-fours pose: the arms are not feet after all
        foot_sets = [dict(s, feet=[f for f in s['feet'] if not f.get('arm')]) for s in foot_sets]
        foot_sets = [s for s in foot_sets if s['feet']]
        legs = [f for s in foot_sets for f in s['feet']]
    if legs and CFG.get('pelvisBone'):
        n = g.unit('/Script/Locomotor.RigUnit_Locomotor', 'PM_Locomotor')
        g.set(n + '.RootControl', 'PM_Root')
        sets = []
        for s in foot_sets:
            feet = []
            for f in s['feet']:
                off = four['offsets'].get(f['ankleBone']) if four else None
                feet.append('(AnkleBone=%s,CollisionRadius=%f%s)' % (bone(f['ankleBone']), f['collisionRadiusCm'],
                            (',StaticLocalOffset=' + vec(*off)) if off else ''))
            sets.append('(Feet=(%s),PhaseOffset=%f)' % (','.join(feet), s['phaseOffset']))
        g.set(n + '.FootSets', '(' + ','.join(sets) + ')')
        m = loco['movement']
        g.set(n + '.Movement.MinimumStepLength', m['minimumStepLength'])
        g.set(n + '.Movement.SpeedMax', m['speedMax'])
        g.set(n + '.Movement.SpeedMin', m['speedMin'])
        g.set(n + '.Movement.PhaseSpeedMax', m['phaseSpeedMax'])
        g.set(n + '.Movement.PhaseSpeedMin', m['phaseSpeedMin'])
        g.set(n + '.Movement.Acceleration', m['acceleration'])
        g.set(n + '.Movement.Deceleration', m['deceleration'])
        st = loco['stepping']
        g.set(n + '.Stepping.PercentOfStrideInAir', loco.get('runAir', 0.65) if run else st['percentOfStrideInAir'])
        g.set(n + '.Stepping.AirExtensionAtMaxSpeed', st['airExtensionAtMaxSpeed'])
        g.set(n + '.Stepping.StepHeight', st['stepHeight'])
        g.set(n + '.Stepping.StepEaseIn', st['stepEaseIn'])
        g.set(n + '.Stepping.StepEaseOut', st['stepEaseOut'])
        g.set(n + '.Stepping.bEnableGroundCollision', 'True' if st['enableGroundCollision'] else 'False')
        g.set(n + '.Stepping.MaxCollisionHeight', st['maxCollisionHeight'])
        g.set(n + '.Stepping.OrientFootToGroundPitch', st['orientFootToGroundPitch'])
        g.set(n + '.Stepping.OrientFootToGroundRoll', st['orientFootToGroundRoll'])
        pv = loco['pelvis']
        g.set(n + '.Pelvis.PelvisBone', bone(loco.get('pelvisBone') or CFG['pelvisBone']))
        g.set(n + '.Pelvis.PositionDampingHalfLife', pv['positionDampingHalfLife'])
        g.set(n + '.Pelvis.BobOffset', pv['bobOffset'])
        g.set(n + '.Pelvis.LeadAmount', pv['leadAmount'])
        g.set(n + '.Pelvis.OrientToGroundPitch', pv['orientToGroundPitch'])
        g.set(n + '.Pelvis.OrientToGroundRoll', pv['orientToGroundRoll'])
        g.set(n + '.Debug.bDrawDebug', 'False')
        loco_node = n
        # running on all fours: pitch the upper body down so the hands reach the ground (before the body lift)
        if four:
            build_all_fours(g, four)
        # body volume out of the ground (after the Locomotor placed the pelvis, before the legs reach down)
        lifted = build_body_lift(g)
        # one IK chain per foot, driven by the Locomotor's foot transforms
        for i, f in enumerate(legs):
            ik = g.unit('/Script/ControlRig.RigUnit_FABRIKItemArray', 'PM_IK_%d_%s' % (i, f['ankleBone']), 220)
            g.set(ik + '.Items', '(' + ','.join(bone(b) for b in f['ikBones']) + ')')
            # hands keep their own turn (a foot takes the ground's)
            g.set(ik + '.bSetEffectorTransform', 'False' if f.get('arm') else 'True')
            g.set(ik + '.MaxIterations', 20)
            elem = g.array_at(loco_node + '.FeetTransforms', i, 'PM_Foot_%d' % i, 420)
            if not elem or not g.link(elem, ik + '.EffectorTransform'):
                warn('connect Locomotor FeetTransforms[%d] to %s.EffectorTransform by hand' % (i, ik))
    # springs and waves for ears, tails, tentacles, hair
    for l in CFG['limbs']:
        d = l.get('dynamics')
        if not d:
            continue
        n = g.unit('/Script/ControlRig.RigUnit_ChainHarmonicsPerItem', 'PM_Chain_' + l['bones'][0], -220)
        g.set(n + '.ChainRoot', bone(l['bones'][0]))
        a = float(d.get('waveAmp', 0))
        axis = d.get('waveAxis', 'side')
        amp = vec(a if axis != 'side' else 0, a if axis != 'up' else 0, 0)
        g.set(n + '.Wave.bEnabled', 'True' if a > 0 else 'False')
        g.set(n + '.Wave.WaveAmplitude', amp)
        fq = float(d.get('waveFreq', 0.8))
        g.set(n + '.Wave.WaveFrequency', vec(fq, fq * 0.8, fq * 0.6))
        g.set(n + '.Pendulum.bEnabled', 'True')
        g.set(n + '.Pendulum.PendulumStiffness', 1 + 9 * float(d.get('stiffness', 0.5)))
        g.set(n + '.Pendulum.PendulumGravity', vec(0, 0, -400 * float(d.get('gravity', 0))))
        g.set(n + '.Pendulum.PendulumDrag', 0.9 + 0.09 * (1 - float(d.get('damping', 0.5))))
        g.set(n + '.Reach.bEnabled', 'False')
    # body volume for creatures without legs (no Locomotor above)
    if not (legs and CFG.get('pelvisBone')):
        lifted = build_body_lift(g)
    # tails and other chains on the ground, after the springs moved them
    grounded = build_ground_chains(g, rig)
    rig.recompile_vm()
    unreal.EditorAssetLibrary.save_loaded_asset(rig)
    log('Done. Feet: %d, spring chains: %d, body collision capsules: %d, joints kept on/above the ground: %d. Add the "Control Rig" node with %s to your Anim Blueprint.' % (
        len(legs), sum(1 for l in CFG['limbs'] if l.get('dynamics')), lifted, grounded, rig.get_name()))
    return rig

def build_actor(mesh, rig, suffix='', speed_frac=0.3):
    """BP_<model>_Procemotion: drop it in a level and press Play. It walks in a circle with the rig running.
    Body = the mesh, ProcemotionRig = a Control Rig component driving it, Walk = a Rotating Movement component
    (turning about a pivot beside the creature = walking a circle while facing forward). No graph needed."""
    folder = unreal.Paths.get_path(rig.get_path_name())
    name = 'BP_' + CFG['model'] + '_Procemotion' + suffix
    target = folder + '/' + name
    if unreal.EditorAssetLibrary.does_asset_exist(target):
        unreal.EditorAssetLibrary.delete_asset(target)
    factory = unreal.BlueprintFactory()
    factory.set_editor_property('parent_class', unreal.Actor)
    bp = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, unreal.Blueprint, factory)
    sds = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    lib = unreal.SubobjectDataBlueprintFunctionLibrary
    root = sds.k2_gather_subobject_data_for_blueprint(bp)[0]

    def add(cls, comp_name):
        handle, fail = sds.add_new_subobject(unreal.AddNewSubobjectParams(parent_handle=root, new_class=cls, blueprint_context=bp))
        sds.rename_subobject(handle, unreal.Text(comp_name))
        data = lib.get_data(handle)
        obj = lib.get_associated_object(data) if hasattr(lib, 'get_associated_object') else None
        return obj or lib.get_object(data)

    # bones and facing from the rig's own copy of the skeleton (reference pose)
    hier = rig.get_hierarchy_controller().get_hierarchy()
    bones = [str(k.name) for k in hier.get_bones()]
    def ref_pos(b):
        return hier.get_global_transform(unreal.RigElementKey(unreal.RigElementType.BONE, b), True).translation
    fx, fy = 0.0, 1.0
    if CFG.get('headBone') and CFG.get('pelvisBone') and CFG['headBone'] in bones and CFG['pelvisBone'] in bones:
        h, p = ref_pos(CFG['headBone']), ref_pos(CFG['pelvisBone'])
        if abs(h.x - p.x) + abs(h.y - p.y) > 1e-3:
            fx, fy = h.x - p.x, h.y - p.y
    fl = math.hypot(fx, fy)
    fx, fy = fx / fl, fy / fl
    # the Control Rig component writes the bones in its own (= the actor's) space, so turning the mesh component
    # would not turn the creature: instead the circle is laid out so the actor travels the way the creature faces

    body = add(unreal.SkeletalMeshComponent, 'Body')
    body.set_skeletal_mesh_asset(mesh)
    body.set_collision_profile_name('NoCollision')  # the feet trace the ground, not the creature itself

    crc = add(unreal.ControlRigComponent, 'ProcemotionRig')
    crc.set_control_rig_class(rig.generated_class())
    elements = []
    for b in bones:
        e = unreal.ControlRigComponentMappedElement()
        ref = unreal.SoftComponentReference()
        ref.set_editor_property('component_property', 'Body')
        e.set_editor_property('component_reference', ref)
        e.set_editor_property('element_type', unreal.RigElementType.BONE)
        e.set_editor_property('element_name', b)
        e.set_editor_property('transform_name', b)
        e.set_editor_property('direction', unreal.ControlRigComponentMapDirection.OUTPUT)
        elements.append(e)
    crc.set_editor_property('user_defined_elements', elements)

    # walk a circle: speed = 30 % of the rig's top speed, radius = 3 body heights (edit "Walk" in the Blueprint)
    speed = speed_frac * CFG['locomotor']['movement']['speedMax'] if CFG['locomotor']['footSets'] else 0.0
    radius = 3.0 * CFG['units']['heightCm']
    walk = add(unreal.RotatingMovementComponent, 'Walk')
    walk.set_editor_property('rotation_rate', unreal.Rotator(0.0, 0.0, math.degrees(speed / radius) if radius > 0 else 0.0))
    # turning (positive yaw) about a pivot at radius * (-fy, fx) moves the actor along (fx, fy): forward
    walk.set_editor_property('pivot_translation', unreal.Vector(-fy * radius, fx * radius, 0.0))

    unreal.BlueprintEditorLibrary.compile_blueprint(bp)
    unreal.EditorAssetLibrary.save_loaded_asset(bp)
    log('Actor: %s (walks a %.0f cm circle at %.0f cm/s; drop it in a level and press Play)' % (target, radius, speed))
    return bp

RIG = None
ACTOR = None
RIG_RUN = None
ACTOR_RUN = None
mesh = find_mesh()
if mesh is None:
    unreal.log_error('[Procemotion] Select the imported skeletal mesh of %s in the Content Browser first.' % CFG['model'])
else:
    RIG = build(mesh)
    try:
        ACTOR = build_actor(mesh, RIG)
    except Exception as e:
        warn('could not create the ready-to-place actor: %s' % e)
    # running: a second rig with the gallop foot pattern, and an actor that runs with it
    if CFG['locomotor'].get('footSetsRun'):
        RIG_RUN = build(mesh, run=True)
        try:
            ACTOR_RUN = build_actor(mesh, RIG_RUN, '_Run', 0.85)
        except Exception as e:
            warn('could not create the running actor: %s' % e)
`;
}

export function download(blobOrText, filename, type = 'application/octet-stream') {
  const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Optionally write straight into a folder (Chromium). Returns false if not supported or cancelled. */
export async function saveToFolder(files) {
  if (!window.showDirectoryPicker) return false;
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return false; }
  for (const [name, data] of files) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data instanceof Blob ? data : new Blob([data]));
    await w.close();
  }
  return true;
}

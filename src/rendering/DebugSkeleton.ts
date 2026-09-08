import {
  BufferAttribute,
  BufferGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  MeshBasicMaterial,
  Object3D,
  type Scene,
  SphereGeometry,
} from 'three';
import { POSE_LANDMARK_COUNT, type TrackingFrame } from '../types/tracking';
import { POSE_CONNECTIONS } from '../utils/poseLandmarks';

const JOINT_VISIBILITY_THRESHOLD = 0.4;
const DEBUG_COLOR = 0x00ffc8;

/**
 * Draws tracked joints as small spheres and bones as line segments,
 * directly in the Three.js scene. Development/verification tool for the
 * tracking pipeline — not the final avatar. Geometry is allocated once and
 * mutated in place every frame (no per-frame allocation).
 */
export class DebugSkeleton {
  private readonly joints: InstancedMesh;
  private readonly bones: LineSegments;
  private readonly bonePositions: Float32Array;
  private readonly dummy = new Object3D();

  constructor(scene: Scene) {
    const sphereGeometry = new SphereGeometry(0.035, 8, 8);
    const jointMaterial = new MeshBasicMaterial({ color: DEBUG_COLOR });
    this.joints = new InstancedMesh(sphereGeometry, jointMaterial, POSE_LANDMARK_COUNT);
    this.joints.frustumCulled = false;
    this.joints.visible = false;

    this.bonePositions = new Float32Array(POSE_CONNECTIONS.length * 2 * 3);
    const boneGeometry = new BufferGeometry();
    boneGeometry.setAttribute('position', new BufferAttribute(this.bonePositions, 3));
    const boneMaterial = new LineBasicMaterial({ color: DEBUG_COLOR, transparent: true, opacity: 0.85 });
    this.bones = new LineSegments(boneGeometry, boneMaterial);
    this.bones.frustumCulled = false;
    this.bones.visible = false;

    scene.add(this.joints, this.bones);
  }

  setVisible(visible: boolean): void {
    this.joints.visible = visible;
    this.bones.visible = visible;
  }

  update(frame: TrackingFrame): void {
    if (!this.joints.visible) return;
    if (!frame.present) return;

    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      const joint = frame.joints[i];
      const scale = joint.visibility > JOINT_VISIBILITY_THRESHOLD ? 1 : 0;
      this.dummy.position.copy(joint.position);
      this.dummy.scale.setScalar(scale);
      this.dummy.updateMatrix();
      this.joints.setMatrixAt(i, this.dummy.matrix);
    }
    this.joints.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < POSE_CONNECTIONS.length; i++) {
      const [a, b] = POSE_CONNECTIONS[i]!;
      const jointA = frame.joints[a]!.position;
      const jointB = frame.joints[b]!.position;
      const base = i * 6;
      this.bonePositions[base] = jointA.x;
      this.bonePositions[base + 1] = jointA.y;
      this.bonePositions[base + 2] = jointA.z;
      this.bonePositions[base + 3] = jointB.x;
      this.bonePositions[base + 4] = jointB.y;
      this.bonePositions[base + 5] = jointB.z;
    }
    const positionAttr = this.bones.geometry.getAttribute('position') as BufferAttribute;
    positionAttr.needsUpdate = true;
  }

  dispose(): void {
    this.joints.geometry.dispose();
    (this.joints.material as MeshBasicMaterial).dispose();
    this.bones.geometry.dispose();
    (this.bones.material as LineBasicMaterial).dispose();
  }
}

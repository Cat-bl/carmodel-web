import * as THREE from 'three';

const MAX_SAMPLES = 24000;

const FRONT_CUES = [
  { pattern: /(?:^|_)(?:headlight|headlamp|head_light|head_lamp)(?:_|$)/, weight: 6, label: '前灯' },
  { pattern: /(?:^|_)(?:light|lamp)_f(?:_|$)/, weight: 6, label: '前灯' },
  { pattern: /(?:^|_)(?:bumper|fender)_f(?:_|$)/, weight: 5, label: '前保险杠/翼子板' },
  { pattern: /(?:^|_)(?:hood|bonnet)(?:_|$)/, weight: 5, label: '引擎盖' },
  { pattern: /(?:^|_)(?:front|forward)(?:_|$)/, weight: 4, label: '前部命名' },
  { pattern: /(?:^|_)(?:door|wheel|tire|tyre)_(?:fl|fr)(?:_|$)/, weight: 3.5, label: '前轮/前门' },
  { pattern: /(?:^|_)(?:grille|grill|grile)(?:_|$)/, weight: 2.5, label: '前格栅' },
  { pattern: /(?:^|_)(?:windshield|windscreen)(?:_|$)/, weight: 2, label: '前挡风玻璃' },
  { pattern: /(?:车头|前灯|大灯|前保险杠|前格栅|引擎盖|机盖)/, weight: 5, label: '中文前部命名' },
];

const REAR_CUES = [
  { pattern: /(?:^|_)(?:taillight|tail_light|rear_light)(?:_|$)/, weight: 6, label: '尾灯' },
  { pattern: /(?:^|_)(?:light|lamp)_b(?:_|$)/, weight: 6, label: '尾灯' },
  { pattern: /(?:^|_)(?:bumper|fender)_b(?:_|$)/, weight: 5, label: '后保险杠/后翼子板' },
  { pattern: /(?:^|_)(?:trunk|tailgate|boot)(?:_|$)/, weight: 5, label: '后备箱' },
  { pattern: /(?:^|_)(?:rear|backward)(?:_|$)/, weight: 4, label: '后部命名' },
  { pattern: /(?:^|_)(?:door|wheel|tire|tyre)_(?:bl|br|rl|rr)(?:_|$)/, weight: 3.5, label: '后轮/后门' },
  { pattern: /(?:车尾|尾灯|后灯|后保险杠|后备箱|尾门)/, weight: 5, label: '中文后部命名' },
];

/**
 * 推断模型正面并计算对齐到车道级车头方向（-X）所需的 Y 轴旋转。
 * 部件命名是强证据；只有外形明显像车辆时，才会使用座舱偏置作低置信度推断。
 */
export function inferModelFront(model) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return unknownResult('模型没有可分析的几何');

  const points = sampleModel(model);
  const axis = principalHorizontalAxis(points, box);
  const semantic = inferFromSemantics(model, box, axis);
  if (semantic) return semantic;

  const geometry = inferFromVehicleShape(points, box, axis);
  if (geometry) return geometry;
  return unknownResult('没有找到可靠的前部命名或车辆轮廓特征');
}

function inferFromSemantics(model, box, axis) {
  const front = evidenceAccumulator();
  const rear = evidenceAccumulator();
  const meshBox = new THREE.Box3();
  const center = new THREE.Vector3();

  model.traverse((object) => {
    if (!object.isMesh || object.name === 'CS_Shadow' || !object.geometry) return;
    const cues = semanticCues(object);
    if (!cues.front && !cues.rear) return;

    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    if (!object.geometry.boundingBox) return;
    meshBox.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);
    meshBox.getCenter(center);
    const vertexCount = object.geometry.attributes?.position?.count || 0;
    const detailWeight = THREE.MathUtils.clamp(Math.log2(vertexCount + 2) / 8, 0.75, 2.5);

    if (cues.front && (!cues.rear || cues.front.weight > cues.rear.weight)) {
      addEvidence(front, center, cues.front.weight * detailWeight, cues.front.label);
    } else if (cues.rear && (!cues.front || cues.rear.weight > cues.front.weight)) {
      addEvidence(rear, center, cues.rear.weight * detailWeight, cues.rear.label);
    }
  });

  if (!front.weight && !rear.weight) return null;
  const modelCenter = box.getCenter(new THREE.Vector3());
  const frontPoint = front.weight ? front.point.multiplyScalar(1 / front.weight) : null;
  const rearPoint = rear.weight ? rear.point.multiplyScalar(1 / rear.weight) : null;
  const direction = new THREE.Vector3();
  if (frontPoint && rearPoint) direction.subVectors(frontPoint, rearPoint);
  else if (frontPoint) direction.subVectors(frontPoint, modelCenter);
  else direction.subVectors(modelCenter, rearPoint);
  direction.y = 0;

  const horizontalSpan = Math.max(axis.longSpan, axis.lateralSpan, 1e-6);
  const separation = direction.length() / horizontalSpan;
  const minSeparation = frontPoint && rearPoint ? 0.12 : 0.08;
  if (separation < minSeparation) return null;

  direction.normalize();
  if (axis.ratio >= 1.18) {
    const sign = direction.x * axis.x + direction.z * axis.z >= 0 ? 1 : -1;
    direction.set(axis.x * sign, 0, axis.z * sign);
  }

  const bothEnds = Boolean(frontPoint && rearPoint);
  const evidenceCount = front.labels.size + rear.labels.size;
  const confidence = THREE.MathUtils.clamp(
    (bothEnds ? 0.86 : 0.72) + Math.min(0.1, separation * 0.16) + Math.min(0.04, evidenceCount * 0.01),
    0,
    0.99,
  );
  const labels = [...front.labels, ...rear.labels].slice(0, 4).join('、');
  return resultForDirection(direction, confidence, 'semantic', `检测到${labels || '前后部件'}等命名`);
}

function inferFromVehicleShape(points, box, axis) {
  if (points.length < 80 || axis.ratio < 1.42) return null;
  const size = box.getSize(new THREE.Vector3());
  const height = Math.max(size.y, 1e-6);
  if (axis.longSpan / height < 1.55 || height / Math.max(axis.lateralSpan, 1e-6) > 1.35) return null;

  const binCount = 24;
  const roof = new Array(binCount).fill(-Infinity);
  for (const point of points) {
    const projection = point.x * axis.x + point.z * axis.z;
    const unit = (projection - axis.minLong) / Math.max(axis.longSpan, 1e-6);
    const index = Math.min(binCount - 1, Math.max(0, Math.floor(unit * binCount)));
    if (point.y > roof[index]) roof[index] = point.y;
  }

  const threshold = box.min.y + height * 0.62;
  let weight = 0;
  let roofCenter = 0;
  let roofBins = 0;
  for (let i = 0; i < binCount; i++) {
    if (roof[i] < threshold) continue;
    const binWeight = (roof[i] - threshold) / height + 0.08;
    const projection = axis.minLong + axis.longSpan * ((i + 0.5) / binCount);
    roofCenter += projection * binWeight;
    weight += binWeight;
    roofBins++;
  }
  if (roofBins < 2 || roofBins > binCount * 0.72 || !weight) return null;

  roofCenter /= weight;
  const bodyCenter = (axis.minLong + axis.maxLong) / 2;
  const offset = (roofCenter - bodyCenter) / axis.longSpan;
  if (Math.abs(offset) < 0.045) return null;

  // 普通乘用车座舱通常偏后，座舱偏移的反方向即车头。
  const sign = offset > 0 ? -1 : 1;
  const direction = new THREE.Vector3(axis.x * sign, 0, axis.z * sign);
  const confidence = THREE.MathUtils.clamp(0.56 + Math.abs(offset) * 0.9, 0.6, 0.7);
  return resultForDirection(direction, confidence, 'geometry', '根据车身长轴和座舱轮廓推测');
}

function sampleModel(model) {
  const meshes = [];
  let totalVertices = 0;
  model.traverse((object) => {
    const position = object.isMesh && object.name !== 'CS_Shadow'
      ? object.geometry?.attributes?.position
      : null;
    if (!position) return;
    meshes.push({ object, position });
    totalVertices += position.count;
  });
  const stride = Math.max(1, Math.ceil(totalVertices / MAX_SAMPLES));
  const point = new THREE.Vector3();
  const points = [];
  for (const { object, position } of meshes) {
    for (let i = 0; i < position.count; i += stride) {
      point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
      points.push(point.clone());
    }
  }
  return points;
}

function principalHorizontalAxis(points, box) {
  if (points.length < 3) return boxAxis(box);
  let meanX = 0;
  let meanZ = 0;
  for (const point of points) {
    meanX += point.x;
    meanZ += point.z;
  }
  meanX /= points.length;
  meanZ /= points.length;

  let xx = 0;
  let xz = 0;
  let zz = 0;
  for (const point of points) {
    const x = point.x - meanX;
    const z = point.z - meanZ;
    xx += x * x;
    xz += x * z;
    zz += z * z;
  }
  if (xx + zz < 1e-12) return boxAxis(box);

  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  const x = Math.cos(angle);
  const z = Math.sin(angle);
  let minLong = Infinity;
  let maxLong = -Infinity;
  let minLateral = Infinity;
  let maxLateral = -Infinity;
  for (const point of points) {
    const longitudinal = point.x * x + point.z * z;
    const lateral = point.x * -z + point.z * x;
    minLong = Math.min(minLong, longitudinal);
    maxLong = Math.max(maxLong, longitudinal);
    minLateral = Math.min(minLateral, lateral);
    maxLateral = Math.max(maxLateral, lateral);
  }
  const longSpan = maxLong - minLong;
  const lateralSpan = maxLateral - minLateral;
  if (longSpan < lateralSpan) {
    return {
      x: -z,
      z: x,
      minLong: minLateral,
      maxLong: maxLateral,
      longSpan: lateralSpan,
      lateralSpan: longSpan,
      ratio: lateralSpan / Math.max(longSpan, 1e-6),
    };
  }
  return { x, z, minLong, maxLong, longSpan, lateralSpan, ratio: longSpan / Math.max(lateralSpan, 1e-6) };
}

function boxAxis(box) {
  const size = box.getSize(new THREE.Vector3());
  if (size.x >= size.z) {
    return { x: 1, z: 0, minLong: box.min.x, maxLong: box.max.x, longSpan: size.x, lateralSpan: size.z, ratio: size.x / Math.max(size.z, 1e-6) };
  }
  return { x: 0, z: 1, minLong: box.min.z, maxLong: box.max.z, longSpan: size.z, lateralSpan: size.x, ratio: size.z / Math.max(size.x, 1e-6) };
}

function semanticCues(object) {
  const names = [];
  let cursor = object;
  for (let depth = 0; cursor && depth < 4; depth++, cursor = cursor.parent) {
    if (cursor.name) names.push(cursor.name);
  }
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  const materialNames = materials.map((material) => material?.name).filter(Boolean);
  const nameText = normalizeLabel(names.join('_'));
  const materialText = normalizeLabel(materialNames.join('_'));
  const front = strongestCue(`${nameText}_${materialText}`, FRONT_CUES);
  const rear = strongestCue(`${nameText}_${materialText}`, REAR_CUES);
  return { front, rear };
}

function normalizeLabel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '_');
}

function strongestCue(text, cues) {
  let strongest = null;
  for (const cue of cues) {
    if (cue.pattern.test(text) && (!strongest || cue.weight > strongest.weight)) strongest = cue;
  }
  return strongest;
}

function evidenceAccumulator() {
  return { point: new THREE.Vector3(), weight: 0, labels: new Set() };
}

function addEvidence(evidence, point, weight, label) {
  evidence.point.addScaledVector(point, weight);
  evidence.weight += weight;
  evidence.labels.add(label);
}

function resultForDirection(direction, confidence, method, reason) {
  const radians = Math.atan2(-direction.z, -direction.x);
  const rawDegrees = normalizeDegrees(THREE.MathUtils.radToDeg(radians));
  const nearestQuarter = normalizeDegrees(Math.round(rawDegrees / 90) * 90);
  const rotationY = circularDistance(rawDegrees, nearestQuarter) <= 8
    ? nearestQuarter
    : Math.round(rawDegrees);
  return { detected: true, rotationY, confidence, method, reason };
}

function unknownResult(reason) {
  // 常见下载车模以 +Z 为车头；车道级约定车头为 -X，因此默认左转 90°。
  // 有明确前后部件时会被上面的识别结果覆盖，只有无法判断时才走这个约定。
  return { detected: false, rotationY: 270, confidence: 0, method: 'default', reason };
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function circularDistance(a, b) {
  const difference = Math.abs(normalizeDegrees(a) - normalizeDegrees(b));
  return Math.min(difference, 360 - difference);
}

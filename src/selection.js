import * as THREE from 'three';

export const SELECTION_VERSION = 1;

export function selectionKey(nodeIndex, primitiveIndex) {
  return `${nodeIndex}:${primitiveIndex}`;
}

export function emptySelection() {
  return { version: SELECTION_VERSION, groups: [] };
}

export function selectionToMap(selection) {
  const map = new Map();
  for (const group of selection?.groups || []) {
    if (!Number.isInteger(group.nodeIndex) || !Number.isInteger(group.primitiveIndex)) continue;
    const triangles = new Set();
    for (const range of group.ranges || []) {
      const start = Number(range?.[0]);
      const count = Number(range?.[1]);
      if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count <= 0) continue;
      for (let i = 0; i < count; i++) triangles.add(start + i);
    }
    if (triangles.size) map.set(selectionKey(group.nodeIndex, group.primitiveIndex), triangles);
  }
  return map;
}

export function selectionFromMap(map) {
  const groups = [];
  for (const [key, triangles] of map || []) {
    if (!triangles?.size) continue;
    const [nodeIndex, primitiveIndex] = key.split(':').map(Number);
    if (!Number.isInteger(nodeIndex) || !Number.isInteger(primitiveIndex)) continue;
    groups.push({
      nodeIndex,
      primitiveIndex,
      ranges: compressTriangleRanges(triangles),
    });
  }
  groups.sort((a, b) => a.nodeIndex - b.nodeIndex || a.primitiveIndex - b.primitiveIndex);
  return { version: SELECTION_VERSION, groups };
}

export function compressTriangleRanges(triangles) {
  const values = [...triangles].filter(Number.isInteger).sort((a, b) => a - b);
  const ranges = [];
  let start = null;
  let previous = null;
  for (const value of values) {
    if (value < 0 || value === previous) continue;
    if (start === null) {
      start = value;
      previous = value;
      continue;
    }
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    ranges.push([start, previous - start + 1]);
    start = value;
    previous = value;
  }
  if (start !== null) ranges.push([start, previous - start + 1]);
  return ranges;
}

export function selectionTriangleCount(selection) {
  let count = 0;
  for (const group of selection?.groups || []) {
    for (const range of group.ranges || []) count += Math.max(0, Number(range?.[1]) || 0);
  }
  return count;
}

export function selectionGroupCount(selection) {
  return (selection?.groups || []).filter((group) => (group.ranges || []).length).length;
}

export function selectedTriangles(selection, nodeIndex, primitiveIndex) {
  const group = (selection?.groups || []).find((item) => (
    item.nodeIndex === nodeIndex && item.primitiveIndex === primitiveIndex
  ));
  if (!group) return null;
  const result = new Set();
  for (const [start, count] of group.ranges || []) {
    for (let i = 0; i < count; i++) result.add(start + i);
  }
  return result;
}

export function geometryTriangleCount(geometry) {
  return Math.floor((geometry.index?.count || geometry.attributes?.position?.count || 0) / 3);
}

export function triangleVertexIndices(geometry, triangleIndex) {
  const offset = triangleIndex * 3;
  if (geometry.index) {
    return [
      geometry.index.getX(offset),
      geometry.index.getX(offset + 1),
      geometry.index.getX(offset + 2),
    ];
  }
  return [offset, offset + 1, offset + 2];
}

function weldedVertexIds(geometry) {
  if (geometry.index) return null;
  const position = geometry.attributes?.position;
  if (!position) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const diagonal = geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  const epsilon = Math.max(diagonal * 1e-6, 1e-7);
  const ids = new Uint32Array(position.count);
  const byPosition = new Map();
  let nextId = 0;
  for (let i = 0; i < position.count; i++) {
    const key = `${Math.round(position.getX(i) / epsilon)},${Math.round(position.getY(i) / epsilon)},${Math.round(position.getZ(i) / epsilon)}`;
    let id = byPosition.get(key);
    if (id === undefined) {
      id = nextId++;
      byPosition.set(key, id);
    }
    ids[i] = id;
  }
  return ids;
}

export function buildTriangleTopology(geometry) {
  const triangleCount = geometryTriangleCount(geometry);
  const neighbors = Array.from({ length: triangleCount }, () => []);
  const normals = Array.from({ length: triangleCount }, () => new THREE.Vector3());
  const edgeOwners = new Map();
  const position = geometry.attributes?.position;
  const welded = weldedVertexIds(geometry);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const source = triangleVertexIndices(geometry, triangle);
    a.fromBufferAttribute(position, source[0]);
    b.fromBufferAttribute(position, source[1]);
    c.fromBufferAttribute(position, source[2]);
    normals[triangle].crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
    const vertices = welded ? source.map((index) => welded[index]) : source;
    for (const [x, y] of [[vertices[0], vertices[1]], [vertices[1], vertices[2]], [vertices[2], vertices[0]]]) {
      const key = x < y ? `${x}:${y}` : `${y}:${x}`;
      const owner = edgeOwners.get(key);
      if (owner === undefined) edgeOwners.set(key, triangle);
      else if (owner !== triangle) {
        neighbors[owner].push(triangle);
        neighbors[triangle].push(owner);
      }
    }
  }
  return { neighbors, normals };
}

export function splitTriangleIslands(geometry, triangles) {
  const selected = triangles instanceof Set ? triangles : new Set(triangles || []);
  if (!selected.size) return [];
  const welded = weldedVertexIds(geometry);
  const neighbors = new Map([...selected].map((triangle) => [triangle, []]));
  const edgeOwners = new Map();
  for (const triangle of selected) {
    const source = triangleVertexIndices(geometry, triangle);
    const vertices = welded ? source.map((index) => welded[index]) : source;
    for (const [x, y] of [[vertices[0], vertices[1]], [vertices[1], vertices[2]], [vertices[2], vertices[0]]]) {
      const key = x < y ? `${x}:${y}` : `${y}:${x}`;
      const owner = edgeOwners.get(key);
      if (owner === undefined) edgeOwners.set(key, triangle);
      else if (owner !== triangle) {
        neighbors.get(owner)?.push(triangle);
        neighbors.get(triangle)?.push(owner);
      }
    }
  }
  const pending = new Set(selected);
  const islands = [];
  while (pending.size) {
    const seed = pending.values().next().value;
    const island = new Set([seed]);
    const queue = [seed];
    pending.delete(seed);
    while (queue.length) {
      const triangle = queue.pop();
      for (const neighbor of neighbors.get(triangle) || []) {
        if (!pending.has(neighbor)) continue;
        pending.delete(neighbor);
        island.add(neighbor);
        queue.push(neighbor);
      }
    }
    islands.push(island);
  }
  return islands;
}

export function connectedTriangles(topology, seed, angleDegrees = 38) {
  if (!Number.isInteger(seed) || seed < 0 || seed >= topology.neighbors.length) return new Set();
  const threshold = Math.cos(THREE.MathUtils.degToRad(Math.max(1, Math.min(89, Number(angleDegrees) || 38))));
  const selected = new Set([seed]);
  const queue = [seed];
  while (queue.length) {
    const triangle = queue.shift();
    const normal = topology.normals[triangle];
    for (const neighbor of topology.neighbors[triangle]) {
      if (selected.has(neighbor)) continue;
      if (normal.dot(topology.normals[neighbor]) < threshold) continue;
      selected.add(neighbor);
      queue.push(neighbor);
    }
  }
  return selected;
}

export function applyTriangleOperation(target, triangles, operation) {
  if (operation === 'subtract') {
    for (const triangle of triangles) target.delete(triangle);
  } else {
    for (const triangle of triangles) target.add(triangle);
  }
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

export function robustWheelPivot(points, islandCenters = []) {
  if (!points?.length) return null;
  const axes = [0, 1, 2].map((axis) => points.map((point) => point[axis]).sort((a, b) => a - b));
  const centers = axes.map((values) => (percentile(values, 0.02) + percentile(values, 0.98)) / 2);
  const z = islandCenters?.length >= 2
    ? islandCenters.reduce((sum, center) => sum + center[2], 0) / islandCenters.length
    : centers[2];
  return [centers[0], centers[1], z];
}

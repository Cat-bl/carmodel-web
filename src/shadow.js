export const SHADOW_TEXTURE_WIDTH = 512;
export const SHADOW_TEXTURE_HEIGHT = 256;

export function createCarShadowCanvas(preferOffscreen = true) {
  const canvas = preferOffscreen && typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(SHADOW_TEXTURE_WIDTH, SHADOW_TEXTURE_HEIGHT)
    : Object.assign(document.createElement('canvas'), {
      width: SHADOW_TEXTURE_WIDTH,
      height: SHADOW_TEXTURE_HEIGHT,
    });
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持 2D 画布，无法生成车底阴影');

  const image = context.createImageData(SHADOW_TEXTURE_WIDTH, SHADOW_TEXTURE_HEIGHT);
  for (let y = 0; y < SHADOW_TEXTURE_HEIGHT; y++) {
    const ny = (y / (SHADOW_TEXTURE_HEIGHT - 1)) * 2 - 1;
    for (let x = 0; x < SHADOW_TEXTURE_WIDTH; x++) {
      const nx = (x / (SHADOW_TEXTURE_WIDTH - 1)) * 2 - 1;
      const radius = Math.hypot(nx / 0.88, ny / 0.82);
      const outer = 1 - smoothstep(0.72, 1, radius);
      const contact = 1 - smoothstep(0.34, 0.78, radius);
      const alpha = Math.round(145 * outer + 45 * contact);
      const offset = (y * SHADOW_TEXTURE_WIDTH + x) * 4;
      image.data[offset] = 0;
      image.data[offset + 1] = 0;
      image.data[offset + 2] = 0;
      image.data[offset + 3] = alpha;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

export function shadowFootprint(min, max, groundSamples = []) {
  let lowX = min[0];
  let highX = max[0];
  let lowZ = min[2];
  let highZ = max[2];
  if (groundSamples.length >= 24) {
    const xs = [];
    const zs = [];
    for (let i = 0; i + 1 < groundSamples.length; i += 2) {
      xs.push(groundSamples[i]);
      zs.push(groundSamples[i + 1]);
    }
    xs.sort((a, b) => a - b);
    zs.sort((a, b) => a - b);
    lowX = percentile(xs, 0.04);
    highX = percentile(xs, 0.96);
    lowZ = percentile(zs, 0.04);
    highZ = percentile(zs, 0.96);
  }

  const overallX = Math.max(0.2, max[0] - min[0]);
  const overallZ = Math.max(0.2, max[2] - min[2]);
  const overallY = Math.max(0.2, max[1] - min[1]);
  const longSide = Math.max(overallX, overallZ);
  const shortSide = Math.min(overallX, overallZ);
  const vehicleLike = longSide / shortSide >= 1.65 && overallY / longSide <= 0.58;
  const minX = overallX * (vehicleLike ? 1 : 0.18);
  const minZ = overallZ * (vehicleLike ? 1 : 0.18);
  const sizeX = Math.max(minX, highX - lowX, 0.2);
  const sizeZ = Math.max(minZ, highZ - lowZ, 0.2);
  const contactCenterX = (lowX + highX) / 2;
  const contactCenterZ = (lowZ + highZ) / 2;
  const padding = vehicleLike ? 1.36 : 1.16;
  return {
    centerX: vehicleLike ? (contactCenterX + (min[0] + max[0]) / 2) / 2 : contactCenterX,
    centerZ: vehicleLike ? (contactCenterZ + (min[2] + max[2]) / 2) / 2 : contactCenterZ,
    sizeX: sizeX * padding,
    sizeZ: sizeZ * padding,
  };
}

function percentile(values, ratio) {
  const at = Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * ratio)));
  return values[at];
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

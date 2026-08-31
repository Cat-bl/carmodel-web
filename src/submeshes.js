/**
 * 按材质列出模型的子网格：同一材质的所有 primitive 归为一项，名字来自材质名。
 * modelviewer.lol 这类站点导出的模型还会带默认显隐（材质 extras.visible）和
 * 按动画显示的事件表（节点 extras.submeshVisibilityEvents），一并读出来供界面提示。
 */
export function listSubmeshes(json) {
  const shownHashes = new Set();
  for (const node of json?.nodes || []) {
    for (const list of Object.values(node.extras?.submeshVisibilityEvents || {})) {
      for (const event of list) for (const hash of event.showSubmeshList || []) shownHashes.add(hash);
    }
  }
  const items = new Map();
  for (const mesh of json?.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      if (!Number.isInteger(primitive.material)) continue;
      const material = json.materials?.[primitive.material] || {};
      const pbr = material.pbrMetallicRoughness || {};
      const vertexCount = json.accessors?.[primitive.indices]?.count
        ?? json.accessors?.[primitive.attributes?.POSITION]?.count ?? 0;
      const item = items.get(primitive.material) || {
        materialIndex: primitive.material,
        name: material.name || `材质 ${primitive.material + 1}`,
        triangles: 0,
        alphaMode: material.alphaMode || 'OPAQUE',
        hasTexture: Number.isInteger(pbr.baseColorTexture?.index),
        hasColor: Array.isArray(pbr.baseColorFactor),
        defaultVisible: material.extras?.visible !== false,
        animated: shownHashes.has(material.extras?.hash),
      };
      item.triangles += Math.floor(vertexCount / 3);
      items.set(primitive.material, item);
    }
  }
  return [...items.values()];
}

/**
 * 默认建议剔除的子网格：
 * - 模型自带显隐数据时，剔除“默认隐藏且没有任何动画会显示”的；
 * - 否则按命名兜底：同一部位多套表情只留 *_Base，残影/特效片剔除；
 * - 两种情况都剔除没有贴图也没有颜色的透明材质（画出来只是一团白雾）。
 */
export function recommendedHiddenSubmeshes(submeshes) {
  const hidden = new Set();
  const hasVisibilityData = submeshes.some((item) => item.defaultVisible === false);
  const expressionGroups = new Map();
  for (const item of submeshes) {
    if (item.alphaMode === 'BLEND' && !item.hasTexture && !item.hasColor) hidden.add(item.materialIndex);
    if (hasVisibilityData) {
      if (!item.defaultVisible && !item.animated) hidden.add(item.materialIndex);
      continue;
    }
    if (/smear|vfx/i.test(item.name)) hidden.add(item.materialIndex);
    const expression = /^(Eyes?|Mouth|Brows?)_/i.exec(item.name);
    if (expression) {
      const key = expression[1].toLowerCase();
      if (!expressionGroups.has(key)) expressionGroups.set(key, []);
      expressionGroups.get(key).push(item);
    }
  }
  for (const group of expressionGroups.values()) {
    if (group.length < 2 || !group.some((item) => /_Base$/i.test(item.name))) continue;
    for (const item of group) if (!/_Base$/i.test(item.name)) hidden.add(item.materialIndex);
  }
  return hidden;
}

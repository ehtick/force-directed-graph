/**
 * AssemblyScript texture processor for Force Directed Graph
 * Handles high-performance texture data processing for GPU compute shaders
 */

// Memory layout constants
const FLOAT32_BYTES = 4;
const RGBA_COMPONENTS = 4;

// Export memory to be accessible from JavaScript
export declare const __heap_base: usize;

/**
 * Process node positions into texture data
 * @param nodesDataPtr Pointer to serialized node data
 * @param nodesCount Number of nodes
 * @param textureSize Power-of-2 texture size
 * @param positionsPtr Pointer to output positions texture data
 * @param frustumSize Frustum size for out-of-bounds nodes
 */
export function processNodePositions(
  nodesDataPtr: usize,
  nodesCount: i32,
  textureSize: i32,
  positionsPtr: usize,
  frustumSize: f32
): void {
  const totalElements = textureSize * textureSize;
  
  for (let i = 0; i < totalElements; i++) {
    const positionOffset = positionsPtr + i * RGBA_COMPONENTS * FLOAT32_BYTES;
    
    if (i < nodesCount) {
      // Read node data (x, y, z, isStatic) using direct memory access
      const nodeOffset = nodesDataPtr + i * 4 * FLOAT32_BYTES;
      const x = load<f32>(nodeOffset + 0 * FLOAT32_BYTES);
      const y = load<f32>(nodeOffset + 1 * FLOAT32_BYTES);
      const z = load<f32>(nodeOffset + 2 * FLOAT32_BYTES);
      const isStatic = load<f32>(nodeOffset + 3 * FLOAT32_BYTES);
      
      // Use provided position or random fallback
      store<f32>(positionOffset + 0 * FLOAT32_BYTES, !isFinite(x) ? f32(Math.random() * 2.0 - 1.0) : x);
      store<f32>(positionOffset + 1 * FLOAT32_BYTES, !isFinite(y) ? f32(Math.random() * 2.0 - 1.0) : y);
      store<f32>(positionOffset + 2 * FLOAT32_BYTES, !isFinite(z) ? f32(Math.random() * 2.0 - 1.0) : z);
      store<f32>(positionOffset + 3 * FLOAT32_BYTES, isStatic);
    } else {
      // Place extraneous nodes far away
      const farAway = frustumSize * 10.0;
      store<f32>(positionOffset + 0 * FLOAT32_BYTES, farAway);
      store<f32>(positionOffset + 1 * FLOAT32_BYTES, farAway);
      store<f32>(positionOffset + 2 * FLOAT32_BYTES, farAway);
      store<f32>(positionOffset + 3 * FLOAT32_BYTES, 0.0);
    }
  }
}

/**
 * Process links into texture data with UV coordinates
 * @param linksDataPtr Pointer to serialized link data (source, target indices)
 * @param linksCount Number of links
 * @param textureSize Power-of-2 texture size
 * @param linksTexturePtr Pointer to output links texture data
 */
export function processLinks(
  linksDataPtr: usize,
  linksCount: i32,
  nodesCount: i32,
  textureSize: i32,
  linksTexturePtr: usize,
  linkRangesTexturePtr: usize
): i32 {
  const totalElements = textureSize * textureSize;
  const textureSizeF = f32(textureSize);
  const texelStride = RGBA_COMPONENTS * FLOAT32_BYTES;

  for (let i = 0; i < totalElements; i++) {
    const linkOffset = linksTexturePtr + i * texelStride;
    const rangeOffset = linkRangesTexturePtr + i * texelStride;

    // Clear output textures before writing packed link data.
    store<f32>(linkOffset + 0 * FLOAT32_BYTES, 0.0);
    store<f32>(linkOffset + 1 * FLOAT32_BYTES, 0.0);
    store<f32>(linkOffset + 2 * FLOAT32_BYTES, 0.0);
    store<f32>(linkOffset + 3 * FLOAT32_BYTES, 0.0);
    store<f32>(rangeOffset + 0 * FLOAT32_BYTES, 0.0);
    store<f32>(rangeOffset + 1 * FLOAT32_BYTES, 0.0);
    store<f32>(rangeOffset + 2 * FLOAT32_BYTES, 0.0);
    store<f32>(rangeOffset + 3 * FLOAT32_BYTES, 0.0);
  }

  if (nodesCount <= 0) {
    return 0;
  }

  const intsSize = nodesCount * FLOAT32_BYTES;
  const degreeCountsPtr = heap.alloc(intsSize);
  const startOffsetsPtr = heap.alloc(intsSize);
  const cursorsPtr = heap.alloc(intsSize);

  for (let i = 0; i < nodesCount; i++) {
    const offset = i * FLOAT32_BYTES;
    store<i32>(degreeCountsPtr + offset, 0);
    store<i32>(startOffsetsPtr + offset, 0);
    store<i32>(cursorsPtr + offset, 0);
  }

  for (let i = 0; i < linksCount; i++) {
    const linkDataOffset = linksDataPtr + i * 2 * FLOAT32_BYTES;
    const sourceIndex = load<i32>(linkDataOffset + 0 * FLOAT32_BYTES);
    const targetIndex = load<i32>(linkDataOffset + 1 * FLOAT32_BYTES);

    const isValid =
      sourceIndex >= 0 &&
      sourceIndex < nodesCount &&
      targetIndex >= 0 &&
      targetIndex < nodesCount;

    if (!isValid) {
      continue;
    }

    const sourceOffset = sourceIndex * FLOAT32_BYTES;
    store<i32>(degreeCountsPtr + sourceOffset, load<i32>(degreeCountsPtr + sourceOffset) + 1);

    if (sourceIndex != targetIndex) {
      const targetOffset = targetIndex * FLOAT32_BYTES;
      store<i32>(degreeCountsPtr + targetOffset, load<i32>(degreeCountsPtr + targetOffset) + 1);
    }
  }

  let packedLinkAmount = 0;
  for (let i = 0; i < nodesCount; i++) {
    const nodeOffset = i * FLOAT32_BYTES;
    const count = load<i32>(degreeCountsPtr + nodeOffset);
    const start = packedLinkAmount;

    store<i32>(startOffsetsPtr + nodeOffset, start);
    store<i32>(cursorsPtr + nodeOffset, start);
    packedLinkAmount += count;

    const rangeOffset = linkRangesTexturePtr + i * texelStride;
    store<f32>(rangeOffset + 0 * FLOAT32_BYTES, f32(start));
    store<f32>(rangeOffset + 1 * FLOAT32_BYTES, f32(count));
  }

  if (packedLinkAmount > totalElements) {
    heap.free(degreeCountsPtr);
    heap.free(startOffsetsPtr);
    heap.free(cursorsPtr);
    return -1;
  }

  for (let i = 0; i < linksCount; i++) {
    const linkDataOffset = linksDataPtr + i * 2 * FLOAT32_BYTES;
    const sourceIndex = load<i32>(linkDataOffset + 0 * FLOAT32_BYTES);
    const targetIndex = load<i32>(linkDataOffset + 1 * FLOAT32_BYTES);

    const isValid =
      sourceIndex >= 0 &&
      sourceIndex < nodesCount &&
      targetIndex >= 0 &&
      targetIndex < nodesCount;

    if (!isValid) {
      continue;
    }

    const sourceOffset = sourceIndex * FLOAT32_BYTES;
    let sourceCursor = load<i32>(cursorsPtr + sourceOffset);
    store<i32>(cursorsPtr + sourceOffset, sourceCursor + 1);

    let linkOffset = linksTexturePtr + sourceCursor * texelStride;
    store<f32>(linkOffset + 0 * FLOAT32_BYTES, f32(sourceIndex % textureSize) / textureSizeF);
    store<f32>(linkOffset + 1 * FLOAT32_BYTES, f32(sourceIndex / textureSize) / textureSizeF);
    store<f32>(linkOffset + 2 * FLOAT32_BYTES, f32(targetIndex % textureSize) / textureSizeF);
    store<f32>(linkOffset + 3 * FLOAT32_BYTES, f32(targetIndex / textureSize) / textureSizeF);

    if (sourceIndex != targetIndex) {
      const targetOffset = targetIndex * FLOAT32_BYTES;
      let targetCursor = load<i32>(cursorsPtr + targetOffset);
      store<i32>(cursorsPtr + targetOffset, targetCursor + 1);

      linkOffset = linksTexturePtr + targetCursor * texelStride;
      store<f32>(linkOffset + 0 * FLOAT32_BYTES, f32(sourceIndex % textureSize) / textureSizeF);
      store<f32>(linkOffset + 1 * FLOAT32_BYTES, f32(sourceIndex / textureSize) / textureSizeF);
      store<f32>(linkOffset + 2 * FLOAT32_BYTES, f32(targetIndex % textureSize) / textureSizeF);
      store<f32>(linkOffset + 3 * FLOAT32_BYTES, f32(targetIndex / textureSize) / textureSizeF);
    }
  }

  heap.free(degreeCountsPtr);
  heap.free(startOffsetsPtr);
  heap.free(cursorsPtr);

  return packedLinkAmount;
}

/**
 * Combined processing function for both nodes and links
 * @param nodesDataPtr Pointer to serialized node data
 * @param nodesCount Number of nodes
 * @param linksDataPtr Pointer to serialized link data
 * @param linksCount Number of links
 * @param textureSize Power-of-2 texture size
 * @param positionsPtr Pointer to output positions texture data
 * @param linksTexturePtr Pointer to output links texture data
 * @param frustumSize Frustum size for out-of-bounds nodes
 */
export function processTextures(
  nodesDataPtr: usize,
  nodesCount: i32,
  linksDataPtr: usize,
  linksCount: i32,
  textureSize: i32,
  positionsPtr: usize,
  linksTexturePtr: usize,
  linkRangesTexturePtr: usize,
  frustumSize: f32
): i32 {
  processNodePositions(nodesDataPtr, nodesCount, textureSize, positionsPtr, frustumSize);
  return processLinks(
    linksDataPtr,
    linksCount,
    nodesCount,
    textureSize,
    linksTexturePtr,
    linkRangesTexturePtr
  );
}

/**
 * Allocate memory for texture data
 * @param size Size in bytes
 * @returns Pointer to allocated memory
 */
export function allocateMemory(size: i32): usize {
  return heap.alloc(size);
}

/**
 * Free allocated memory
 * @param ptr Pointer to memory to free
 */
export function freeMemory(ptr: usize): void {
  heap.free(ptr);
}

/**
 * Get memory usage statistics
 * @returns Memory usage in bytes
 */
export function getMemoryUsage(): i32 {
  return i32(memory.size() * 65536); // Pages to bytes
}

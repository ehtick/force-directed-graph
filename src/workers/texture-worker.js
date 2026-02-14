/**
 * Web Worker for texture processing using AssemblyScript WASM
 * Handles heavy texture data processing off the main thread
 */

import { instantiate } from '@assemblyscript/loader';

let wasmModule = null;
let wasmReady = false;

function buildLinkTextureData(links, nodeAmount, textureSize) {
  const totalElements = textureSize * textureSize;
  const linksData = new Float32Array(totalElements * 4);
  const linkRangesData = new Float32Array(totalElements * 4);
  const linksByNode = Array.from({ length: nodeAmount }, () => []);
  const packedLinks = [];

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const sourceIndex = link.sourceIndex;
    const targetIndex = link.targetIndex;
    const isValid =
      Number.isInteger(sourceIndex) &&
      Number.isInteger(targetIndex) &&
      sourceIndex >= 0 &&
      targetIndex >= 0 &&
      sourceIndex < nodeAmount &&
      targetIndex < nodeAmount;

    if (!isValid) {
      continue;
    }

    linksByNode[sourceIndex].push(link);
    if (targetIndex !== sourceIndex) {
      linksByNode[targetIndex].push(link);
    }
  }

  for (let i = 0; i < nodeAmount; i++) {
    const incident = linksByNode[i];
    const rangeOffset = i * 4;
    linkRangesData[rangeOffset + 0] = packedLinks.length;
    linkRangesData[rangeOffset + 1] = incident.length;

    for (let j = 0; j < incident.length; j++) {
      packedLinks.push(incident[j]);
    }
  }

  if (packedLinks.length > totalElements) {
    throw new Error(
      `Packed links (${packedLinks.length}) exceed texture capacity (${totalElements}).`
    );
  }

  for (let i = 0; i < packedLinks.length; i++) {
    const link = packedLinks[i];
    const sourceIndex = link.sourceIndex;
    const targetIndex = link.targetIndex;
    const linkOffset = i * 4;

    linksData[linkOffset + 0] = (sourceIndex % textureSize) / textureSize;
    linksData[linkOffset + 1] = Math.floor(sourceIndex / textureSize) / textureSize;
    linksData[linkOffset + 2] = (targetIndex % textureSize) / textureSize;
    linksData[linkOffset + 3] = Math.floor(targetIndex / textureSize) / textureSize;
  }

  return {
    linksData,
    linkRangesData,
    packedLinkAmount: packedLinks.length,
  };
}

/**
 * Initialize WASM module
 */
async function initWasm() {
  if (wasmReady) return;
  
  try {
    // Load WASM module
    const wasmUrl = new URL('../../build/texture-processor.wasm', import.meta.url);
    wasmModule = await instantiate(fetch(wasmUrl));
    wasmReady = true;
    
    self.postMessage({
      type: 'wasm-ready',
      success: true
    });
  } catch (error) {
    self.postMessage({
      type: 'wasm-ready',
      success: false,
      error: error.message
    });
  }
}

/**
 * Process texture data using WASM
 * @param {Object} data - Processing parameters
 */
async function processTextures(data) {
  const {
    nodes,
    links,
    textureSize,
    frustumSize,
    requestId
  } = data;
  
  if (!wasmReady) {
    await initWasm();
  }
  
  if (!wasmReady) {
    throw new Error('WASM module failed to initialize');
  }
  
  const startTime = performance.now();
  
  try {
    // Calculate memory requirements
    const totalElements = textureSize * textureSize;
    const nodesDataSize = nodes.length * 4 * 4; // 4 floats per node, 4 bytes per float
    const linksDataSize = links.length * 2 * 4; // 2 ints per link, 4 bytes per int
    const positionsSize = totalElements * 4 * 4; // 4 floats per element, 4 bytes per float
    const linksTextureSize = totalElements * 4 * 4; // 4 floats per element, 4 bytes per float
    const linkRangesTextureSize = totalElements * 4 * 4; // 4 floats per element, 4 bytes per float
    
    // Allocate memory in WASM
    const nodesDataPtr = wasmModule.exports.allocateMemory(nodesDataSize);
    const linksDataPtr = wasmModule.exports.allocateMemory(linksDataSize);
    const positionsPtr = wasmModule.exports.allocateMemory(positionsSize);
    const linksTexturePtr = wasmModule.exports.allocateMemory(linksTextureSize);
    const linkRangesTexturePtr = wasmModule.exports.allocateMemory(linkRangesTextureSize);
    
    // Prepare node data
    const nodesBuffer = new ArrayBuffer(nodesDataSize);
    const nodesView = new Float32Array(nodesBuffer);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const offset = i * 4;
      nodesView[offset + 0] = typeof node.x !== 'undefined' ? node.x : NaN;
      nodesView[offset + 1] = typeof node.y !== 'undefined' ? node.y : NaN;
      nodesView[offset + 2] = typeof node.z !== 'undefined' ? node.z : NaN;
      nodesView[offset + 3] = node.isStatic ? 1.0 : 0.0;
    }
    
    // Prepare links data
    const linksBuffer = new ArrayBuffer(linksDataSize);
    const linksView = new Int32Array(linksBuffer);
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const offset = i * 2;
      linksView[offset + 0] = link.sourceIndex;
      linksView[offset + 1] = link.targetIndex;
    }
    
    // Copy data to WASM memory
    const wasmMemory = wasmModule.exports.memory.buffer;
    new Uint8Array(wasmMemory, nodesDataPtr, nodesDataSize).set(new Uint8Array(nodesBuffer));
    new Uint8Array(wasmMemory, linksDataPtr, linksDataSize).set(new Uint8Array(linksBuffer));
    
    // Process textures in WASM
    const packedLinkAmount = wasmModule.exports.processTextures(
      nodesDataPtr,
      nodes.length,
      linksDataPtr,
      links.length,
      textureSize,
      positionsPtr,
      linksTexturePtr,
      linkRangesTexturePtr,
      frustumSize
    );

    if (packedLinkAmount < 0) {
      throw new Error('Packed links exceed texture capacity');
    }
    
    // Extract results
    const positionsData = new Float32Array(wasmMemory, positionsPtr, totalElements * 4);
    const linksTextureData = new Float32Array(wasmMemory, linksTexturePtr, totalElements * 4);
    const linkRangesTextureData = new Float32Array(wasmMemory, linkRangesTexturePtr, totalElements * 4);
    
    // Copy results to transferable buffers
    const positionsResult = new Float32Array(positionsData);
    const linksResult = new Float32Array(linksTextureData);
    const linkRangesResult = new Float32Array(linkRangesTextureData);
    
    // Free WASM memory
    wasmModule.exports.freeMemory(nodesDataPtr);
    wasmModule.exports.freeMemory(linksDataPtr);
    wasmModule.exports.freeMemory(positionsPtr);
    wasmModule.exports.freeMemory(linksTexturePtr);
    wasmModule.exports.freeMemory(linkRangesTexturePtr);
    
    const processingTime = performance.now() - startTime;
    
    // Send results back to main thread
    self.postMessage({
      type: 'texture-processed',
      requestId,
      success: true,
      data: {
        positions: positionsResult,
        links: linksResult,
        linkRanges: linkRangesResult,
        packedLinkAmount,
        processingTime,
        memoryUsage: wasmModule.exports.getMemoryUsage()
      }
    }, [positionsResult.buffer, linksResult.buffer, linkRangesResult.buffer]);
    
  } catch (error) {
    self.postMessage({
      type: 'texture-processed',
      requestId,
      success: false,
      error: error.message
    });
  }
}

/**
 * Fallback processing without WASM
 * @param {Object} data - Processing parameters
 */
function processFallback(data) {
  const {
    nodes,
    links,
    textureSize,
    frustumSize,
    requestId
  } = data;
  
  const startTime = performance.now();
  
  try {
    const totalElements = textureSize * textureSize;
    const positionsData = new Float32Array(totalElements * 4);
    
    // Process positions
    for (let i = 0; i < totalElements; i++) {
      const baseIndex = i * 4;
      
      if (i < nodes.length) {
        const node = nodes[i];
        const x = typeof node.x !== 'undefined' ? node.x : (Math.random() * 2 - 1);
        const y = typeof node.y !== 'undefined' ? node.y : (Math.random() * 2 - 1);
        const z = typeof node.z !== 'undefined' ? node.z : (Math.random() * 2 - 1);
        
        positionsData[baseIndex + 0] = x;
        positionsData[baseIndex + 1] = y;
        positionsData[baseIndex + 2] = z;
        positionsData[baseIndex + 3] = node.isStatic ? 1 : 0;
      } else {
        const farAway = frustumSize * 10;
        positionsData[baseIndex + 0] = farAway;
        positionsData[baseIndex + 1] = farAway;
        positionsData[baseIndex + 2] = farAway;
        positionsData[baseIndex + 3] = 0;
      }
    }
    
    const linkTextureData = buildLinkTextureData(links, nodes.length, textureSize);
    
    const processingTime = performance.now() - startTime;
    
    self.postMessage({
      type: 'texture-processed',
      requestId,
      success: true,
      data: {
        positions: positionsData,
        links: linkTextureData.linksData,
        linkRanges: linkTextureData.linkRangesData,
        packedLinkAmount: linkTextureData.packedLinkAmount,
        processingTime,
        memoryUsage: 0
      }
    }, [positionsData.buffer, linkTextureData.linksData.buffer, linkTextureData.linkRangesData.buffer]);
    
  } catch (error) {
    self.postMessage({
      type: 'texture-processed',
      requestId,
      success: false,
      error: error.message
    });
  }
}

// Message handler
self.onmessage = function(event) {
  const { type, data } = event.data;
  
  switch (type) {
    case 'init':
      initWasm();
      break;
      
    case 'process-textures':
      if (data.useWasm && wasmReady) {
        processTextures(data);
      } else {
        processFallback(data);
      }
      break;
      
    case 'check-wasm':
      self.postMessage({
        type: 'wasm-status',
        ready: wasmReady
      });
      break;
      
    default:
      self.postMessage({
        type: 'error',
        error: `Unknown message type: ${type}`
      });
  }
};

// Initialize WASM on worker start
initWasm();

/**
 * Factory for creating inline texture processing workers
 * This solves bundling issues by creating workers from Blob URLs
 */

/**
 * Creates worker code as a string for inline worker creation
 * @param {string} wasmUrl - URL to the WASM file (resolved relative to main module)
 */
function createWorkerCode(wasmUrl) {
  return `
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
      \`Packed links (\${packedLinks.length}) exceed texture capacity (\${totalElements}).\`
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
 * Initialize WASM module using provided URL
 */
async function initWasm() {
  if (wasmReady) return;
  
  try {
    // Load WASM module using the provided URL
    const wasmResponse = await fetch('${wasmUrl}');
    if (!wasmResponse.ok) {
      throw new Error(\`Failed to fetch WASM: \${wasmResponse.status}\`);
    }
    const wasmBytes = await wasmResponse.arrayBuffer();
    
    // AssemblyScript WASM modules need proper imports based on wasm-objdump output
    const imports = {
      env: {
        // env.seed: () -> f64 (for random number generation)
        seed: () => Math.random(),
        
        // env.abort: (i32, i32, i32, i32) -> nil (for error handling)
        abort: (message, fileName, line, column) => {
          const error = new Error(\`AssemblyScript abort: \${message} at \${fileName}:\${line}:\${column}\`);
          console.error(error);
          throw error;
        }
      },
      'texture-processor': {
        // texture-processor.__heap_base: global i32
        __heap_base: new WebAssembly.Global({ value: 'i32', mutable: false }, 1024)
      }
    };
    
    const wasmInstance = await WebAssembly.instantiate(wasmBytes, imports);
    
    wasmModule = wasmInstance.instance;
    wasmReady = true;
    
    self.postMessage({
      type: 'wasm-ready',
      success: true
    });
  } catch (error) {
    console.warn('WASM loading failed:', error);
    self.postMessage({
      type: 'wasm-ready',
      success: false,
      error: error.message
    });
  }
}

/**
 * Process texture data using WASM
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
    const nodesDataSize = nodes.length * 4 * 4;
    const linksDataSize = links.length * 2 * 4;
    const positionsSize = totalElements * 4 * 4;
    const linksTextureSize = totalElements * 4 * 4;
    const linkRangesTextureSize = totalElements * 4 * 4;
    
    const { allocateMemory, freeMemory, processTextures, memory } = wasmModule.exports;
    if (!allocateMemory || !freeMemory || !processTextures || !memory) {
      throw new Error('WASM exports are missing required texture processing functions');
    }

    let packedLinkAmount = 0;
    let nodesDataPtr = 0;
    let linksDataPtr = 0;
    let positionsPtr = 0;
    let linksTexturePtr = 0;
    let linkRangesTexturePtr = 0;
    let positionsResult = null;
    let linksResult = null;
    let linkRangesResult = null;
    
    try {
      nodesDataPtr = allocateMemory(nodesDataSize);
      linksDataPtr = allocateMemory(linksDataSize);
      positionsPtr = allocateMemory(positionsSize);
      linksTexturePtr = allocateMemory(linksTextureSize);
      linkRangesTexturePtr = allocateMemory(linkRangesTextureSize);
    
      // Prepare and copy node data
      const wasmMemory = new Uint8Array(memory.buffer);
      const nodesFloat32 = new Float32Array(nodes.length * 4);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const offset = i * 4;
        nodesFloat32[offset + 0] = typeof node.x !== 'undefined' ? node.x : NaN;
        nodesFloat32[offset + 1] = typeof node.y !== 'undefined' ? node.y : NaN;
        nodesFloat32[offset + 2] = typeof node.z !== 'undefined' ? node.z : NaN;
        nodesFloat32[offset + 3] = node.isStatic ? 1.0 : 0.0;
      }
      wasmMemory.set(new Uint8Array(nodesFloat32.buffer), nodesDataPtr);
      
      // Prepare and copy links data
      const linksInt32 = new Int32Array(links.length * 2);
      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const offset = i * 2;
        linksInt32[offset + 0] = link.sourceIndex;
        linksInt32[offset + 1] = link.targetIndex;
      }
      wasmMemory.set(new Uint8Array(linksInt32.buffer), linksDataPtr);
      
      // Process textures in WASM
      packedLinkAmount = processTextures(
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
      const positionsData = new Float32Array(memory.buffer, positionsPtr, totalElements * 4);
      const linksTextureData = new Float32Array(memory.buffer, linksTexturePtr, totalElements * 4);
      const linkRangesTextureData = new Float32Array(memory.buffer, linkRangesTexturePtr, totalElements * 4);
      
      // Copy results to transferable buffers
      positionsResult = new Float32Array(positionsData);
      linksResult = new Float32Array(linksTextureData);
      linkRangesResult = new Float32Array(linkRangesTextureData);
    } finally {
      if (linkRangesTexturePtr) freeMemory(linkRangesTexturePtr);
      if (linksTexturePtr) freeMemory(linksTexturePtr);
      if (positionsPtr) freeMemory(positionsPtr);
      if (linksDataPtr) freeMemory(linksDataPtr);
      if (nodesDataPtr) freeMemory(nodesDataPtr);
    }
    
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
        memoryUsage: memory.buffer.byteLength
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
        error: \`Unknown message type: \${type}\`
      });
  }
};

// Initialize WASM on worker start
initWasm();
`;
}

/**
 * Creates an inline worker using Blob URLs
 * @param {string} wasmUrl - URL to the WASM file
 * @returns {Worker} Created worker instance
 */
export function createInlineWorker(wasmUrl) {
  const workerCode = createWorkerCode(wasmUrl);
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);
  
  const worker = new Worker(workerUrl);
  
  // Clean up blob URL when worker terminates
  worker.addEventListener('error', () => URL.revokeObjectURL(workerUrl));
  
  return worker;
}

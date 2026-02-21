import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __TEST__ } from '../texture-worker.js';

describe('texture-worker fallback integration', () => {
  let posted;

  beforeEach(() => {
    posted = [];
    globalThis.self = {
      postMessage: vi.fn((message) => posted.push(message)),
    };
  });

  afterEach(() => {
    delete globalThis.self;
  });

  it('returns successful payload for empty graph', () => {
    __TEST__.processFallback({
      requestId: 42,
      nodes: [],
      links: [],
      textureSize: 4,
      frustumSize: 100,
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('texture-processed');
    expect(posted[0].success).toBe(true);
    expect(posted[0].data.packedLinkAmount).toBe(0);
    expect(posted[0].data.positions.length).toBe(4 * 4 * 4);
  });

  it('returns validation error type for invalid texture size', () => {
    __TEST__.processFallback({
      requestId: 99,
      nodes: [],
      links: [],
      textureSize: 3,
      frustumSize: 100,
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('texture-processed');
    expect(posted[0].success).toBe(false);
    expect(posted[0].errorType).toBe('validation');
    expect(posted[0].error).toMatch(/power of 2/i);
  });
});

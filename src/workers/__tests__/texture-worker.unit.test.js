import { describe, expect, it } from 'vitest';
import { __TEST__ } from '../texture-worker.js';

describe('texture-worker validation and packing', () => {
  it('computes packed link requirement with self-loops counted once', () => {
    const links = [
      { sourceIndex: 0, targetIndex: 0 },
      { sourceIndex: 0, targetIndex: 1 },
      { sourceIndex: 4, targetIndex: 1 },
    ];
    const packed = __TEST__.getPackedLinkRequirement(links, 2);
    expect(packed).toBe(3);
  });

  it('builds link texture data and node ranges deterministically', () => {
    const links = [
      { sourceIndex: 0, targetIndex: 0 },
      { sourceIndex: 0, targetIndex: 1 },
    ];
    const { linksData, linkRangesData, packedLinkAmount } = __TEST__.buildLinkTextureData(
      links,
      2,
      4
    );

    expect(packedLinkAmount).toBe(3);
    expect(linkRangesData[0]).toBe(0);
    expect(linkRangesData[1]).toBe(2);
    expect(linkRangesData[4]).toBe(2);
    expect(linkRangesData[5]).toBe(1);
    expect(linksData[0]).toBeCloseTo(0);
    expect(linksData[1]).toBeCloseTo(0);
    expect(linksData[2]).toBeCloseTo(0);
    expect(linksData[3]).toBeCloseTo(0);
  });

  it('rejects non-power-of-two texture sizes', () => {
    expect(() =>
      __TEST__.validateInput({
        nodes: [],
        links: [],
        textureSize: 3,
        frustumSize: 1,
      })
    ).toThrow(/power of 2/i);
  });

  it('rejects packed links that exceed texture capacity', () => {
    expect(() =>
      __TEST__.validateInput({
        nodes: [{}, {}],
        links: [{ sourceIndex: 0, targetIndex: 1 }],
        textureSize: 1,
        frustumSize: 1,
      })
    ).toThrow(/exceed texture capacity/i);
  });

  it('formats memory errors with memory errorType', () => {
    const result = __TEST__.formatProcessingError(new Error('out of memory while allocating'));
    expect(result.type).toBe('memory');
    expect(result.message).toMatch(/WASM memory failure/i);
  });
});

import { describe, expect, it } from 'vitest';
import { safeJsonParse } from './utils';

describe('safeJsonParse', () => {
  it('repairs unescaped double quotes inside JSON strings', () => {
    const parsed = safeJsonParse<{ outline: Array<{ title: string; goal: string; sourceHints: string[] }> }>(`{
      "outline": [
        {
          "title": "何处"不合时宜"——晴雯的性格底色",
          "goal": "揭示晴雯的"不合时宜"并非简单任性。",
          "sourceHints": ["宝玉常觉其"生成这等歪性”。"]
        }
      ]
    }`);
    expect(parsed?.outline[0].title).toBe('何处"不合时宜"——晴雯的性格底色');
    expect(parsed?.outline[0].goal).toContain('"不合时宜"');
    expect(parsed?.outline[0].sourceHints[0]).toContain('"生成这等歪性”');
  });
});

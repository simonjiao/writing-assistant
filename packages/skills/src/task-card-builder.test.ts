import { describe, expect, it } from 'vitest';
import { buildHeuristicTaskCard } from './task-card-builder';

describe('buildHeuristicTaskCard', () => {
  it('creates a local-edit-first task card', () => {
    const output = buildHeuristicTaskCard('写一篇关于宝黛关系的长文，半文半白，不要太学术');
    expect(output.taskCard.interactionMode.localEditFirst).toBe(true);
    expect(output.taskCard.style.classicalFlavor).toBe(true);
    expect(output.taskCard.structure.articleType).toBe('longform');
  });
});

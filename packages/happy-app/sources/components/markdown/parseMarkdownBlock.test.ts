import { describe, expect, it } from 'vitest';
import { parseMarkdownBlock } from './parseMarkdownBlock';

describe('parseMarkdownBlock mermaid', () => {
    it('should parse lowercase mermaid fence as mermaid block', () => {
        const markdown = [
            '```mermaid',
            'flowchart TD',
            'A[Start] --> B[End]',
            '```',
        ].join('\n');

        expect(parseMarkdownBlock(markdown)).toEqual([
            {
                type: 'mermaid',
                content: 'flowchart TD\nA[Start] --> B[End]',
            },
        ]);
    });

    it('should parse case-insensitive mermaid fence with extra info', () => {
        const markdown = [
            '```Mermaid title=demo',
            'graph TD',
            'A --> B',
            '```',
        ].join('\n');

        expect(parseMarkdownBlock(markdown)).toEqual([
            {
                type: 'mermaid',
                content: 'graph TD\nA --> B',
            },
        ]);
    });

    it('should keep non-mermaid fences as code blocks', () => {
        const markdown = [
            '```typescript',
            'const value = 1;',
            '```',
        ].join('\n');

        expect(parseMarkdownBlock(markdown)).toEqual([
            {
                type: 'code-block',
                language: 'typescript',
                content: 'const value = 1;',
            },
        ]);
    });
});

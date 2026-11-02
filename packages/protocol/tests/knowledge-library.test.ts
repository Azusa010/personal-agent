import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KnowledgeImportParams, KnowledgeImportResult, KnowledgeListResult, KnowledgeSearchParams, KnowledgeSearchResult } from '../schemas/knowledge';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/knowledge-library.json', import.meta.url), 'utf8'));
describe('knowledge library contract', () => {
  it('parses the shared import/list/search fixtures', () => {
    expect(KnowledgeImportParams.parse(fixture.importParams).mode).toBe('viking');
    expect(KnowledgeImportResult.parse(fixture.importResult).entries[0].status).toBe('indexed');
    expect(KnowledgeListResult.parse(fixture.listResult).documents[0].chunkCount).toBe(2);
    expect(KnowledgeSearchParams.parse(fixture.searchParams).mode).toBe('viking');
    expect(KnowledgeSearchResult.parse(fixture.searchResult).warnings).toHaveLength(1);
  });
  it.each(['traditional', 'raptor', 'viking'])('accepts %s', (mode) => {
    expect(KnowledgeImportParams.parse({ paths: ['a.md'], mode }).mode).toBe(mode);
  });
  it('rejects invalid modes, empty paths and oversized batches', () => {
    for (const input of [{paths: [], mode: 'viking'}, {paths: [' '], mode: 'viking'}, {paths: ['a.md'], mode: 'other'}, {paths: Array(101).fill('a.md'), mode: 'viking'}]) {
      expect(KnowledgeImportParams.safeParse(input).success).toBe(false);
    }
  });
});

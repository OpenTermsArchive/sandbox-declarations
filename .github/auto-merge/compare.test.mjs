import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assess, compare } from './compare.mjs';

const THRESHOLDS = { minSimilarity: 0.7, minSizeRatio: 0.6, maxSizeRatio: 1.6 };
const sentence = index => `Clause ${index}: the user agrees to condition number ${index} of this agreement.`;
const document = (from, to) => Array.from({ length: to - from }, (_, index) => sentence(from + index)).join('\n\n');

describe('compare', () => {
  const reference = document(0, 100);

  it('accepts the same text with other link targets and markup', () => {
    const produced = reference.replace('Clause 3', '[Clause 3](https://service.example/?utm=1)').replace(/\n\n/g, '\n\n- ');

    assert.equal(assess(compare(produced, reference), THRESHOLDS), null);
  });

  it('accepts a text with a few changed clauses', () => {
    assert.equal(assess(compare(document(5, 105), reference), THRESHOLDS), null);
  });

  it('refuses a text drowned in navigation and footers', () => {
    assert.match(assess(compare(`${document(500, 700)}\n${reference}`, reference), THRESHOLDS), /longer/);
  });

  it('refuses a text reduced to a fragment', () => {
    assert.match(assess(compare(document(0, 20), reference), THRESHOLDS), /shorter/);
  });

  it('refuses another text of the same length', () => {
    assert.match(assess(compare(document(1000, 1100).replaceAll('agrees to condition', 'accepts cookie'), reference), THRESHOLDS), /differs too much/);
  });

  it('refuses an empty version', () => {
    assert.match(assess(compare('', reference), THRESHOLDS), /shorter/);
  });
});

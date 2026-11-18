const SHINGLE_SIZE = 3;

export function words(markdown) {
  return markdown
    .replace(/\]\([^)]*\)/g, ']') // link targets change with tracking parameters while the text stays the same
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function shingles(wordList) {
  const counts = new Map();

  for (let index = 0; index <= wordList.length - SHINGLE_SIZE; index++) {
    const shingle = wordList.slice(index, index + SHINGLE_SIZE).join(' ');

    counts.set(shingle, (counts.get(shingle) ?? 0) + 1);
  }

  return counts;
}

export function compare(produced, reference) {
  const producedWords = words(produced);
  const referenceWords = words(reference);
  const producedShingles = shingles(producedWords);
  const referenceShingles = shingles(referenceWords);
  let shared = 0;

  for (const [ shingle, count ] of producedShingles) {
    shared += Math.min(count, referenceShingles.get(shingle) ?? 0);
  }

  const total = Math.max(producedWords.length - SHINGLE_SIZE + 1, 0) + Math.max(referenceWords.length - SHINGLE_SIZE + 1, 0);

  return {
    similarity: total ? (2 * shared) / total : 0,
    sizeRatio: referenceWords.length ? producedWords.length / referenceWords.length : Infinity,
  };
}

export function assess({ similarity, sizeRatio }, { minSimilarity, minSizeRatio, maxSizeRatio }) {
  if (sizeRatio < minSizeRatio) {
    return 'the version is much shorter than the last recorded one';
  }

  if (sizeRatio > maxSizeRatio) {
    return 'the version is much longer than the last recorded one';
  }

  if (similarity < minSimilarity) {
    return 'the version differs too much from the last recorded one';
  }

  return null;
}

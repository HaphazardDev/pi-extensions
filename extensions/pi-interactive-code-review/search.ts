import type { DiffFile, DiffSearchMatch, FileJumpMatch, SearchTargetMatch } from "./types.js";

function basenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

function contiguousPositions(start: number, length: number): number[] {
  return Array.from({ length }, (_, index) => start + index);
}

export function fuzzySubsequenceMatch(query: string, target: string): SearchTargetMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };

  let queryIndex = 0;
  let score = 0;
  let lastMatchIndex = -1;
  const positions: number[] = [];

  for (let i = 0; i < target.length && queryIndex < query.length; i++) {
    if (target[i] !== query[queryIndex]) continue;

    score += 10;
    if (i === 0 || "/._- ".includes(target[i - 1] ?? "")) score += 18;
    if (lastMatchIndex === i - 1) score += 14;
    else if (lastMatchIndex >= 0) score -= Math.min(6, i - lastMatchIndex - 1);

    positions.push(i);
    lastMatchIndex = i;
    queryIndex++;
  }

  if (queryIndex !== query.length) return null;
  score -= Math.max(0, target.length - query.length);
  return { score: 140 + score, positions };
}

function matchSearchTarget(query: string, target: string): SearchTargetMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };
  if (target.length === 0) return null;

  if (target === query) return { score: 600 - target.length, positions: contiguousPositions(0, query.length) };
  if (target.startsWith(query)) return { score: 450 - Math.max(0, target.length - query.length), positions: contiguousPositions(0, query.length) };

  const substringIndex = target.indexOf(query);
  if (substringIndex >= 0) {
    const boundaryBonus = substringIndex === 0 || "/._- ".includes(target[substringIndex - 1] ?? "") ? 40 : 0;
    return {
      score: 320 + boundaryBonus - substringIndex,
      positions: contiguousPositions(substringIndex, query.length),
    };
  }

  return fuzzySubsequenceMatch(query, target);
}

function remapPositionsToDisplay(source: string, display: string, positions: number[], preferLast = false): number[] {
  if (positions.length === 0) return [];
  const sourceIndex = preferLast ? display.lastIndexOf(source) : display.indexOf(source);
  if (sourceIndex < 0) return [];
  return positions.map((position) => sourceIndex + position).filter((position) => position >= 0 && position < display.length);
}

function uniqueSortedPositions(positions: Iterable<number>): number[] {
  return Array.from(new Set(positions)).sort((a, b) => a - b);
}

function findSubstringMatchPositions(text: string, query: string): number[][] {
  if (!query) return [];

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matches: number[][] = [];
  let searchIndex = 0;

  while (searchIndex <= lowerText.length - lowerQuery.length) {
    const matchIndex = lowerText.indexOf(lowerQuery, searchIndex);
    if (matchIndex < 0) break;
    matches.push(contiguousPositions(matchIndex, lowerQuery.length));
    searchIndex = matchIndex + Math.max(1, lowerQuery.length);
  }

  return matches;
}

export function findDiffSearchMatches(file: DiffFile | undefined, query: string): DiffSearchMatch[] {
  if (!file || !query.trim()) return [];

  const matches: DiffSearchMatch[] = [];
  file.hunks.forEach((hunk, hunkIndex) => {
    hunk.lines.forEach((line, lineIndex) => {
      for (const positions of findSubstringMatchPositions(line.text, query.trim())) {
        matches.push({ hunkIndex, lineIndex, positions });
      }
    });
  });

  return matches;
}

export function scoreFileJumpMatch(query: string, file: DiffFile): FileJumpMatch | null {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) {
    return { score: 0, labelPositions: [], descriptionPositions: [] };
  }

  const basename = basenameFromPath(file.filePath).toLowerCase();
  const displayPath = file.displayPath.toLowerCase();
  const labelPositions: number[] = [];

  let totalScore = 0;
  for (const term of terms) {
    const match = matchSearchTarget(term, basename);
    if (match === null) return null;

    totalScore += match.score;
    labelPositions.push(...remapPositionsToDisplay(basename, displayPath, match.positions, true));
  }

  totalScore -= Math.max(0, basename.length - query.replace(/\s+/g, "").length);
  return {
    score: totalScore,
    labelPositions: uniqueSortedPositions(labelPositions),
    descriptionPositions: [],
  };
}

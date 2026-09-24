"use strict";

const CUE_PATTERN = /^\s*\[([^\]]+)]\s*$/;

function normalizeWord(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}']/gu, "")
    .replace(/^'+|'+$/g, "");
}

function tokenize(value) {
  return String(value || "")
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);
}

function parseScript(text) {
  const blocks = [];
  const words = [];
  let wordIndex = 0;
  const chunks = String(text || "").replace(/\r/g, "").replace(/^\s*(\[[^\]\n]+])\s*$/gm, "\n\n$1\n\n").split(/\n\s*\n/);

  for (const raw of chunks) {
    const value = raw.trim();
    if (!value) continue;
    const cue = value.match(CUE_PATTERN);
    if (cue) {
      blocks.push({ type: "cue", text: cue[1].trim(), start: wordIndex, end: wordIndex });
      continue;
    }

    const sentences = value.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [value];
    for (const sentenceValue of sentences) {
      const sentence = sentenceValue.trim();
      if (!sentence) continue;
      const sentenceWords = tokenize(sentence);
      if (!sentenceWords.length) continue;
      const start = wordIndex;
      sentenceWords.forEach((word) => words.push({ word, sentence: blocks.length, index: wordIndex++ }));
      blocks.push({ type: "speech", text: sentence, start, end: wordIndex - 1, words: sentenceWords });
    }
  }

  return { blocks, words, wordCount: words.length };
}

function levenshtein(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

function wordSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (a.length > 4 && b.length > 4 && (a.startsWith(b) || b.startsWith(a))) return 0.82;
  return Math.max(0, 1 - levenshtein(a, b) / Math.max(a.length, b.length));
}

function scoreWindow(spoken, expected) {
  if (!spoken.length || !expected.length) return { confidence: 0, consumed: 0 };
  let matches = 0;
  let cursor = 0;
  for (const word of spoken) {
    let best = 0;
    let bestIndex = cursor;
    const limit = Math.min(expected.length, cursor + 5);
    for (let i = cursor; i < limit; i += 1) {
      const similarity = wordSimilarity(word, expected[i]);
      const penalty = (i - cursor) * 0.06;
      if (similarity - penalty > best) {
        best = similarity - penalty;
        bestIndex = i;
      }
    }
    if (best >= 0.55) {
      matches += best;
      cursor = bestIndex + 1;
    }
  }
  return { confidence: matches / Math.max(spoken.length, expected.length * 0.65), consumed: cursor };
}

function findPosition(scriptWords, transcript, currentPosition = 0, options = {}) {
  const spoken = tokenize(transcript).slice(-Math.max(4, options.transcriptWords || 18));
  if (!spoken.length || !scriptWords.length) return { position: currentPosition, confidence: 0 };
  const words = scriptWords.map((entry) => typeof entry === "string" ? entry : entry.word);
  const localRadius = options.localRadius || 90;
  const candidateLength = Math.min(words.length, spoken.length + 7);

  const evaluate = (from, to, distanceWeight) => {
    let best = { position: currentPosition, confidence: 0, score: -Infinity };
    for (let start = from; start <= to; start += 1) {
      const expected = words.slice(start, start + candidateLength);
      const alignment = scoreWindow(spoken, expected);
      const raw = alignment.confidence;
      const distance = Math.abs(start - currentPosition);
      const weighted = raw - distance * distanceWeight;
      if (weighted > best.score) {
        best = {
          position: Math.min(words.length - 1, start + Math.max(0, alignment.consumed - 1)),
          confidence: Math.max(0, Math.min(1, raw)),
          score: weighted
        };
      }
    }
    return best;
  };

  const local = evaluate(Math.max(0, currentPosition - localRadius), Math.min(words.length - 1, currentPosition + localRadius), 0.0008);
  if (local.confidence >= (options.localThreshold || 0.48)) return local;

  const global = evaluate(0, words.length - 1, 0);
  return global.confidence > local.confidence + 0.08 ? global : local;
}

module.exports = { parseScript, tokenize, findPosition, wordSimilarity };

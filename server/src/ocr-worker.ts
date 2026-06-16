import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import db from './db.js';

const BULLET_GLYPHS = /^([eoc©®™\*\.\_\-\+~>])\s+(?=\S)/;
const BRACKET_BULLETS = /^\[[Jj]\]?\s+(?=\S)/;

function fixBullets(text: string): string {
  const lines = text.split('\n');
  let bulletCount = 0;

  for (const line of lines) {
    if (BULLET_GLYPHS.test(line.trim()) || BRACKET_BULLETS.test(line.trim())) {
      bulletCount++;
    }
  }

  if (bulletCount < 2) return text;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const mSingle = trimmed.match(BULLET_GLYPHS);
    const mBracket = trimmed.match(BRACKET_BULLETS);
    const m = mSingle || mBracket;
    if (!m) continue;

    let hasNeighbor = false;
    for (let j = i - 2; j <= i + 2; j++) {
      if (j === i || j < 0 || j >= lines.length) continue;
      if (BULLET_GLYPHS.test(lines[j].trim()) || BRACKET_BULLETS.test(lines[j].trim())) {
        hasNeighbor = true;
        break;
      }
    }

    const prevBlank = i > 0 && lines[i - 1].trim() === '';

    if (hasNeighbor || prevBlank) {
      lines[i] = `\u2022 ${lines[i].trim().slice(m[0].length)}`;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const cleaned = lines[i].trim().replace(/^[\u2022\s]+/, '');
    if (!/^\[[Jj]\]?\s*$/.test(cleaned)) continue;

    let nextIdx = i + 1;
    while (nextIdx < lines.length && lines[nextIdx].trim() === '') {
      nextIdx++;
    }
    if (nextIdx >= lines.length) continue;

    const nextText = lines[nextIdx].trim();
    if (!nextText) continue;

    const parts = nextText.split(/\s{3,}/);
    const left = parts[0];
    const right = parts.slice(1).join('   ');

    let currentBracketCount = 0;
    for (let j = i; j >= 0; j--) {
      const c = lines[j].trim().replace(/^[\u2022\s]+/, '');
      if (/^\[[Jj]\]?\s*$/.test(c)) {
        currentBracketCount++;
        lines[j] = '';
      } else if (lines[j].trim() !== '') {
        break;
      }
    }

    if (currentBracketCount >= 2 && right) {
      lines[nextIdx] = `\u2022 ${left}   \u2022 ${right}`;
    } else {
      lines[nextIdx] = `\u2022 ${nextText}`;
    }

    lines[i] = '';
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function cleanText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      if (line.length === 1 && !/[a-zA-Z0-9]/.test(line)) return false;
      const alphaCount = (line.match(/[a-zA-Z0-9]/g) || []).length;
      if (alphaCount / line.length < 0.3 && line.length > 2) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ── Multi-strategy OCR engine ──────────────────────────────────────────────

interface StrategyResult {
  text: string;
  confidence: number;
  strategyName: string;
  regionName?: string;
}

interface OcrOptions {
  invert?: boolean;
  normalize?: boolean;
  threshold?: number | null;
  sharpen?: boolean;
  gamma?: number;
  linear?: { multiplier: number; offset: number };
  channel?: 'red' | 'green' | 'blue';
  edgeDetect?: boolean;
  median?: number;
  scale?: number;
  resizeWidth?: number;
  region?: CropRegion;
}

interface CropRegion {
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface StrategyDef {
  options: OcrOptions;
  psm: PSM;
  name: string;
}

/**
 * Score a result for ranking: prefer more meaningful characters at higher confidence.
 * Logos often have short text, so we don't penalise short strings harshly.
 */
function scoreResult(text: string, confidence: number): number {
  const t = text.trim();
  if (t.length === 0) return -1;
  const meaningfulChars = (t.match(/[a-zA-Z0-9]/g) || []).length;
  const wordishTokens = (t.match(/[a-zA-Z0-9]{2,}/g) || []).length;
  const alnumRatio = meaningfulChars / Math.max(t.length, 1);
  const confidenceWeight = Math.pow(Math.max(0, confidence - 20) / 80, 1.5);
  const signal = Math.min(meaningfulChars, 240) + Math.min(wordishTokens, 40) * 4;

  return signal * confidenceWeight * Math.max(0.2, alnumRatio);
}

function cropFromFractions(
  name: string,
  imageWidth: number,
  imageHeight: number,
  left: number,
  top: number,
  width: number,
  height: number
): CropRegion {
  const x = Math.max(0, Math.floor(imageWidth * left));
  const y = Math.max(0, Math.floor(imageHeight * top));
  const right = Math.min(imageWidth, Math.ceil(imageWidth * (left + width)));
  const bottom = Math.min(imageHeight, Math.ceil(imageHeight * (top + height)));

  return {
    name,
    left: x,
    top: y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function buildDisplayRegions(imageWidth: number, imageHeight: number): CropRegion[] {
  return [
    cropFromFractions('top_full', imageWidth, imageHeight, 0, 0, 1, 0.34),
    cropFromFractions('top_center', imageWidth, imageHeight, 0.12, 0.02, 0.7, 0.28),
    cropFromFractions('top_right', imageWidth, imageHeight, 0.45, 0.02, 0.55, 0.28),
    cropFromFractions('upper_mid_full', imageWidth, imageHeight, 0, 0.22, 1, 0.34),
    cropFromFractions('middle_full', imageWidth, imageHeight, 0, 0.38, 1, 0.34),
    cropFromFractions('middle_center', imageWidth, imageHeight, 0.12, 0.34, 0.76, 0.28),
    cropFromFractions('lower_full', imageWidth, imageHeight, 0, 0.56, 1, 0.34),
    cropFromFractions('bottom_full', imageWidth, imageHeight, 0, 0.72, 1, 0.28),
  ];
}

function normaliseLineKey(line: string): string {
  return line.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isMostlyNumericLine(line: string): boolean {
  const compact = line.replace(/\s/g, '');
  if (compact.length < 4) return false;
  const digits = (compact.match(/\d/g) || []).length;
  return digits / compact.length >= 0.6;
}

function normaliseDigitLikeKey(line: string): string {
  return line
    .toUpperCase()
    .replace(/[OQ]/g, '0')
    .replace(/[IL|]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8')
    .replace(/Z/g, '2')
    .replace(/G/g, '6')
    .replace(/[^0-9]/g, '');
}

function areDuplicateKeys(left: string, right: string, leftDigitKey: string, rightDigitKey: string): boolean {
  if (left === right) return true;
  if (left.length >= 5 && left.includes(right)) return true;
  if (right.length >= 5 && right.includes(left)) return true;

  if (leftDigitKey.length >= 6 && rightDigitKey.length >= 6) {
    if (leftDigitKey.includes(rightDigitKey) || rightDigitKey.includes(leftDigitKey)) return true;
    return leftDigitKey.slice(0, 6) === rightDigitKey.slice(0, 6);
  }

  return false;
}

function isUsefulLine(line: string, confidence: number, isRegional: boolean, hasReliableResult: boolean): boolean {
  const key = normaliseLineKey(line);
  if (key.length < 3) return false;

  const meaningfulChars = (line.match(/[a-zA-Z0-9]/g) || []).length;
  const alnumRatio = meaningfulChars / Math.max(line.length, 1);
  const punctuationNoise = (line.match(/[\[\]{}|_<>]/g) || []).length;
  const isShortMixedFragment = key.length < 4 && /[A-Z]/.test(key) && /\d/.test(key);

  if (punctuationNoise > 0 && alnumRatio < 0.75) return false;
  if (isShortMixedFragment) return false;

  if (key.length < 4) {
    return isRegional && confidence >= 75 && /^[A-Z]+$/.test(key);
  }

  if (confidence >= 55 && alnumRatio >= 0.55) return true;
  if (isRegional && confidence >= 45 && isMostlyNumericLine(line)) return true;
  if (isRegional && confidence >= 45 && line.length >= 8 && alnumRatio >= 0.72) return true;

  return !hasReliableResult && confidence >= 30 && alnumRatio >= 0.45;
}

function mergeResultText(results: StrategyResult[], fallback: StrategyResult): string {
  const hasReliableResult = results.some((result) => result.confidence >= 55 && cleanText(result.text).length > 0);
  const candidates: Array<{ line: string; key: string; digitKey: string; score: number; order: number }> = [];
  const selected: Array<{ line: string; key: string; digitKey: string; order: number }> = [];

  for (const [resultIndex, result] of results.entries()) {
    const isRegional = result.regionName != null;
    const cleaned = cleanText(fixBullets(result.text));
    if (!cleaned) continue;

    for (const [lineIndex, rawLine] of cleaned.split('\n').entries()) {
      const line = rawLine.replace(/\s{2,}/g, ' ').trim();
      const key = normaliseLineKey(line);
      if (!isUsefulLine(line, result.confidence, isRegional, hasReliableResult)) continue;

      candidates.push({
        line,
        key,
        digitKey: normaliseDigitLikeKey(line),
        score: scoreResult(line, result.confidence) + (isRegional ? 4 : 0),
        order: (isRegional ? 0 : 10_000) + resultIndex * 100 + lineIndex,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    const duplicateIndex = selected.findIndex((existing) =>
      areDuplicateKeys(existing.key, candidate.key, existing.digitKey, candidate.digitKey)
    );

    if (duplicateIndex >= 0) {
      const existing = selected[duplicateIndex];
      const candidateIsMoreComplete = candidate.key.length >= existing.key.length + 4 && candidate.key.includes(existing.key);
      if (!candidateIsMoreComplete) continue;

      selected.splice(duplicateIndex, 1);
    }

    selected.push(candidate);

    if (selected.length >= 40) break;
  }

  if (selected.length > 0) {
    return selected
      .sort((a, b) => a.order - b.order)
      .map((candidate) => candidate.line)
      .join('\n');
  }

  return cleanText(fixBullets(fallback.text));
}

async function runOcrWithOptions(
  worker: Awaited<ReturnType<typeof createWorker>>,
  baseImagePath: string,
  psm: PSM,
  options: OcrOptions,
  strategyName: string,
  tempDir: string
): Promise<StrategyResult> {
  const safeName = strategyName.replace(/[^a-z0-9]/gi, '_');
  const tempPath = path.join(tempDir, `ocr_${safeName}.png`);

  let pipeline = sharp(baseImagePath);

  if (options.region) {
    pipeline = pipeline.extract({
      left: options.region.left,
      top: options.region.top,
      width: options.region.width,
      height: options.region.height,
    });
  }

  if (options.resizeWidth) {
    pipeline = pipeline.resize({
      width: options.resizeWidth,
      withoutEnlargement: false,
    });
  } else if (options.scale && options.scale !== 1) {
    pipeline = pipeline.resize({
      width: Math.round(3000 * options.scale),
      withoutEnlargement: true,
    });
  }

  if (options.channel) {
    pipeline = pipeline.extractChannel(options.channel);
  }

  if (options.invert) {
    pipeline = pipeline.negate();
  }

  if (!options.channel) {
    pipeline = pipeline.grayscale();
  }

  if (options.edgeDetect) {
    pipeline = pipeline.convolve({
      width: 3,
      height: 3,
      kernel: [0, -1, 0, -1, 4, -1, 0, -1, 0],
      scale: 1,
    });
  }

  if (options.median) {
    pipeline = pipeline.median(options.median);
  }

  if (options.gamma) {
    pipeline = pipeline.gamma(options.gamma);
  }

  if (options.linear) {
    pipeline = pipeline.linear(options.linear.multiplier, options.linear.offset);
  }

  if (options.normalize) {
    pipeline = pipeline.normalize();
  }

  if (options.sharpen) {
    pipeline = pipeline.sharpen();
  }

  if (options.threshold != null) {
    pipeline = pipeline.threshold(options.threshold);
  }

  await pipeline.png().toFile(tempPath);

  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: '1',
    textord_tabfind_find_tables: '0',
    classify_bln_numeric_mode: '0',
    user_defined_dpi: '300',
  });

  const { data } = await worker.recognize(tempPath);

  try { fs.unlinkSync(tempPath); } catch { /* ignore */ }

  return {
    text: data.text.normalize('NFC'),
    confidence: data.confidence,
    strategyName,
    regionName: options.region?.name,
  };
}

function pickBestResult(results: StrategyResult[]): StrategyResult {
  let best = results[0];
  let bestScore = scoreResult(best.text, best.confidence);

  for (let i = 1; i < results.length; i++) {
    const score = scoreResult(results[i].text, results[i].confidence);
    if (score > bestScore) {
      best = results[i];
      bestScore = score;
    }
  }

  return best;
}

/**
 * Ordered list of OCR strategies optimised for logo / designed / effect text.
 * Most-likely-to-succeed strategies come first so we can early-exit.
 */
function buildBaseStrategies(): StrategyDef[] {
  return [
    // ── Normalised (adaptive, lossless) ──────────────────────────────
    { options: { normalize: true },                       psm: PSM.AUTO,        name: 'norm_auto' },
    { options: { normalize: true },                       psm: PSM.SPARSE_TEXT,  name: 'norm_sparse' },
    { options: { normalize: true, sharpen: true },        psm: PSM.AUTO,        name: 'sharp_norm_auto' },
    { options: { invert: true, normalize: true },         psm: PSM.AUTO,        name: 'inv_norm_auto' },
    { options: { normalize: true },                       psm: PSM.SINGLE_BLOCK, name: 'norm_block' },
    { options: { normalize: true, resizeWidth: 1800 },     psm: PSM.SPARSE_TEXT,  name: 'norm_1800_sparse' },
    { options: { normalize: true, resizeWidth: 1200 },     psm: PSM.SPARSE_TEXT,  name: 'norm_1200_sparse' },

    // ── Gamma boost – brings out low-contrast text ──────────────────
    { options: { gamma: 1.6, normalize: true },           psm: PSM.AUTO,        name: 'gamma_auto' },
    { options: { linear: { multiplier: 1.6, offset: -45 }, normalize: true }, psm: PSM.SPARSE_TEXT, name: 'contrast_sparse' },

    // ── Down-scaled – catches very large display text ──────────────
    { options: { normalize: true, scale: 0.5 },           psm: PSM.AUTO,        name: 'half_norm_auto' },
    { options: { normalize: true, scale: 0.5 },           psm: PSM.SPARSE_TEXT,  name: 'half_norm_sparse' },

    // ── Multi-threshold – catches faint / bold extremes ────────────
    { options: { normalize: true, threshold: 80 },        psm: PSM.AUTO,        name: 'thresh80' },
    { options: { normalize: true, threshold: 200 },       psm: PSM.AUTO,        name: 'thresh200' },

    // ── Edge detection – outlined / stylised / effect text ──────────
    { options: { edgeDetect: true, normalize: true, threshold: 128 }, psm: PSM.AUTO, name: 'edge_auto' },
    { options: { edgeDetect: true, normalize: true },               psm: PSM.SPARSE_TEXT, name: 'edge_sparse' },

    // ── Colour channel extraction – coloured text on coloured bg ───
    { options: { channel: 'green', normalize: true },     psm: PSM.AUTO,        name: 'green_auto' },
    { options: { channel: 'red', normalize: true },       psm: PSM.AUTO,        name: 'red_auto' },
    { options: { channel: 'blue', normalize: true },      psm: PSM.AUTO,        name: 'blue_auto' },

    // ── Median + threshold – textured / noisy backgrounds ──────────
    { options: { median: 3, normalize: true, threshold: 128 }, psm: PSM.AUTO, name: 'median_auto' },
  ];
}

function buildRegionalStrategies(imageWidth: number, imageHeight: number): StrategyDef[] {
  const strategies: StrategyDef[] = [];

  for (const region of buildDisplayRegions(imageWidth, imageHeight)) {
    strategies.push(
      { options: { region, normalize: true, resizeWidth: 1800 }, psm: PSM.SPARSE_TEXT, name: `${region.name}_norm_sparse` },
      { options: { region, normalize: true, resizeWidth: 1800 }, psm: PSM.RAW_LINE, name: `${region.name}_norm_raw` },
      { options: { region, normalize: true, threshold: 180, resizeWidth: 1800 }, psm: PSM.RAW_LINE, name: `${region.name}_thresh_raw` },
      { options: { region, channel: 'red', normalize: true, resizeWidth: 1800 }, psm: PSM.RAW_LINE, name: `${region.name}_red_raw` },
      { options: { region, channel: 'blue', normalize: true, resizeWidth: 1800 }, psm: PSM.RAW_LINE, name: `${region.name}_blue_raw` },
    );
  }

  return strategies;
}

function shouldRunRegionalPasses(results: StrategyResult[]): boolean {
  if (results.length === 0) return true;

  const best = pickBestResult(results);
  const cleaned = cleanText(best.text);
  const meaningfulChars = (cleaned.match(/[a-zA-Z0-9]/g) || []).length;

  return best.confidence < 75 || meaningfulChars < 50 || scoreResult(best.text, best.confidence) < 40;
}

// ── Public entry-point ─────────────────────────────────────────────────────

export async function processDocument(
  documentId: string,
  imagePath: string
): Promise<void> {
  console.log(`[OCR] Processing document ${documentId}: ${imagePath}`);

  db.prepare('UPDATE documents SET status = ? WHERE id = ?').run('processing', documentId);

  const uploadsDir = path.join(import.meta.dirname, '..', 'uploads');
  const basePreprocessedPath = path.join(uploadsDir, `preprocessed_${documentId}.png`);

  await sharp(imagePath)
    .resize({ width: 3000 })
    .extend({
      top: 40, bottom: 40, left: 40, right: 40,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toFile(basePreprocessedPath);

  const results: StrategyResult[] = [];
  const metadata = await sharp(basePreprocessedPath).metadata();
  const imageWidth = metadata.width ?? 3000;
  const imageHeight = metadata.height ?? 3000;
  const worker = await createWorker('eng');

  try {
    for (const s of buildBaseStrategies()) {
      console.log(`[OCR]  → ${s.name} (PSM ${s.psm})`);
      try {
        const result = await runOcrWithOptions(
          worker, basePreprocessedPath, s.psm, s.options, s.name, uploadsDir,
        );
        const score = scoreResult(result.text, result.confidence);
        console.log(`[OCR]    ${result.text.trim().length} chars, ${result.confidence.toFixed(1)}% conf, score=${score.toFixed(1)}`);
        results.push(result);
      } catch (err) {
        console.error(`[OCR]  ✗ ${s.name} failed:`, err);
      }
    }

    if (shouldRunRegionalPasses(results)) {
      console.log('[OCR]  → running regional logo/display passes');
      for (const s of buildRegionalStrategies(imageWidth, imageHeight)) {
        try {
          const result = await runOcrWithOptions(
            worker, basePreprocessedPath, s.psm, s.options, s.name, uploadsDir,
          );
          const score = scoreResult(result.text, result.confidence);
          console.log(`[OCR]    ${s.name}: ${result.text.trim().length} chars, ${result.confidence.toFixed(1)}% conf, score=${score.toFixed(1)}`);
          results.push(result);
        } catch (err) {
          console.error(`[OCR]  ✗ ${s.name} failed:`, err);
        }
      }
    } else {
      console.log('[OCR]  ✓ whole-image OCR is strong; skipped regional passes');
    }
  } finally {
    await worker.terminate();
  }

  if (results.length === 0) {
    console.error(`[OCR] All strategies failed for ${documentId}`);
    db.prepare(
      `UPDATE documents SET status = ?, ocr_text = ?, ocr_confidence = ?, completed_at = datetime('now') WHERE id = ?`
    ).run('completed', '', 0, documentId);
    try { fs.unlinkSync(basePreprocessedPath); } catch { /* ignore */ }
    return;
  }

  const best = pickBestResult(results);
  console.log(`[OCR] Best: ${best.strategyName} (${best.text.trim().length} chars, ${best.confidence.toFixed(1)}%)`);

  const text = mergeResultText(results, best);
  const confidence = Math.round(best.confidence);

  db.prepare(
    `UPDATE documents SET status = ?, ocr_text = ?, ocr_confidence = ?, completed_at = datetime('now') WHERE id = ?`
  ).run('completed', text, confidence, documentId);

  console.log(`[OCR] Completed document ${documentId} (confidence: ${confidence}%)`);

  try { fs.unlinkSync(basePreprocessedPath); } catch { /* ignore */ }
}

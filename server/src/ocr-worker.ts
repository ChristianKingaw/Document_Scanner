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

  // Pre-check: is this likely a list?
  for (const line of lines) {
    if (BULLET_GLYPHS.test(line.trim()) || BRACKET_BULLETS.test(line.trim())) {
      bulletCount++;
    }
  }

  // Only apply aggressive bullet fixing if we see multiple bullet-like patterns
  if (bulletCount < 2) return text;

  // Pass 1: inline bullet misreads (e → •, [J] text → • text)
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

  // Pass 2: standalone [J] lines where text is on the next line
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
      // Filter out single noise characters like ., -, ', etc.
      if (line.length === 1 && !/[a-zA-Z0-9]/.test(line)) return false;
      // Filter out lines that are mostly just non-alphanumeric noise
      const alphaCount = (line.match(/[a-zA-Z0-9]/g) || []).length;
      if (alphaCount / line.length < 0.3 && line.length > 2) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

async function runOcr(imagePath: string, psm: PSM, invert = false): Promise<{ text: string; confidence: number }> {
  const tempPath = imagePath + (invert ? '.inv.png' : '.std.png');
  
  let pipeline = sharp(imagePath);
  if (invert) pipeline = pipeline.negate();
  
  await pipeline
    .grayscale()
    .linear(1.5, -0.2) // Aggressive contrast boost
    .threshold(160) // Force binary black and white
    .png()
    .toFile(tempPath);

  const worker = await createWorker('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: '1',
  });

  const { data } = await worker.recognize(tempPath);
  await worker.terminate();
  
  // Cleanup temp file
  try { fs.unlinkSync(tempPath); } catch {}

  return {
    text: data.text.normalize('NFC'),
    confidence: data.confidence,
  };
}

export async function processDocument(
  documentId: string,
  imagePath: string
): Promise<void> {
  console.log(`[OCR] Processing document ${documentId}: ${imagePath}`);

  db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(
    'processing',
    documentId
  );

  const basePreprocessedPath = path.join(
    import.meta.dirname,
    '..',
    'uploads',
    `preprocessed_${documentId}.png`
  );

  // Initial high-res resize for the base image
  await sharp(imagePath)
    .resize({ width: 3000 }) // Even higher res for small logo text
    .extend({
      top: 40,
      bottom: 40,
      left: 40,
      right: 40,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toFile(basePreprocessedPath);

  // Pass 1: Standard AUTO
  let result = await runOcr(basePreprocessedPath, PSM.AUTO);
  
  // Pass 2: Fallback to Inverted if Pass 1 is empty or low confidence
  // Logos are frequently white text on dark background
  if (result.text.trim().length < 5 || result.confidence < 60) {
    const invResult = await runOcr(basePreprocessedPath, PSM.AUTO, true);
    if (invResult.text.trim().length > result.text.trim().length || invResult.confidence > result.confidence) {
      result = invResult;
    }
  }

  // Final Cleanup Pass 3: SPARSE_TEXT if still nothing
  if (result.text.trim().length < 3) {
    const sparseResult = await runOcr(basePreprocessedPath, PSM.SPARSE_TEXT);
    if (sparseResult.text.trim().length > result.text.trim().length) {
      result = sparseResult;
    }
  }

  const text = cleanText(fixBullets(result.text));
  const confidence = Math.round(result.confidence);

  db.prepare(
    `UPDATE documents SET status = ?, ocr_text = ?, ocr_confidence = ?, completed_at = datetime('now') WHERE id = ?`
  ).run('completed', text, confidence, documentId);

  console.log(
    `[OCR] Completed document ${documentId} (confidence: ${confidence}%)`
  );
  
  // Cleanup base preprocessed file
  try { fs.unlinkSync(basePreprocessedPath); } catch {}
}
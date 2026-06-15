import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import path from 'path';
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

export async function processDocument(
  documentId: string,
  imagePath: string
): Promise<void> {
  console.log(`[OCR] Processing document ${documentId}: ${imagePath}`);

  db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(
    'processing',
    documentId
  );

  const preprocessedPath = path.join(
    import.meta.dirname,
    '..',
    'uploads',
    `preprocessed_${documentId}.png`
  );

  // Multi-stage preprocessing for noise reduction and contrast
  await sharp(imagePath)
    .resize({ width: 2500 })
    .grayscale()
    .median(1) // Remove single-pixel noise
    .linear(1.2, -0.1) // Boost contrast
    .sharpen()
    .extend({
      top: 40,
      bottom: 40,
      left: 40,
      right: 40,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toFile(preprocessedPath);

  const worker = await createWorker('eng');

  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO, // Better layout grouping than SPARSE_TEXT
    preserve_interword_spaces: '1',
    textord_tabfind_find_tables: '0',
    classify_bln_numeric_mode: '0',
    tessedit_char_blacklist: '|=_~', // Filter out common noise characters
  });

  const { data } = await worker.recognize(preprocessedPath);
  await worker.terminate();

  const raw = data.text.normalize('NFC');
  const text = fixBullets(raw);
  const confidence = Math.round(data.confidence);

  db.prepare(
    `UPDATE documents SET status = ?, ocr_text = ?, ocr_confidence = ?, completed_at = datetime('now') WHERE id = ?`
  ).run('completed', text, confidence, documentId);

  console.log(
    `[OCR] Completed document ${documentId} (confidence: ${confidence}%)`
  );
}
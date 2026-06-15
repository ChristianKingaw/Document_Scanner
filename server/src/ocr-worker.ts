import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import path from 'path';
import db from './db.js';

const BULLET_GLYPHS = /^([eoc©®™\*\.\_\-\+~>])\s+(?=\S)/;
const BRACKET_BULLETS = /^\[[Jj]\]?\s+(?=\S)/;

function fixBullets(text: string): string {
  const lines = text.split('\n');

  // Pass 1: inline bullet misreads (e → •, [J] text → • text)
  for (let i = 0; i < lines.length; i++) {
    const mSingle = lines[i].match(BULLET_GLYPHS);
    const mBracket = lines[i].match(BRACKET_BULLETS);
    const m = mSingle || mBracket;
    if (!m) continue;

    let hasNeighbor = false;
    for (let j = i - 2; j <= i + 2; j++) {
      if (j === i || j < 0 || j >= lines.length) continue;
      if (BULLET_GLYPHS.test(lines[j]) || BRACKET_BULLETS.test(lines[j])) {
        hasNeighbor = true;
        break;
      }
    }

    const prevBlank = i > 0 && lines[i - 1].trim() === '';

    if (hasNeighbor || prevBlank) {
      lines[i] = `\u2022 ${lines[i].slice(m[0].length)}`;
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

    // In two-column layouts, two [J] lines may precede one line with both items.
    // Split on 3+ spaces to detect column separation.
    const parts = nextText.split(/\s{3,}/);
    const left = parts[0];
    const right = parts.slice(1).join('   ');

    // Count how many consecutive [J] lines precede this text
    let bracketCount = 0;
    for (let j = i; j >= 0; j--) {
      const c = lines[j].trim().replace(/^[\u2022\s]+/, '');
      if (/^\[[Jj]\]?\s*$/.test(c)) {
        bracketCount++;
        lines[j] = '';
      } else if (lines[j].trim() !== '') {
        break;
      }
    }

    if (bracketCount >= 2 && right) {
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

  await sharp(imagePath)
    .grayscale()
    .normalize({ lower: 3, upper: 97 })
    .sharpen({ sigma: 1.2, m1: 1.0, m2: 1.5 })
    .resize({ width: 2500 }) // Ensure sufficient resolution for small logos/cards
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
    tessedit_pageseg_mode: PSM.SPARSE_TEXT, // Find all possible text, regardless of layout
    preserve_interword_spaces: '1',
    textord_tabfind_find_tables: '0',
    classify_bln_numeric_mode: '0',
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
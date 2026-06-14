import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import path from 'path';
import db from './db.js';

export async function processDocument(
  documentId: string,
  imagePath: string
): Promise<void> {
  console.log(`[OCR] Processing document ${documentId}: ${imagePath}`);

  db.prepare('UPDATE documents SET status = ? WHERE id = ?').run('processing', documentId);

  const preprocessedPath = path.join(
    import.meta.dirname,
    '..',
    'uploads',
    `preprocessed_${documentId}.png`
  );

  await sharp(imagePath)
    .grayscale()
    .normalize()
    .sharpen()
    .resize({ width: 2000, withoutEnlargement: true })
    .png()
    .toFile(preprocessedPath);

  const worker = await createWorker('eng');
  const { data } = await worker.recognize(preprocessedPath);
  await worker.terminate();

  const confidence = Math.round(data.confidence);

  db.prepare(
    'UPDATE documents SET status = ?, ocr_text = ?, ocr_confidence = ?, completed_at = datetime(\'now\') WHERE id = ?'
  ).run('completed', data.text, confidence, documentId);

  console.log(`[OCR] Completed document ${documentId} (confidence: ${confidence}%)`);
}
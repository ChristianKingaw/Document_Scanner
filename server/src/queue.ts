import { processDocument } from './ocr-worker.js';

type Job = {
  documentId: string;
  imagePath: string;
};

const jobQueue: Job[] = [];
let isProcessing = false;

export function enqueue(documentId: string, imagePath: string): void {
  jobQueue.push({ documentId, imagePath });
  processNext();
}

async function processNext(): Promise<void> {
  if (isProcessing || jobQueue.length === 0) return;
  isProcessing = true;

  const job = jobQueue.shift()!;
  try {
    await processDocument(job.documentId, job.imagePath);
  } catch (err) {
    console.error(`Job failed for ${job.documentId}:`, err);
  } finally {
    isProcessing = false;
    processNext();
  }
}
import { processDocument } from './ocr-worker.js';

type Job = {
  documentId: string;
  imagePath: string;
};

const jobQueue: Job[] = [];
const MAX_CONCURRENT_JOBS = 2;
let activeJobs = 0;

export function enqueue(documentId: string, imagePath: string): void {
  jobQueue.push({ documentId, imagePath });
  processNext();
}

async function processNext(): Promise<void> {
  if (activeJobs >= MAX_CONCURRENT_JOBS || jobQueue.length === 0) return;
  
  activeJobs++;
  const job = jobQueue.shift()!;
  
  // Start next job immediately if there's capacity
  processNext();

  try {
    await processDocument(job.documentId, job.imagePath);
  } catch (err) {
    console.error(`Job failed for ${job.documentId}:`, err);
  } finally {
    activeJobs--;
    processNext();
  }
}
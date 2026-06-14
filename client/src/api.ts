export interface Document {
  id: string;
  filename: string;
  original_path: string;
  status: 'uploaded' | 'processing' | 'completed' | 'failed';
  ocr_text: string | null;
  ocr_confidence: number | null;
  page_count: number | null;
  created_at: string;
  completed_at: string | null;
}

const API = '/api';

export async function fetchDocuments(): Promise<Document[]> {
  const res = await fetch(`${API}/documents`);
  return res.json();
}

export async function uploadDocument(file: File): Promise<Document> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API}/documents/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}

export async function fetchDocument(id: string): Promise<Document> {
  const res = await fetch(`${API}/documents/${id}`);
  return res.json();
}

export async function deleteDocument(id: string): Promise<void> {
  await fetch(`${API}/documents/${id}`, { method: 'DELETE' });
}
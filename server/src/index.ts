import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import db from './db.js';
import { enqueue } from './queue.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const UPLOADS_DIR = path.join(import.meta.dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/tiff', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.get('/api/documents', (_req, res) => {
  const docs = db.prepare('SELECT * FROM documents ORDER BY created_at DESC').all();
  res.json(docs);
});

app.get('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  res.json(doc);
});

app.post('/api/documents/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const id = uuidv4();
  const originalName = req.file.originalname;
  const filePath = req.file.path;

  db.prepare(
    'INSERT INTO documents (id, filename, original_path, status) VALUES (?, ?, ?, ?)'
  ).run(id, originalName, filePath, 'uploaded');

  enqueue(id, filePath);

  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  res.status(201).json(doc);
});

app.get('/api/documents/:id/image', (req, res) => {
  const doc = db.prepare('SELECT original_path FROM documents WHERE id = ?').get(req.params.id) as
    | { original_path: string }
    | undefined;

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  res.sendFile(path.resolve(doc.original_path));
});

app.delete('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as
    | { id: string; original_path: string }
    | undefined;

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  try { fs.unlinkSync(doc.original_path); } catch { /* ignore */ }
  const preprocessed = path.join(UPLOADS_DIR, `preprocessed_${doc.id}.png`);
  try { fs.unlinkSync(preprocessed); } catch { /* ignore */ }

  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
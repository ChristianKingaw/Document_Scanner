# Document Scanner

A full-stack document scanning application that uploads document images, runs OCR via Tesseract.js, and presents extracted text in a review UI.

## Architecture

```
React Frontend  →  API Server  →  Object Storage (uploads/)
                               →  Job Queue  →  OCR Worker  →  SQLite
```

| Component | Stack | Location |
|---|---|---|
| Frontend | React 18, Vite, TypeScript | `client/` |
| API Server | Express, multer | `server/src/index.ts` |
| Object Storage | Local filesystem | `server/uploads/` |
| Job Queue | In-memory FIFO | `server/src/queue.ts` |
| OCR Worker | Tesseract.js, Sharp | `server/src/ocr-worker.ts` |
| Database | SQLite (better-sqlite3) | `server/src/db.ts` |

## Flow

1. User uploads an image or PDF via the React UI.
2. The API stores the file on disk and inserts a record into SQLite with status `uploaded`.
3. The file is enqueued for OCR processing.
4. The worker preprocesses the image (grayscale, normalize, sharpen, resize to 2500px) then runs Tesseract.js for text extraction.
5. Extracted text and confidence score land in the database, status becomes `completed`.
6. The frontend polls every 3 seconds and displays results when ready.

## Setup

```sh
cd document_scanner
npm install
npm --prefix server install
npm --prefix client install
```

## Running

```sh
npm run dev
```

Starts both servers concurrently:

- **API** — `http://localhost:3001`
- **Client** — `http://localhost:5173`

The Vite dev server proxies `/api` requests to the API server.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/documents` | List all documents |
| `GET` | `/api/documents/:id` | Get a single document |
| `POST` | `/api/documents/upload` | Upload a document (multipart, field: `file`) |
| `GET` | `/api/documents/:id/image` | Serve the original image |
| `DELETE` | `/api/documents/:id` | Delete a document and its files |

## Document Model

```ts
{
  id: string;              // UUID
  filename: string;        // original filename
  original_path: string;   // disk path
  status: 'uploaded' | 'processing' | 'completed' | 'failed';
  ocr_text: string | null; // extracted text
  ocr_confidence: number;  // 0–100 confidence score
  created_at: string;      // ISO timestamp
  completed_at: string;    // ISO timestamp
}
```

## Supported Formats

- PNG, JPEG, TIFF, WebP, PDF

## OCR Enhancements

- **PSM.SPARSE_TEXT** page segmentation — designed for bullet-heavy documents with isolated text blocks.
- **`preserve_interword_spaces`** — retains spacing around bullets, dashes, and special characters.
- **Histogram clipping** — prevents thin glyphs like `•`, `–`, `—` from washing out during normalization.
- **Unicode NFC normalization** — collapses decomposed codepoints into proper single characters (e.g., é, ü).
- **2500px resolution** — gives Tesseract enough pixels for small or fine-detail symbols.
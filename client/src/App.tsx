import { useState, useEffect, useCallback, useRef } from 'react';
import { Document, fetchDocuments, uploadDocument, deleteDocument } from './api.js';

const STATUS_LABELS: Record<string, string> = {
  uploaded: 'Queued',
  processing: 'Processing...',
  completed: 'Completed',
  failed: 'Failed',
};

const STATUS_COLORS: Record<string, string> = {
  uploaded: '#b7a057',
  processing: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
};

export default function App() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval>>();
  const abortRef = useRef(false);

  const loadDocs = useCallback(async () => {
    if (abortRef.current) return;
    try {
      const data = await fetchDocuments();
      if (!abortRef.current) setDocs(data);
    } catch {
      if (!abortRef.current) setError('Failed to load documents');
    }
  }, []);

  useEffect(() => {
    abortRef.current = false;
    loadDocs();
    pollingRef.current = setInterval(loadDocs, 3000);
    return () => {
      abortRef.current = true;
      clearInterval(pollingRef.current);
    };
  }, [loadDocs]);

  const selected = docs.find((d) => d.id === selectedId) ?? null;

  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const processUploads = async (files: FileList | File[]) => {
    const fileList = Array.from(files);
    if (fileList.length === 0) return;

    setError(null);
    setUploading(true);

    try {
      // Parallel upload
      const results = await Promise.allSettled(
        fileList.map((file) => uploadDocument(file))
      );

      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        setError(`Failed to upload ${failures.length} file(s)`);
      }

      // Select the first successful one
      const firstSuccess = results.find(
        (r): r is PromiseFulfilledResult<Document> => r.status === 'fulfilled'
      );
      if (firstSuccess) {
        setSelectedId(firstSuccess.value.id);
      }

      await loadDocs();
    } catch {
      setError('Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) await processUploads(e.target.files);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    if (e.dataTransfer.files) await processUploads(e.dataTransfer.files);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteDocument(id);
      if (selectedId === id) setSelectedId(null);
      await loadDocs();
    } catch {
      setError('Delete failed');
    }
  };

  return (
    <div
      style={styles.wrapper}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div style={styles.dragOverlay}>
          <div style={styles.dragOverlayBox}>
            <span style={styles.dragOverlayIcon}>📁</span>
            <span style={styles.dragOverlayText}>Drop to upload document</span>
          </div>
        </div>
      )}
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <h1 style={styles.title}>Document Scanner</h1>
          <label style={styles.uploadBtn}>
            {uploading ? 'Uploading...' : '+ Upload'}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/tiff,image/webp,application/pdf"
              onChange={handleUpload}
              style={{ display: 'none' }}
              disabled={uploading}
              multiple
            />
          </label>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.docList}>
          {docs.length === 0 && (
            <div style={styles.empty}>No documents yet. Upload one to get started.</div>
          )}
          {docs.map((doc) => (
            <div
              key={doc.id}
              style={{
                ...styles.docItem,
                ...(doc.id === selectedId ? styles.docItemActive : {}),
              }}
              onClick={() => setSelectedId(doc.id)}
            >
              <div style={styles.docItemTop}>
                <span style={styles.docName} title={doc.filename}>
                  {doc.filename}
                </span>
                <button
                  style={styles.deleteBtn}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    handleDelete(doc.id);
                  }}
                >
                  ×
                </button>
              </div>
              <span style={{ ...styles.docStatus, color: STATUS_COLORS[doc.status] || '#999' }}>
                {STATUS_LABELS[doc.status] || doc.status}
                {doc.ocr_confidence != null && ` • ${doc.ocr_confidence}% confidence`}
              </span>
              <span style={styles.docDate}>
                {new Date(doc.created_at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={styles.main}>
        {!selected && (
          <div style={styles.placeholder}>
            <div style={styles.placeholderIcon}>📄</div>
            <div style={styles.placeholderText}>Select a document or upload a new one</div>
          </div>
        )}

        {selected && (
          <div style={styles.detail}>
            <h2 style={styles.detailTitle}>{selected.filename}</h2>

            <div style={styles.detailMeta}>
              <span style={{ color: STATUS_COLORS[selected.status] || '#999' }}>
                {STATUS_LABELS[selected.status] || selected.status}
                {selected.ocr_confidence != null && ` • ${selected.ocr_confidence}% confidence`}
              </span>
              <span>{new Date(selected.created_at).toLocaleString()}</span>
            </div>

            <div style={styles.imagePane}>
              <img
                src={`/api/documents/${selected.id}/image`}
                alt={selected.filename}
                style={styles.previewImage}
              />
            </div>

            {selected.status === 'completed' && selected.ocr_text && (
              <div style={styles.textPane}>
                <h3 style={styles.textLabel}>Extracted Text</h3>
                <pre style={styles.textContent}>{selected.ocr_text}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    height: '100vh',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    background: '#1a1a19',
    color: '#e8e7e2',
    position: 'relative',
  },
  dragOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(59, 130, 246, 0.15)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    pointerEvents: 'none',
    border: '2px dashed #3b82f6',
    margin: 12,
    borderRadius: 12,
  },
  dragOverlayBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
  },
  dragOverlayIcon: {
    fontSize: 48,
  },
  dragOverlayText: {
    fontSize: 18,
    fontWeight: 500,
    color: '#3b82f6',
  },
  sidebar: {
    width: 320,
    minWidth: 320,
    borderRight: '1px solid rgba(255,255,255,0.08)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  sidebarHeader: {
    padding: '20px 20px 12px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    margin: 0,
  },
  uploadBtn: {
    padding: '6px 14px',
    borderRadius: 6,
    background: '#3b82f6',
    color: '#fff',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
    whiteSpace: 'nowrap',
  },
  error: {
    margin: '12px 20px 0',
    padding: '8px 12px',
    borderRadius: 6,
    background: 'rgba(239,68,68,0.15)',
    color: '#ef4444',
    fontSize: 13,
  },
  docList: {
    flex: 1,
    overflow: 'auto',
    padding: 8,
  },
  docItem: {
    padding: '12px 16px',
    borderRadius: 8,
    cursor: 'pointer',
    marginBottom: 4,
    border: '1px solid transparent',
  },
  docItemActive: {
    background: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(255,255,255,0.12)',
  },
  docItemTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  docName: {
    fontSize: 14,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    marginRight: 8,
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.3)',
    fontSize: 18,
    cursor: 'pointer',
    padding: '0 2px',
    lineHeight: 1,
  },
  docStatus: {
    fontSize: 12,
    display: 'block',
  },
  docDate: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.3)',
    display: 'block',
    marginTop: 2,
  },
  empty: {
    textAlign: 'center',
    color: 'rgba(255,255,255,0.3)',
    fontSize: 13,
    padding: 40,
  },
  main: {
    flex: 1,
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
  placeholder: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    color: 'rgba(255,255,255,0.2)',
  },
  placeholderIcon: {
    fontSize: 48,
  },
  placeholderText: {
    fontSize: 15,
  },
  detail: {
    padding: 24,
  },
  detailTitle: {
    fontSize: 18,
    fontWeight: 600,
    margin: '0 0 8px',
  },
  detailMeta: {
    display: 'flex',
    gap: 16,
    fontSize: 13,
    color: 'rgba(255,255,255,0.4)',
    marginBottom: 20,
  },
  imagePane: {
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    padding: 16,
    marginBottom: 20,
    display: 'flex',
    justifyContent: 'center',
  },
  previewImage: {
    maxWidth: '100%',
    maxHeight: 500,
    objectFit: 'contain',
    borderRadius: 4,
  },
  textPane: {
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    padding: 20,
  },
  textLabel: {
    fontSize: 14,
    fontWeight: 500,
    margin: '0 0 10px',
  },
  textContent: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: 'rgba(255,255,255,0.75)',
    fontFamily: 'inherit',
  },
};
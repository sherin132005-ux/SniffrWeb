import { StorageAdapter } from './StorageAdapter.js';
import fs from 'fs';
import path from 'path';
import config from '../config.js';

const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
};

export class LocalStorage extends StorageAdapter {
  constructor() {
    super();
    this.uploadDir = config.UPLOAD_DIR;
    if (!fs.existsSync(this.uploadDir)) fs.mkdirSync(this.uploadDir, { recursive: true });
  }

  async upload(file, subdir = '') {
    const dir = path.join(this.uploadDir, subdir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Extension is derived from the validated mimetype, never trusted from
    // the client-supplied originalname -- otherwise a file whose mimetype
    // passes the image/video allowlist but whose originalname ends in
    // ".html" would be written with that extension and later served back
    // by express.static with a real text/html Content-Type (stored XSS).
    const ext = MIME_EXTENSIONS[file.mimetype] || '.bin';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, file.buffer);
    return path.join(subdir, filename).replace(/\\/g, '/');
  }

  async delete(filePath) {
    const fullPath = path.join(this.uploadDir, filePath);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }

  getUrl(filePath) {
    return `/uploads/${filePath}`;
  }
}

export default new LocalStorage();

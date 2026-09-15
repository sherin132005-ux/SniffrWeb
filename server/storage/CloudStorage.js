import { StorageAdapter } from './StorageAdapter.js';
import { v2 as cloudinary } from 'cloudinary';
import config from '../config.js';

cloudinary.config({
  cloud_name: config.CLOUDINARY_CLOUD_NAME,
  api_key: config.CLOUDINARY_API_KEY,
  api_secret: config.CLOUDINARY_API_SECRET,
});

export class CloudStorage extends StorageAdapter {
  async upload(file, subdir = '') {
    return new Promise((resolve, reject) => {
      // Cloudinary has no separate "audio" resource type -- audio files
      // (voice notes) must be uploaded as resource_type 'video' too, or
      // Cloudinary rejects/mishandles them. See voice-note playback fix.
      const isVideo = file.mimetype.startsWith('video') || file.mimetype.startsWith('audio');
      // Documents (PDF/Word/Excel/PowerPoint/text) aren't valid Cloudinary
      // "image" resources -- uploading a .docx with resource_type: 'image'
      // gets rejected outright. 'raw' is Cloudinary's catch-all for
      // arbitrary non-image/video files.
      const isDocument = config.ALLOWED_DOCUMENT_TYPES.includes(file.mimetype);
      const resourceType = isVideo ? 'video' : isDocument ? 'raw' : 'image';
      const options = {
        folder: `sniffr/${subdir}`,
        resource_type: resourceType,
      };
      // Images only, for now: an *incoming* transformation re-encodes the
      // file at upload time (not just at delivery), so the bytes Cloudinary
      // actually stores -- and what gets counted against the user's quota
      // below -- shrink too, typically 30-70% with no visible quality
      // loss. Deliberately NOT doing this for video: Cloudinary meters
      // video transformations separately from plain storage, and this
      // account's plan doesn't confirm that's covered -- revisit once it
      // is. Not applicable to 'raw' (documents) either.
      if (resourceType === 'image') {
        options.transformation = [{ quality: 'auto:good', fetch_format: 'auto' }];
      }
      const stream = cloudinary.uploader.upload_stream(
        options,
        (error, result) => {
          if (error) return reject(error);
          resolve({ filePath: result.secure_url, bytes: result.bytes });
        }
      );
      stream.end(file.buffer);
    });
  }

  async delete(filePath) {
    try {
      const match = filePath.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
      if (!match) return;
      const publicId = match[1];
      await cloudinary.uploader.destroy(publicId);
    } catch (err) {
      console.error('[CloudStorage delete] failed:', err.message);
    }
  }

  getUrl(filePath) {
    return filePath;
  }
}

export default new CloudStorage();
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
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `sniffr/${subdir}`,
          resource_type: isVideo ? 'video' : 'image',
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result.secure_url);
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
// Wraps the configured storage adapter (Cloudinary/local, see storage/index.js)
// with per-user quota enforcement and usage tracking in Postgres. Postgres
// never holds the media bytes themselves -- only the running total and a
// per-file record (url/size/provider), so quota checks don't need to ask
// Cloudinary for anything at request time.
import storage from '../storage/index.js';
import db from '../db/connection.js';
import config from '../config.js';

export class QuotaExceededError extends Error {
  constructor(usedBytes, quotaBytes) {
    super('Storage quota exceeded');
    this.name = 'QuotaExceededError';
    this.usedBytes = usedBytes;
    this.quotaBytes = quotaBytes;
  }
}

function quotaForPlan(plan) {
  return config.STORAGE_QUOTA_BYTES[plan] || config.STORAGE_QUOTA_BYTES.free;
}

export async function getUserStorageStatus(userId) {
  const user = await db.get(
    'SELECT current_plan, storage_used_bytes, storage_quota_override_bytes FROM users WHERE id = ?',
    [userId]
  );
  if (!user) throw new Error('User not found');
  const quotaBytes = user.storage_quota_override_bytes != null
    ? Number(user.storage_quota_override_bytes)
    : quotaForPlan(user.current_plan || 'free');
  return { usedBytes: Number(user.storage_used_bytes) || 0, quotaBytes };
}

// Checks quota BEFORE spending upload bandwidth/Cloudinary usage, uploads via
// the existing storage adapter unchanged, then records the file and bumps
// the user's running total. Throws QuotaExceededError (handled centrally by
// utils/errors.js -> 413) if the file would put the user over quota.
export async function uploadWithQuota(userId, file, subdir) {
  const { usedBytes, quotaBytes } = await getUserStorageStatus(userId);
  if (usedBytes + file.size > quotaBytes) {
    throw new QuotaExceededError(usedBytes, quotaBytes);
  }

  const filePath = await storage.upload(file, subdir);
  const url = storage.getUrl(filePath);

  await db.run(
    'INSERT INTO media_files (user_id, url, bytes, provider, resource_type, subdir) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, url, file.size, config.STORAGE_TYPE === 'cloud' ? 'cloudinary' : 'local',
     file.mimetype.startsWith('audio') ? 'audio' : file.mimetype.startsWith('video') ? 'video' : 'image', subdir]
  );
  await db.run('UPDATE users SET storage_used_bytes = storage_used_bytes + ? WHERE id = ?', [file.size, userId]);

  return { url, bytes: file.size };
}

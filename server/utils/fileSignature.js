// Verifies uploaded file *content* actually matches the claimed MIME type,
// instead of trusting multer's `file.mimetype` -- which is read straight
// from the client-supplied multipart Content-Type header and is trivially
// spoofable (e.g. a real .exe/.html sent with a `Content-Type: image/png`
// part header sails through a mimetype-only allowlist). Checked via magic
// bytes at upload time, the one place every upload (posts/chat/avatars/
// community media/payment proofs) funnels through.
function matchBytes(buffer, offset, bytes) {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function matchAscii(buffer, offset, str) {
  return matchBytes(buffer, offset, Array.from(str, (c) => c.charCodeAt(0)));
}

const CHECKS = {
  'image/jpeg': (b) => matchBytes(b, 0, [0xff, 0xd8, 0xff]),
  'image/png': (b) => matchBytes(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/gif': (b) => matchAscii(b, 0, 'GIF87a') || matchAscii(b, 0, 'GIF89a'),
  'image/webp': (b) => matchAscii(b, 0, 'RIFF') && matchAscii(b, 8, 'WEBP'),
  'video/mp4': (b) => matchAscii(b, 4, 'ftyp'),
  'video/quicktime': (b) => matchAscii(b, 4, 'ftyp') || matchAscii(b, 4, 'moov') || matchAscii(b, 4, 'mdat') || matchAscii(b, 4, 'free') || matchAscii(b, 4, 'wide'),
  'video/webm': (b) => matchBytes(b, 0, [0x1a, 0x45, 0xdf, 0xa3]),
  'audio/webm': (b) => matchBytes(b, 0, [0x1a, 0x45, 0xdf, 0xa3]),
  'audio/mp4': (b) => matchAscii(b, 4, 'ftyp'),
  'audio/mpeg': (b) => matchAscii(b, 0, 'ID3') || matchBytes(b, 0, [0xff, 0xfb]) || matchBytes(b, 0, [0xff, 0xf3]) || matchBytes(b, 0, [0xff, 0xf2]) || matchBytes(b, 0, [0xff, 0xe3]),
  'audio/ogg': (b) => matchAscii(b, 0, 'OggS'),
  'audio/wav': (b) => matchAscii(b, 0, 'RIFF') && matchAscii(b, 8, 'WAVE'),
  'application/pdf': (b) => matchAscii(b, 0, '%PDF'),
  // Legacy binary Office formats (.doc/.xls/.ppt) are all the same OLE2
  // Compound File container -- the magic bytes alone can't tell them apart
  // from each other, which is fine since the claimed mimetype already says
  // which one this is meant to be.
  'application/msword': (b) => matchBytes(b, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  'application/vnd.ms-excel': (b) => matchBytes(b, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  'application/vnd.ms-powerpoint': (b) => matchBytes(b, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  // Modern Office Open XML formats (.docx/.xlsx/.pptx) are all just a ZIP
  // archive under the hood -- same reasoning as above, the mimetype (not
  // the ZIP signature) is what distinguishes them.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) => matchAscii(b, 0, 'PK') && [0x03, 0x05, 0x07].includes(b[2]),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) => matchAscii(b, 0, 'PK') && [0x03, 0x05, 0x07].includes(b[2]),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': (b) => matchAscii(b, 0, 'PK') && [0x03, 0x05, 0x07].includes(b[2]),
  // Plain text has no magic bytes -- the closest real signal is the
  // *absence* of a NUL byte early in the file, since genuine binary data
  // (images, executables, office docs that got mislabeled) almost always
  // contains one in the first few hundred bytes and real UTF-8/ASCII text
  // essentially never does.
  'text/plain': (b) => !b.subarray(0, Math.min(b.length, 512)).includes(0x00),
};

// Returns true if `buffer`'s actual bytes are consistent with `mimetype`.
// Unknown mimetypes (not in CHECKS) are rejected -- every type this app
// accepts is listed in config.js's ALLOWED_*_TYPES and has a check above,
// so reaching "unknown" here means something upstream's allowlist drifted.
export function verifyFileSignature(buffer, mimetype) {
  const check = CHECKS[mimetype];
  return typeof check === 'function' && check(buffer);
}

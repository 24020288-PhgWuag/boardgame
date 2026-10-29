const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SUBMISSIONS_PER_USER = 5;
const BOT_ID_PATTERN = /^[a-f0-9-]{36}\.json$/i;

function countUserSubmissions(directory, userId) {
  return fs.readdirSync(directory)
    .filter(filename => BOT_ID_PATTERN.test(filename))
    .reduce((count, filename) => {
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
      return count + (metadata.ownerId === userId ? 1 : 0);
    }, 0);
}

function createSubmission(directory, { filename, source, name, user }) {
  if (!/^[a-zA-Z0-9_-]+\.py$/.test(filename)) {
    return { error: 'Tên file bot không hợp lệ.', status: 400 };
  }
  if (typeof source !== 'string' || !source.trim()) {
    return { error: 'File bot không được để trống.', status: 400 };
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return { error: 'File bot tối đa 256 KB.', status: 413 };
  }
  if (countUserSubmissions(directory, user.id) >= MAX_SUBMISSIONS_PER_USER) {
    return { error: 'Mỗi tài khoản chỉ được lưu tối đa 5 bot.', status: 409 };
  }

  const id = crypto.randomUUID();
  const sha256 = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  const safeName = String(name || filename.replace(/\.py$/i, ''))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 60) || 'Python Bot';
  const metadata = {
    id,
    name: safeName,
    originalFilename: filename,
    sha256,
    ownerId: user.id,
    ownerName: user.username,
    createdAt: new Date().toISOString()
  };
  const sourcePath = path.join(directory, `${id}.py`);
  const metadataPath = path.join(directory, `${id}.json`);

  let sourceCreated = false;
  let metadataCreated = false;
  try {
    fs.writeFileSync(sourcePath, source, { encoding: 'utf8', flag: 'wx' });
    sourceCreated = true;
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    });
    metadataCreated = true;
  } catch (error) {
    if (sourceCreated) fs.unlinkSync(sourcePath);
    if (metadataCreated) fs.unlinkSync(metadataPath);
    throw error;
  }

  return { id, name: safeName, sha256 };
}

module.exports = {
  MAX_SOURCE_BYTES,
  MAX_SUBMISSIONS_PER_USER,
  countUserSubmissions,
  createSubmission
};

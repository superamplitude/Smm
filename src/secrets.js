const crypto = require('crypto');

function keyBuffer() {
  const material = process.env.CONFIG_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
  if (!material) throw new Error('CONFIG_ENCRYPTION_KEY ou JWT_SECRET não configurado');
  return crypto.createHash('sha256').update(material).digest();
}

function encryptSecret(value) {
  const text = String(value || '');
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (!text.startsWith('v1.')) return text;
  const [, ivPart, tagPart, dataPart] = text.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
}

function secretState(value) {
  return value ? 'configured' : 'empty';
}

module.exports = { encryptSecret, decryptSecret, secretState };

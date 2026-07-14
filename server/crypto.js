'use strict';
const crypto = require('crypto');

let KEY = null;

function initKey(hex) {
  if (!hex || hex.length !== 64) throw new Error('ENCRYPTION_KEY invalide (attendu : 64 caractères hex)');
  KEY = Buffer.from(hex, 'hex');
}

function encrypt(plain) {
  if (!KEY) throw new Error('Clé de chiffrement non initialisée');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('base64')}`;
}

function decrypt(payload) {
  if (!KEY) throw new Error('Clé de chiffrement non initialisée');
  const [ivHex, tagHex, data] = String(payload).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const test = crypto.scryptSync(String(pw), salt, 64);
    return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
  } catch { return false; }
}

module.exports = { initKey, encrypt, decrypt, hashPassword, verifyPassword };

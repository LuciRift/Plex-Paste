const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  accentColor: { type: String, default: '#5e99ff' },
  name: { type: String, default: 'Plex Paste' },
  logo: { type: String },
  favicon: { type: String },
  updatedAt: { type: Date, default: Date.now },
  seoTitle: { type: String, default: 'Plex Paste - Modern Code and Text Sharing' },
  seoDescription: { type: String, default: 'A modern, secure paste service for sharing code and text with syntax highlighting, password protection, and API access.' },
  seoKeywords: { type: String, default: 'paste, code sharing, text sharing, pastebin, syntax highlighting, secure' },
  rateLimit: { type: Number, default: 100 },
  maxPasteSize: { type: Number, default: 1 },
  enableAPI: { type: Boolean, default: true },
  apiRateLimit: { type: Number, default: 500 },
  rateLimitWindow: { type: String, default: '1h' },
  apiRateLimitWindow: { type: String, default: '1h' },
  requireApiKey: { type: Boolean, default: false },
  apiKey: { type: String, default: '' },
  inactiveDeleteAfter: { type: String, default: 'never' },
  enableSyntaxHighlighting: { type: Boolean, default: true },
  slugLength: { type: Number, default: 8 },
  slugCharacterSet: { type: String, default: 'alphanumeric' }
});

const Settings = mongoose.model('Settings', settingsSchema);

module.exports = Settings;
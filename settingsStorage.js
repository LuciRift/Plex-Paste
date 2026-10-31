const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));

class SettingsStorage {
    constructor() {
        this.storageType = config.storageType || 'mongodb';
        this.initialized = false;
        
        if (this.storageType === 'file') {
            this.settingsFile = path.join(__dirname, './data/settings.json');
        } else {
            this.SettingsModel = require('./models/settingsModel');
            this.initialized = true;
        }
    }

    async initFileStorage() {
        if (this.initialized) return;
        
        try {
            await fs.promises.mkdir(path.dirname(this.settingsFile), { recursive: true });
            
            try {
                await fs.promises.access(this.settingsFile);
            } catch {
                const defaultSettings = {
                    accentColor: '#5e99ff',
                    name: 'Plex Paste',
                    logo: null,
                    favicon: null,
                    updatedAt: new Date().toISOString(),
                    seoTitle: 'Plex Paste - Modern Code & Text Sharing',
                    seoDescription: 'A modern, secure paste service for sharing code and text with syntax highlighting, password protection, and API access.',
                    seoKeywords: 'paste, code sharing, text sharing, pastebin, syntax highlighting, secure',
                    rateLimit: 100,
                    rateLimitWindow: '1h',
                    apiRateLimitWindow: '1h',
                    maxPasteSize: 1,
                    enableAPI: true,
                    apiRateLimit: 500,
                    requireApiKey: false,
                    apiKey: '',
                    inactiveDeleteAfter: 'never',
                    enableSyntaxHighlighting: true,
                    slugLength: 8,
                    slugCharacterSet: 'alphanumeric'
                };
                await fs.promises.writeFile(this.settingsFile, JSON.stringify(defaultSettings, null, 2));
            }
            this.initialized = true;
        } catch (error) {
            console.error('Failed to initialize settings file storage:', error);
            throw error;
        }
    }

    async findOne() {
        if (this.storageType === 'file') {
            await this.initFileStorage();
            return await this._findOneFile();
        } else {
            return await this._findOneMongoDB();
        }
    }

    async save(settingsData) {
        if (this.storageType === 'file') {
            await this.initFileStorage();
            return await this._saveFile(settingsData);
        } else {
            return await this._saveMongoDB(settingsData);
        }
    }

    async create() {
        if (this.storageType === 'file') {
            await this.initFileStorage();
            return await this.findOne();
        } else {
            const settings = new this.SettingsModel();
            return await settings.save();
        }
    }

    async _findOneFile() {
        try {
            const data = await fs.promises.readFile(this.settingsFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error reading settings file:', error);
            return null;
        }
    }

    async _saveFile(settingsData) {
        try {
            settingsData.updatedAt = new Date().toISOString();
            await fs.promises.writeFile(this.settingsFile, JSON.stringify(settingsData, null, 2));
            return settingsData;
        } catch (error) {
            console.error('Error saving settings file:', error);
            throw error;
        }
    }

    async _findOneMongoDB() {
        return await this.SettingsModel.findOne();
    }

    async _saveMongoDB(settingsData) {
        let settings = await this.SettingsModel.findOne();
        if (!settings) {
            settings = new this.SettingsModel(settingsData);
        } else {
            Object.assign(settings, settingsData);
        }
        settings.updatedAt = new Date();
        return await settings.save();
    }
}

module.exports = SettingsStorage;
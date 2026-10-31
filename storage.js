const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const config = yaml.load(fsSync.readFileSync('./config.yml', 'utf8'));
const pasteModel = require('./models/pasteModel');

let statsModel;
if (config.storageType === 'mongodb') {
    statsModel = require('./models/statsModel');
}

class Storage {
    constructor() {
        this.storageType = config.storageType || 'file';
        
        if (this.storageType === 'file') {
            this.storageDir = path.join(__dirname, './data/pastes');
            this.contentDir = path.join(__dirname, './data/content');
            this.statsFile = path.join(__dirname, './data/stats.json');
            
            this.statsQueue = [];
            this.isProcessingStats = false;
            this.statsCache = null;
            this.lastStatsUpdate = 0;
            this.STATS_UPDATE_INTERVAL = 30000;
            this.MAX_QUEUE_SIZE = 1000;
            
            this.initFileStorage();
            this.startStatsProcessor();
        }
    }

    async initFileStorage() {
        try {
            await fs.mkdir(this.storageDir, { recursive: true });
            await fs.mkdir(this.contentDir, { recursive: true });
            await fs.mkdir(path.dirname(this.statsFile), { recursive: true });
            
            try {
                await fs.access(this.statsFile);
            } catch {
                const initialStats = {
                    totalPastes: 0,
                    totalViews: 0,
                    apiPastes: 0,
                    webPastes: 0,
                    totalContentSize: 0,
                    mostViewedPasteViews: 0,
                    mostViewedPasteSlug: '',
                    dailyStats: {},
                    createdAt: new Date().toISOString()
                };
                await fs.writeFile(this.statsFile, JSON.stringify(initialStats, null, 2));
            }
        } catch (error) {
            console.error('Failed to initialize file storage:', error);
        }
    }

    async savePaste(pasteData, isApi = false) {
        const contentSize = Buffer.byteLength(pasteData.content, 'utf8');
        
        if (this.storageType === 'file') {
            const result = await this._saveToFile(pasteData);
            await this._updateFileStats('incrementPaste', { isApi, contentSize });
            return result;
        } else {
            const result = await this._saveToMongoDB(pasteData);
            if (statsModel) {
                await statsModel.incrementPasteCount(isApi, contentSize);
            }
            return result;
        }
    }

    async findPaste(slug) {
        if (this.storageType === 'file') {
            return await this._findInFile(slug);
        } else {
            return await this._findInMongoDB(slug);
        }
    }

    async updatePaste(slug, updates) {
        if (this.storageType === 'file') {
            const result = await this._updateInFile(slug, updates);
            if (result && updates.views !== undefined) {
                await this._updateFileStats('incrementView', { 
                    pasteSlug: slug, 
                    pasteViews: updates.views 
                });
            }
            return result;
        } else {
            const result = await this._updateInMongoDB(slug, updates);
            if (result && updates.views !== undefined && statsModel) {
                await statsModel.incrementViewCount(slug, updates.views);
            }
            return result;
        }
    }

    async deletePaste(slug, preserveStats = true) {
        if (this.storageType === 'file') {
            const paste = await this.findPaste(slug);
            const result = await this._deleteFromFile(slug);
            
            if (result && !preserveStats && paste) {
                const contentSize = Buffer.byteLength(paste.content, 'utf8');
                await this._updateFileStats('decrementPaste', { contentSize });
            }
            return result;
        } else {
            const paste = await this.findPaste(slug);
            const result = await this._deleteFromMongoDB(slug);
            
            if (result && !preserveStats && statsModel && paste) {
                const contentSize = Buffer.byteLength(paste.content, 'utf8');
                await statsModel.decrementPasteCount(contentSize);
            }
            return result;
        }
    }

    async deleteInactivePaste(slug) {
        return await this.deletePaste(slug, true);
    }

    async deleteStaffPaste(slug, preserveStats = false) {
        return await this.deletePaste(slug, preserveStats);
    }

    async getStats() {
        if (this.storageType === 'file') {
            return await this._getFileStats();
        } else {
            if (statsModel) {
                return await statsModel.getAggregatedStats();
            } else {
                return await this._getMongoStatsFromPastes();
            }
        }
    }

    async getTotalPastes() {
        if (this.storageType === 'file') {
            const stats = await this._getFileStats();
            return [{ totalPastes: stats.totalPastes }];
        } else {
            return await pasteModel.getTotalPastes();
        }
    }

    async getTotalViews() {
        if (this.storageType === 'file') {
            const stats = await this._getFileStats();
            return [{ totalViews: stats.totalViews }];
        } else {
            return await pasteModel.getTotalViews();
        }
    }

    async clearAllPastes(resetStats = true) {
        if (this.storageType === 'file') {
            const result = await this._clearAllFromFile();
            if (resetStats) {
                const resetStatsData = {
                    totalPastes: 0,
                    totalViews: 0,
                    apiPastes: 0,
                    webPastes: 0,
                    totalContentSize: 0,
                    mostViewedPasteViews: 0,
                    mostViewedPasteSlug: '',
                    dailyStats: {},
                    lastReset: new Date().toISOString()
                };
                await fs.writeFile(this.statsFile, JSON.stringify(resetStatsData, null, 2));
            }
            return result;
        } else {
            const result = await pasteModel.deleteMany({});
            if (resetStats && statsModel) {
                await statsModel.deleteMany({});
            }
            return result;
        }
    }

    async _saveToFile(pasteData) {
        const metaFileName = `${pasteData.slug}.json`;
        const contentFileName = pasteData.slug;
        const metaFilePath = path.join(this.storageDir, metaFileName);
        const contentFilePath = path.join(this.contentDir, contentFileName);
        
const pasteMetadata = {
    slug: pasteData.slug,
    title: pasteData.title,
    language: pasteData.language,
    views: 0,
    isActive: true,
    createdAt: new Date().toISOString(),
    lastViewedAt: null,
    password: pasteData.password,
    isPasswordProtected: pasteData.isPasswordProtected,
    maxViews: pasteData.maxViews
};

        await fs.writeFile(contentFilePath, pasteData.content, 'utf8');
        await fs.writeFile(metaFilePath, JSON.stringify(pasteMetadata, null, 2));
        
        return {
            ...pasteMetadata,
            content: pasteData.content
        };
    }

    async _findInFile(slug) {
        try {
            const metaFilePath = path.join(this.storageDir, `${slug}.json`);
            const contentFilePath = path.join(this.contentDir, slug);
            
            const metaData = await fs.readFile(metaFilePath, 'utf8');
            const paste = JSON.parse(metaData);
            
            if (!paste.isActive) return null;
            
            const content = await fs.readFile(contentFilePath, 'utf8');
            
            return {
                ...paste,
                content: content
            };
        } catch {
            return null;
        }
    }

    async _updateInFile(slug, updates) {
        const paste = await this._findInFile(slug);
        if (!paste) return null;

        const updatedPaste = { ...paste, ...updates };
        
        const metaFilePath = path.join(this.storageDir, `${slug}.json`);
        const metadata = { ...updatedPaste };
        delete metadata.content;
        
        await fs.writeFile(metaFilePath, JSON.stringify(metadata, null, 2));
        
        if (updates.content !== undefined) {
            const contentFilePath = path.join(this.contentDir, slug);
            await fs.writeFile(contentFilePath, updates.content, 'utf8');
        }
        
        return updatedPaste;
    }

    async _deleteFromFile(slug) {
        try {
            const metaFilePath = path.join(this.storageDir, `${slug}.json`);
            const contentFilePath = path.join(this.contentDir, slug);
            
            await fs.unlink(metaFilePath);
            await fs.unlink(contentFilePath);
            
            return true;
        } catch {
            return false;
        }
    }

    async _clearAllFromFile() {
        try {
            const metaFiles = await fs.readdir(this.storageDir);
            const contentFiles = await fs.readdir(this.contentDir);
            
            const deletePromises = [
                ...metaFiles.map(file => fs.unlink(path.join(this.storageDir, file))),
                ...contentFiles.map(file => fs.unlink(path.join(this.contentDir, file)))
            ];
            
            await Promise.all(deletePromises);
            
            return { deletedCount: metaFiles.length };
        } catch (error) {
            throw error;
        }
    }

    startStatsProcessor() {
        setInterval(() => {
            this.processStatsQueue();
        }, this.STATS_UPDATE_INTERVAL);

        setInterval(() => {
            if (this.statsQueue.length > this.MAX_QUEUE_SIZE) {
                console.warn(`[STATS] Queue size (${this.statsQueue.length}) exceeds limit, forcing flush`);
                this.processStatsQueue();
            }
        }, 5000);

        process.on('SIGINT', () => {
            console.log('[STATS] Flushing stats queue before shutdown...');
            this.processStatsQueue().then(() => {
                process.exit(0);
            });
        });

        process.on('SIGTERM', () => {
            console.log('[STATS] Flushing stats queue before shutdown...');
            this.processStatsQueue().then(() => {
                process.exit(0);
            });
        });
    }

    async _updateFileStats(action, data = {}) {
        this.statsQueue.push({
            action,
            data,
            timestamp: Date.now()
        });

        this.updateStatsCache(action, data);
    }

    updateStatsCache(action, data) {
        if (!this.statsCache) {
            return;
        }

        const today = new Date().toISOString().split('T')[0];
        
        if (!this.statsCache.dailyStats) {
            this.statsCache.dailyStats = {};
        }
        
        if (!this.statsCache.dailyStats[today]) {
            this.statsCache.dailyStats[today] = {
                pastes: 0,
                views: 0,
                apiRequests: 0
            };
        }

        switch (action) {
            case 'incrementPaste':
                this.statsCache.totalPastes = (this.statsCache.totalPastes || 0) + 1;
                this.statsCache.totalContentSize = (this.statsCache.totalContentSize || 0) + (data.contentSize || 0);
                this.statsCache.dailyStats[today].pastes++;
                
                if (data.isApi) {
                    this.statsCache.apiPastes = (this.statsCache.apiPastes || 0) + 1;
                    this.statsCache.dailyStats[today].apiRequests++;
                } else {
                    this.statsCache.webPastes = (this.statsCache.webPastes || 0) + 1;
                }
                break;
                
            case 'incrementView':
                this.statsCache.totalViews = (this.statsCache.totalViews || 0) + 1;
                this.statsCache.dailyStats[today].views++;
                
                if (data.pasteViews > (this.statsCache.mostViewedPasteViews || 0)) {
                    this.statsCache.mostViewedPasteViews = data.pasteViews;
                    this.statsCache.mostViewedPasteSlug = data.pasteSlug;
                }
                break;
                
            case 'decrementPaste':
                this.statsCache.totalPastes = Math.max(0, (this.statsCache.totalPastes || 0) - 1);
                this.statsCache.totalContentSize = Math.max(0, (this.statsCache.totalContentSize || 0) - (data.contentSize || 0));
                break;
        }
    }

    async processStatsQueue() {
        if (this.isProcessingStats || this.statsQueue.length === 0) {
            return;
        }

        this.isProcessingStats = true;
        
        try {
            console.log(`[STATS] Processing ${this.statsQueue.length} queued updates...`);
            
            let stats = await this.loadStatsFile();
            
            const queueToProcess = [...this.statsQueue];
            this.statsQueue = [];
            
            const today = new Date().toISOString().split('T')[0];
            
            if (!stats.dailyStats) stats.dailyStats = {};
            if (!stats.dailyStats[today]) {
                stats.dailyStats[today] = { pastes: 0, views: 0, apiRequests: 0 };
            }

            for (const update of queueToProcess) {
                const { action, data } = update;
                
                switch (action) {
                    case 'incrementPaste':
                        stats.totalPastes = (stats.totalPastes || 0) + 1;
                        stats.totalContentSize = (stats.totalContentSize || 0) + (data.contentSize || 0);
                        stats.dailyStats[today].pastes++;
                        
                        if (data.isApi) {
                            stats.apiPastes = (stats.apiPastes || 0) + 1;
                            stats.dailyStats[today].apiRequests++;
                        } else {
                            stats.webPastes = (stats.webPastes || 0) + 1;
                        }
                        break;
                        
                    case 'incrementView':
                        stats.totalViews = (stats.totalViews || 0) + 1;
                        stats.dailyStats[today].views++;
                        
                        if (data.pasteViews > (stats.mostViewedPasteViews || 0)) {
                            stats.mostViewedPasteViews = data.pasteViews;
                            stats.mostViewedPasteSlug = data.pasteSlug;
                        }
                        break;
                        
                    case 'decrementPaste':
                        stats.totalPastes = Math.max(0, (stats.totalPastes || 0) - 1);
                        stats.totalContentSize = Math.max(0, (stats.totalContentSize || 0) - (data.contentSize || 0));
                        break;
                }
            }

            stats.lastUpdated = new Date().toISOString();
            stats.lastBatchSize = queueToProcess.length;
            
            await this.writeStatsFile(stats);
            
            this.statsCache = stats;
            this.lastStatsUpdate = Date.now();
            
            console.log(`[STATS] Successfully processed ${queueToProcess.length} updates`);
            
        } catch (error) {
            console.error('[STATS] Error processing stats queue:', error);
            
        } finally {
            this.isProcessingStats = false;
        }
    }

    async loadStatsFile() {
        try {
            const statsData = await fs.readFile(this.statsFile, 'utf8');
            
            if (!statsData || statsData.trim() === '') {
                throw new Error('Empty stats file');
            }
            
            const stats = JSON.parse(statsData);
            
            if (!stats || typeof stats !== 'object') {
                throw new Error('Invalid stats structure');
            }
            
            return this.ensureStatsStructure(stats);
            
        } catch (error) {
            console.warn('[STATS] Corrupted or missing stats file, recovering...');
            
            const recoveredStats = await this._recoverStatsFromFiles();
            const defaultStats = {
                totalPastes: 0,
                totalViews: 0,
                apiPastes: 0,
                webPastes: 0,
                totalContentSize: 0,
                mostViewedPasteViews: 0,
                mostViewedPasteSlug: '',
                dailyStats: {},
                createdAt: new Date().toISOString(),
                lastRecovery: new Date().toISOString()
            };
            
            return this.ensureStatsStructure({ ...defaultStats, ...recoveredStats });
        }
    }

    ensureStatsStructure(stats) {
        return {
            totalPastes: stats.totalPastes || 0,
            totalViews: stats.totalViews || 0,
            apiPastes: stats.apiPastes || 0,
            webPastes: stats.webPastes || 0,
            totalContentSize: stats.totalContentSize || 0,
            mostViewedPasteViews: stats.mostViewedPasteViews || 0,
            mostViewedPasteSlug: stats.mostViewedPasteSlug || '',
            dailyStats: stats.dailyStats || {},
            createdAt: stats.createdAt || new Date().toISOString(),
            lastUpdated: stats.lastUpdated || new Date().toISOString(),
            lastBatchSize: stats.lastBatchSize || 0
        };
    }

    async writeStatsFile(stats) {
        const statsJson = JSON.stringify(stats, null, 2);
        const tempFile = this.statsFile + '.tmp';
        
        try {
            await fs.writeFile(tempFile, statsJson, 'utf8');
        
            await fs.access(tempFile);
            const tempData = await fs.readFile(tempFile, 'utf8');
            JSON.parse(tempData);
            
            try {
                await fs.rename(tempFile, this.statsFile);
            } catch (renameError) {
                await fs.copyFile(tempFile, this.statsFile);
                await fs.unlink(tempFile);
            }
            
        } catch (error) {
            try {
                await fs.unlink(tempFile);
            } catch (cleanupError) {
            }
            throw error;
        }
    }

    async _getFileStats() {
        try {
            if (this.statsCache && (Date.now() - this.lastStatsUpdate) < 60000) {
                return this.formatStatsForOutput(this.statsCache);
            }
            
            const stats = await this.loadStatsFile();
            this.statsCache = stats;
            this.lastStatsUpdate = Date.now();
            
            return this.formatStatsForOutput(stats);
            
        } catch (error) {
            console.error('Error reading file stats:', error);
            return this.getDefaultStats();
        }
    }

    formatStatsForOutput(stats) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        let pastesLast30Days = 0;
        let viewsLast30Days = 0;
        let apiRequestsLast30Days = 0;
        
        Object.entries(stats.dailyStats || {}).forEach(([date, dayStats]) => {
            const statDate = new Date(date);
            if (statDate >= thirtyDaysAgo) {
                pastesLast30Days += dayStats.pastes || 0;
                viewsLast30Days += dayStats.views || 0;
                apiRequestsLast30Days += dayStats.apiRequests || 0;
            }
        });
        
        return {
            totalPastes: stats.totalPastes || 0,
            totalViews: stats.totalViews || 0,
            apiPastes: stats.apiPastes || 0,
            pastesLast30Days,
            storage: stats.totalContentSize ? 
                `${(stats.totalContentSize / 1024 / 1024).toFixed(1)}MB` : '0MB',
            averageViews: stats.totalPastes > 0 ? 
                (stats.totalViews / stats.totalPastes).toFixed(1) : 0,
            topPasteViews: stats.mostViewedPasteViews || 0,
            averageSize: stats.totalPastes > 0 ? 
                `${(stats.totalContentSize / stats.totalPastes / 1024).toFixed(1)}KB` : '0KB',
            queueLength: this.statsQueue.length
        };
    }

    getDefaultStats() {
        return {
            totalPastes: 0,
            totalViews: 0,
            apiPastes: 0,
            pastesLast30Days: 0,
            storage: '0MB',
            averageViews: 0,
            topPasteViews: 0,
            averageSize: '0KB',
            queueLength: this.statsQueue.length
        };
    }

    async _saveToMongoDB(pasteData) {
        try {
const pasteDoc = new pasteModel({
    slug: pasteData.slug,
    title: pasteData.title,
    content: pasteData.content,
    language: pasteData.language,
    views: 0,
    isActive: true,
    lastViewedAt: null,
    password: pasteData.password,
    isPasswordProtected: pasteData.isPasswordProtected,
    maxViews: pasteData.maxViews
});
            
            const savedPaste = await pasteDoc.save();
            
            return {
                slug: savedPaste.slug,
                title: savedPaste.title,
                content: savedPaste.content,
                language: savedPaste.language,
                views: savedPaste.views,
                isActive: savedPaste.isActive,
                createdAt: savedPaste.createdAt,
                lastViewedAt: savedPaste.lastViewedAt
            };
        } catch (error) {
            console.error('[MONGODB] Error saving paste:', error);
            throw error;
        }
    }

    async _findInMongoDB(slug) {
        try {
const paste = await pasteModel.findOne({ 
    slug: slug, 
    isActive: true 
}).select('slug title content language views isActive createdAt lastViewedAt password isPasswordProtected maxViews').lean();
            
            if (!paste) {
                console.log(`[MONGODB] Paste not found: ${slug}`);
                return null;
            }
            
            return {
                slug: paste.slug,
                title: paste.title,
                content: paste.content,
                language: paste.language,
                views: paste.views || 0,
                isActive: paste.isActive,
                createdAt: paste.createdAt,
                lastViewedAt: paste.lastViewedAt
            };
        } catch (error) {
            console.error(`[MONGODB] Error finding paste ${slug}:`, error);
            return null;
        }
    }

    async _updateInMongoDB(slug, updates) {
        try {
const paste = await pasteModel.findOneAndUpdate(
    { slug: slug, isActive: true },
    { 
        $set: updates,
        $inc: { __v: 1 }
    },
    { 
        new: true,
        select: 'slug title content language views isActive createdAt lastViewedAt password isPasswordProtected maxViews'
    }
).lean();
            
            if (!paste) {
                console.log(`[MONGODB] Paste not found for update: ${slug}`);
                return null;
            }
            
return {
    slug: paste.slug,
    title: paste.title,
    content: paste.content,
    language: paste.language,
    views: paste.views || 0,
    isActive: paste.isActive,
    createdAt: paste.createdAt,
    lastViewedAt: paste.lastViewedAt,
    password: paste.password,
    isPasswordProtected: paste.isPasswordProtected,
    maxViews: paste.maxViews
};
        } catch (error) {
            console.error(`[MONGODB] Error updating paste ${slug}:`, error);
            return null;
        }
    }

async _recoverStatsFromFiles() {
    try {
        const metaFiles = await fs.readdir(this.storageDir);
        let totalPastes = 0;
        let totalViews = 0;
        let totalContentSize = 0;
        let mostViewedPasteViews = 0;
        let mostViewedPasteSlug = '';
        
        for (const file of metaFiles) {
            if (!file.endsWith('.json')) continue;
            
            try {
                const filePath = path.join(this.storageDir, file);
                const metaData = await fs.readFile(filePath, 'utf8');
                const paste = JSON.parse(metaData);
                
                if (paste.isActive) {
                    totalPastes++;
                    const views = paste.views || 0;
                    totalViews += views;
                    
                    if (views > mostViewedPasteViews) {
                        mostViewedPasteViews = views;
                        mostViewedPasteSlug = paste.slug;
                    }
                    
                    try {
                        const contentPath = path.join(this.contentDir, paste.slug);
                        const content = await fs.readFile(contentPath, 'utf8');
                        totalContentSize += Buffer.byteLength(content, 'utf8');
                    } catch (e) {
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        console.log(`[STATS] Recovered stats: ${totalPastes} pastes, ${totalViews} views, ${(totalContentSize / 1024 / 1024).toFixed(1)}MB`);
        
        return {
            totalPastes,
            totalViews,
            totalContentSize,
            mostViewedPasteViews,
            mostViewedPasteSlug,
            webPastes: totalPastes,
            apiPastes: 0
        };
    } catch (error) {
        console.error('[STATS] Error recovering stats from files:', error);
        return {};
    }
}

    async _deleteFromMongoDB(slug) {
        try {
            const result = await pasteModel.deleteOne({ slug });
            return result.deletedCount > 0;
        } catch (error) {
            console.error(`[MONGODB] Error deleting paste ${slug}:`, error);
            return false;
        }
    }

    async _getMongoStatsFromPastes() {
        try {
            const totalPastes = await pasteModel.countDocuments({ isActive: true });
            const totalViews = await pasteModel.aggregate([
                { $match: { isActive: true } },
                { $group: { _id: null, total: { $sum: "$views" } } }
            ]);
            
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            
            const pastesLast30Days = await pasteModel.countDocuments({
                isActive: true,
                createdAt: { $gte: thirtyDaysAgo }
            });
            
            return {
                totalPastes: totalPastes || 0,
                totalViews: totalViews[0]?.total || 0,
                apiPastes: 0,
                pastesLast30Days,
                storage: '0MB',
                averageViews: totalPastes > 0 ? ((totalViews[0]?.total || 0) / totalPastes).toFixed(1) : 0,
                topPasteViews: 0,
                averageSize: '0KB'
            };
        } catch (error) {
            console.error('Error calculating MongoDB stats:', error);
            return {
                totalPastes: 0,
                totalViews: 0,
                apiPastes: 0,
                pastesLast30Days: 0,
                storage: '0MB',
                averageViews: 0,
                topPasteViews: 0,
                averageSize: '0KB'
            };
        }
    }

    async checkStatsHealth() {
        if (this.storageType !== 'file') return { healthy: true };
        
        try {
            const statsExists = fsSync.existsSync(this.statsFile);
            
            return {
                healthy: true,
                mainFileExists: statsExists,
                queueLength: this.statsQueue.length,
                isProcessing: this.isProcessingStats,
                lastUpdate: this.lastStatsUpdate,
                cacheAge: this.statsCache ? Date.now() - this.lastStatsUpdate : null,
                version: 2
            };
        } catch (error) {
            return {
                healthy: false,
                error: error.message,
                queueLength: this.statsQueue.length
            };
        }
    }
}

module.exports = Storage;
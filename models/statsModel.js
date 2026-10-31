const mongoose = require('mongoose');

const statsSchema = new mongoose.Schema({
    date: {
        type: Date,
        default: Date.now
    },
    totalPastes: {
        type: Number,
        default: 0
    },
    totalViews: {
        type: Number,
        default: 0
    },
    apiPastes: {
        type: Number,
        default: 0
    },
    webPastes: {
        type: Number,
        default: 0
    },
    totalContentSize: {
        type: Number,
        default: 0
    },
    dailyPastes: {
        type: Number,
        default: 0
    },
    dailyViews: {
        type: Number,
        default: 0
    },
    dailyApiRequests: {
        type: Number,
        default: 0
    },
    mostViewedPasteViews: {
        type: Number,
        default: 0
    },
    mostViewedPasteSlug: {
        type: String,
        default: ''
    }
}, {
    timestamps: true
});

statsSchema.index({ date: 1 }, { unique: true });

statsSchema.statics.incrementPasteCount = async function(isApi = false, contentSize = 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const updateData = {
        $inc: {
            totalPastes: 1,
            dailyPastes: 1,
            totalContentSize: contentSize
        }
    };
    
    if (isApi) {
        updateData.$inc.apiPastes = 1;
        updateData.$inc.dailyApiRequests = 1;
    } else {
        updateData.$inc.webPastes = 1;
    }
    
    return await this.findOneAndUpdate(
        { date: today },
        updateData,
        { upsert: true, new: true }
    );
};

statsSchema.statics.incrementViewCount = async function(pasteSlug, pasteViews) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const updateData = {
        $inc: {
            totalViews: 1,
            dailyViews: 1
        }
    };
    
    const currentStats = await this.findOne({ date: today });
    if (!currentStats || pasteViews > currentStats.mostViewedPasteViews) {
        updateData.$set = {
            mostViewedPasteViews: pasteViews,
            mostViewedPasteSlug: pasteSlug
        };
    }
    
    return await this.findOneAndUpdate(
        { date: today },
        updateData,
        { upsert: true, new: true }
    );
};

statsSchema.statics.decrementPasteCount = async function(contentSize = 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    return await this.findOneAndUpdate(
        { date: today },
        {
            $inc: {
                totalPastes: -1,
                totalContentSize: -contentSize
            }
        },
        { upsert: true, new: true }
    );
};

statsSchema.statics.getAggregatedStats = async function() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const latestStats = await this.findOne().sort({ date: -1 });
    
    const thirtyDayStats = await this.aggregate([
        {
            $match: {
                date: { $gte: thirtyDaysAgo }
            }
        },
        {
            $group: {
                _id: null,
                pastesLast30Days: { $sum: '$dailyPastes' },
                viewsLast30Days: { $sum: '$dailyViews' },
                apiRequestsLast30Days: { $sum: '$dailyApiRequests' }
            }
        }
    ]);
    
    if (!latestStats) {
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
    
    const thirtyDayData = thirtyDayStats[0] || {
        pastesLast30Days: 0,
        viewsLast30Days: 0,
        apiRequestsLast30Days: 0
    };
    
    return {
        totalPastes: latestStats.totalPastes || 0,
        totalViews: latestStats.totalViews || 0,
        apiPastes: latestStats.apiPastes || 0,
        pastesLast30Days: thirtyDayData.pastesLast30Days,
        storage: latestStats.totalContentSize ? 
            `${(latestStats.totalContentSize / 1024 / 1024).toFixed(1)}MB` : '0MB',
        averageViews: latestStats.totalPastes > 0 ? 
            (latestStats.totalViews / latestStats.totalPastes).toFixed(1) : 0,
        topPasteViews: latestStats.mostViewedPasteViews || 0,
        averageSize: latestStats.totalPastes > 0 ? 
            `${(latestStats.totalContentSize / latestStats.totalPastes / 1024).toFixed(1)}KB` : '0KB'
    };
};

module.exports = mongoose.model('Stats', statsSchema);
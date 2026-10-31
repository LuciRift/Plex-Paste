const mongoose = require('mongoose');

const pasteSchema = new mongoose.Schema({
    slug: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        index: true
    },
    title: {
        type: String,
        required: false,
        trim: true,
        maxlength: 200,
        default: function() {
            return `Paste ${this.slug}`;
        }
    },
    content: {
        type: String,
        required: true,
        maxlength: 1000000
    },
    language: {
        type: String,
        required: true,
        default: 'text',
        trim: true
    },
    views: {
        type: Number,
        default: 0
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastViewedAt: {
        type: Date,
        default: null
    },
    password: {
        type: String,
        default: null
    },
    isPasswordProtected: {
        type: Boolean,
        default: false
    },
    maxViews: {
        type: Number,
        default: null
    }
}, {
    timestamps: true
});

pasteSchema.statics.getTotalPastes = function() {
    return this.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: null, totalPastes: { $sum: 1 } } }
    ]);
};

pasteSchema.statics.getTotalViews = function() {
    return this.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: null, totalViews: { $sum: '$views' } } }
    ]);
};

pasteSchema.statics.getTodayViews = function() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    return this.aggregate([
        { 
            $match: { 
                isActive: true,
                lastViewedAt: { $gte: today }
            } 
        },
        { $group: { _id: null, todayViews: { $sum: '$views' } } }
    ]);
};

module.exports = mongoose.model('Paste', pasteSchema);
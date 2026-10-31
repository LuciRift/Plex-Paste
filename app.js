const express = require('express');
const { client } = require("./index.js")
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const yaml = require("js-yaml")
const config = yaml.load(fsSync.readFileSync('./config.yml', 'utf8'));
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const color = require('ansi-colors');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const multer = require('multer');
const botVersion = require('./package.json');
const rateLimit = require('express-rate-limit');

const pasteModel = require('./models/pasteModel');

const StorageAdapter = require('./storage');
const storage = new StorageAdapter();

const SettingsStorage = require('./settingsStorage');
const settingsStorage = new SettingsStorage();

function parseDuration(input) {
    if (typeof input === 'number') {
        return input;
    }

    if (typeof input !== 'string') {
        throw new Error('Duration must be a string or number');
    }

    const units = {
        ms: 1,
        s: 1000,
        sec: 1000,
        second: 1000,
        seconds: 1000,
        m: 60000,
        min: 60000,
        minute: 60000,
        minutes: 60000,
        h: 3600000,
        hr: 3600000,
        hour: 3600000,
        hours: 3600000,
        d: 86400000,
        day: 86400000,
        days: 86400000,
        w: 604800000,
        week: 604800000,
        weeks: 604800000,
        y: 31536000000,
        year: 31536000000,
        years: 31536000000
    };

    const regex = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/;
    const match = input.trim().match(regex);

    if (!match) {
        throw new Error(`Invalid duration format: ${input}`);
    }

    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    if (!(unit in units)) {
        throw new Error(`Unknown time unit: ${unit}`);
    }

    return Math.round(value * units[unit]);
}

const app = express();

const uploadDir = path.join(__dirname, './uploads');
if (!fsSync.existsSync(uploadDir)) {
    fsSync.mkdirSync(uploadDir, { recursive: true });
}

const mStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    if (file.size > 5 * 1024 * 1024) {
        return cb(new Error('File too large'), false);
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/x-icon'];
    if (!allowedTypes.includes(file.mimetype)) {
        return cb(new Error('Invalid file type'), false);
    }

    cb(null, true);
};

const upload = multer({
    storage: mStorage,
    fileFilter: fileFilter,
});

const connectToMongoDB = async () => {
    try {
        if (config.MongoURI) await mongoose.set('strictQuery', false);

        if (config.MongoURI) {
            await mongoose.connect(config.MongoURI);
        } else {
            throw new Error('[ERROR] MongoDB Connection String is not specified in the config! (MongoURI)');
        }
    } catch (error) {
        console.error('\x1b[31m%s\x1b[0m', `[ERROR] Failed to connect to MongoDB: ${error.message}\n${error.stack}`);

        if (error.message.includes('authentication failed')) {
            await console.error('Authentication failed. Make sure to check if you entered the correct username and password in the connection URL.');
            await process.exit(1)
        } else if (error.message.includes('network error')) {
            await console.error('Network error. Make sure the MongoDB server is reachable and the connection URL is correct.');
            await process.exit(1)
        } else if (error.message.includes('permission denied')) {
            await console.error('Permission denied. Make sure the MongoDB cluster has the necessary permissions to read and write.');
            await process.exit(1)
        } else {
            await console.error('An unexpected error occurred. Check the MongoDB connection URL and credentials.');
            await process.exit(1)
        }
    }
};
if(config.storageType === 'mongodb') connectToMongoDB();

const createRateLimiter = (getLimit, getWindow, message) => {
    return async (req, res, next) => {
        try {
            const settings = await settingsStorage.findOne();
            const limit = getLimit(settings);
            const window = getWindow(settings);
            
            if (limit <= 0) return next();
            
            const windowMs = parseDuration(window);
            
            const limiter = rateLimit({
                windowMs: windowMs,
                max: limit,
                message: { error: message },
                standardHeaders: true,
                legacyHeaders: false,
            });
            
            limiter(req, res, next);
        } catch (error) {
            next();
        }
    };
};

const createSettings = async () => {
    let settings = await settingsStorage.findOne();
    if (!settings) {
        settings = await settingsStorage.create();
    }
}
createSettings()

if (config?.trustProxy) app.set('trust proxy', 1);

let sessionConfig = {
    secret: config.secretKey,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: config.Secure,
        maxAge: parseDuration(config.SessionExpires)
    }
};

if (config.storageType === 'mongodb') {
    sessionConfig.store = MongoStore.create({
        mongoUrl: config.MongoURI,
        ttl: parseDuration(config.SessionExpires),
        autoRemove: 'native'
    });
} else {
    sessionConfig.store = new FileStore({
        path: './data/sessions',
        ttl: parseDuration(config.SessionExpires),
        reapInterval: 3600,
        logFn: function() {}
    });
}

app.use(session(sessionConfig));

app.use('/documents', async (req, res, next) => {
    try {
        const settings = await settingsStorage.findOne();
        const maxSizeMB = settings.maxPasteSize || 1;
        
        express.text({ 
            limit: `${maxSizeMB}mb`,
            type: '*/*'
        })(req, res, next);
    } catch (error) {
        express.text({ 
            limit: '1mb',
            type: '*/*'
        })(req, res, next);
    }
});

app.use(cookieParser());
app.use(passport.initialize());
app.use(passport.session());
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

async function loadSettings(req, res, next) {
    try {
        const settings = await settingsStorage.findOne();
        if (!settings) return next(new Error('Settings not found'));

        res.locals.settings = settings;
        res.locals.config = config;

        req.isStaff = function () {
            if (!req.user || !req.user.id) return false;
            return config.OwnerID.includes(req.user.id);
        };

        res.locals.isStaff = req.isStaff();

        next();
    } catch (err) {
        next(err);
    }
}

app.use(loadSettings);

const webRateLimit = createRateLimiter(
    (settings) => settings.rateLimit || 50,
    (settings) => settings.rateLimitWindow || '1h',
    'Too many requests from this IP, please try again later.'
);

const apiRateLimit = createRateLimiter(
    (settings) => settings.apiRateLimit || 500,
    (settings) => settings.apiRateLimitWindow || '1h',
    'API rate limit exceeded, please try again later.'
);

const checkApiKey = async (req, res, next) => {
    try {
        const settings = await settingsStorage.findOne();
        
        if (!settings.requireApiKey) {
            return next();
        }
        
        const apiKey = req.headers['x-api-key'] || req.query.apiKey;
        
        if (!apiKey || apiKey !== settings.apiKey) {
            return res.status(401).json({ error: 'Valid API key required' });
        }
        
        next();
    } catch (error) {
        next();
    }
};

app.use((req, res, next) => {
    const send = res.send;
    res.send = function (body) {
        if (typeof body === 'string' && 
            body.includes('</body>') && 
            !req.path.startsWith('/raw/') && 
            !req.path.startsWith('/api/') &&
            res.get('Content-Type') !== 'text/plain') {
            
            const consoleScript = `
                <script>
                    (function() {
                        const message = \`
%c
Plex Paste is made by Plex Development.
Version: ${botVersion.version}
Buy - https://plexdevelopment.net/products/plexpaste
\`,
                            style = \`
font-family: monospace;
color: #5e99ff;
background-color: #1e1e1e;
padding: 10px;
border: 1px solid #00aaff;
\`;
        
                        console.log(message, style);
                    })();
                </script>
                `;
            body = body.replace('</body>', consoleScript + '</body>');
        }
        send.call(this, body);
    };
    next();
});

function checkStaffAccess(req, res, next) {
    if (req.isStaff()) {
        next();
    } else {
        if (req.isAuthenticated()) {
            req.logout((err) => {
                res.redirect('/');
            });
        } else {
            res.redirect('/');
        }
    }
}

passport.use(new DiscordStrategy(
    {
        clientID: config.clientID,
        clientSecret: config.clientSecret,
        callbackURL: config.callbackURL,
        scope: ['identify'],
    },
    async (accessToken, refreshToken, profile, done) => {
        try {
            return done(null, profile);
        } catch (err) {
            return done(err, null);
        }
    }
));

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((obj, done) => {
    done(null, obj);
});


const isLoggedIn = async (req, res, next) => {
    if (req.isAuthenticated()) {
        next();
    } else {
        res.redirect(`/auth`);
    }
};

function hexToRgb(hex) {
    hex = hex.replace('#', '');
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    return `${r}, ${g}, ${b}`;
}

async function getAccentColor() {
    const settings = await settingsStorage.findOne();
    const hexColor = settings.accentColor
    const rgbColor = hexToRgb(hexColor);
    return { hex: hexColor, rgb: rgbColor };
}

async function cleanupInactivePastes() {
    try {
        const settings = await settingsStorage.findOne();
        
        if (!settings || settings.inactiveDeleteAfter === 'never') {
            return;
        }

        const deleteAfterMs = parseDuration(settings.inactiveDeleteAfter);
        const cutoffDate = new Date(Date.now() - deleteAfterMs);
        
        console.log(`[CLEANUP] Starting cleanup of pastes inactive since ${cutoffDate.toISOString()}`);

        if (config.storageType === 'file') {
            await cleanupFileStorage(cutoffDate);
        } else {
            await cleanupMongoStorage(cutoffDate);
        }

    } catch (error) {
        console.error('[CLEANUP] Error during paste cleanup:', error);
    }
}

async function cleanupFileStorage(cutoffDate) {
    try {
        const metaFiles = await fs.readdir(path.join(__dirname, './data/pastes'));
        let deletedCount = 0;
        let totalSizeFreed = 0;

        for (const file of metaFiles) {
            if (!file.endsWith('.json')) continue;
            
            try {
                const filePath = path.join(__dirname, './data/pastes', file);
                const metaData = await fs.readFile(filePath, 'utf8');
                const paste = JSON.parse(metaData);
                
                if (!paste.isActive) continue;

                const lastViewed = paste.lastViewedAt ? new Date(paste.lastViewedAt) : new Date(paste.createdAt);
                
                if (lastViewed < cutoffDate) {
                    const contentPath = path.join(__dirname, './data/content', paste.slug);
                    try {
                        const content = await fs.readFile(contentPath, 'utf8');
                        totalSizeFreed += Buffer.byteLength(content, 'utf8');
                    } catch (e) {
                    }
                    
                    await storage.deleteInactivePaste(paste.slug);
                    deletedCount++;
                    console.log(`[CLEANUP] Deleted inactive paste: ${paste.slug} (last viewed: ${lastViewed.toISOString()})`);
                }
            } catch (error) {
                console.error(`[CLEANUP] Failed to process paste file ${file}:`, error);
            }
        }

        console.log(`[CLEANUP] File storage cleanup completed. Deleted ${deletedCount} inactive pastes, freed ${(totalSizeFreed / 1024 / 1024).toFixed(1)}MB. Statistics preserved.`);
    } catch (error) {
        console.error('[CLEANUP] Error cleaning file storage:', error);
    }
}

async function cleanupMongoStorage(cutoffDate) {
    try {
        const inactivePastes = await pasteModel.find({
            isActive: true,
            $or: [
                { lastViewedAt: { $lt: cutoffDate } },
                { 
                    lastViewedAt: { $exists: false }, 
                    createdAt: { $lt: cutoffDate } 
                }
            ]
        });

        let deletedCount = 0;
        let totalSizeFreed = 0;

        for (const paste of inactivePastes) {
            try {
                const contentSize = Buffer.byteLength(paste.content, 'utf8');
                totalSizeFreed += contentSize;
                
                await storage.deleteInactivePaste(paste.slug);
                deletedCount++;
                const lastViewed = paste.lastViewedAt || paste.createdAt;
                console.log(`[CLEANUP] Deleted inactive paste: ${paste.slug} (last viewed: ${lastViewed.toISOString()})`);
            } catch (error) {
                console.error(`[CLEANUP] Failed to delete paste ${paste.slug}:`, error);
            }
        }

        console.log(`[CLEANUP] MongoDB cleanup completed. Deleted ${deletedCount} inactive pastes, freed ${(totalSizeFreed / 1024 / 1024).toFixed(1)}MB. Statistics preserved.`);
    } catch (error) {
        console.error('[CLEANUP] Error cleaning MongoDB storage:', error);
    }
}

function startCleanupScheduler() {
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
    
    setTimeout(() => {
        cleanupInactivePastes();
    }, 60000);
    
    setInterval(() => {
        cleanupInactivePastes();
    }, CLEANUP_INTERVAL);
}

app.use(async (req, res, next) => {
    try {
        const { hex, rgb } = await getAccentColor();
        res.locals.accentColorHex = hex;
        res.locals.accentColorRgb = rgb;
        next();
    } catch (error) {
        console.error('Failed to fetch accent colors:', error.message);
        next();
    }
});

app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
    if (req.isStaff()) {
        res.redirect('/staff');
    } else {
        req.logout((err) => {
            res.redirect('/');
        });
    }
});
app.get('/auth', passport.authenticate('discord'));

async function generateSlug() {
    const settings = await settingsStorage.findOne();
    const length = settings.slugLength || 8;
    const characterSet = settings.slugCharacterSet || 'alphanumeric';
    
    let chars;
    switch (characterSet) {
        case 'alphanumeric':
            chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            break;
        case 'letters':
            chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
            break;
        case 'numbers':
            chars = '0123456789';
            break;
        case 'lowercase':
            chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            break;
        case 'hex':
            chars = '0123456789abcdef';
            break;
        default:
            chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    }
    
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

app.get('/', async (req, res) => {
    try {
        const settings = await settingsStorage.findOne();
        
        const protocol = req.protocol;
        const host = req.get('host');
        const fullUrl = `${protocol}://${host}`;
        
        res.render('create-paste', {
            settings,
            url: fullUrl
        });
    } catch (error) {
        console.error('Error loading main page:', error);
        res.status(500).send('Error loading page');
    }
});

function detectLanguage(content, filename = null) {
    const trimmed = content.trim();
    
    if (filename) {
        const ext = filename.toLowerCase().split('.').pop();
        const extensionMap = {
            'js': 'javascript', 'mjs': 'javascript', 'jsx': 'javascript',
            'ts': 'typescript', 'tsx': 'typescript',
            'py': 'python', 'pyw': 'python',
            'java': 'java',
            'cs': 'csharp',
            'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'c++': 'cpp',
            'c': 'c', 'h': 'c',
            'php': 'php',
            'html': 'markup', 'htm': 'markup',
            'css': 'css',
            'go': 'go',
            'rs': 'rust',
            'rb': 'ruby',
            'sql': 'sql',
            'json': 'json',
            'xml': 'xml',
            'yml': 'yaml', 'yaml': 'yaml',
            'md': 'markdown',
            'sh': 'bash',
            'ps1': 'powershell',
            'kt': 'kotlin',
            'swift': 'swift',
            'dart': 'dart',
            'lua': 'lua',
            'pl': 'perl',
            'scala': 'scala',
            'dockerfile': 'docker'
        };
        
        if (extensionMap[ext]) {
            return extensionMap[ext];
        }
    }
    
    if (/^```(\w+)?\s*\n[\s\S]*\n```$/m.test(trimmed)) {
        const match = trimmed.match(/^```(\w+)?\s*\n([\s\S]*)\n```$/m);
        if (match) {
            const specifiedLang = match[1];
            const codeContent = match[2].trim();
            
            return detectLanguage(codeContent);
        }
    }
    
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || 
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            JSON.parse(trimmed);
            return 'json';
        } catch (e) {}
    }
    
    if (trimmed.startsWith('<?xml') || trimmed.startsWith('<!DOCTYPE')) {
        if (trimmed.includes('<html') || trimmed.includes('<HTML')) return 'markup';
        return 'xml';
    }
    
    if (trimmed.startsWith('<?php')) return 'php';
    
    if (trimmed.startsWith('FROM ') || /^(RUN|COPY|ADD|WORKDIR|EXPOSE|CMD|ENTRYPOINT)\s/m.test(trimmed)) {
        return 'docker';
    }
    
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/mi.test(trimmed)) {
        return 'sql';
    }
    
    const hasStrongYaml = (
        /^---\s*$/m.test(trimmed) ||
        /^(apiVersion|kind|metadata|spec|data):\s*/m.test(trimmed) ||
        /^(services|networks|volumes):\s*$/m.test(trimmed) ||
        /^(LicenseKey|MongoURI|OwnerID|clientID|clientSecret|baseURL|Port):\s*/m.test(trimmed) ||
        /^(version|name|description|image|env|ports|command|entrypoint):\s*/m.test(trimmed) ||
        /^(host|port|user|password|database|timeout):\s*/m.test(trimmed)
    );
    
    if (hasStrongYaml) {
        return 'yaml';
    }
    
    const lines = trimmed.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
    const configLines = lines.filter(line => /^[\w-]+:\s*.+$/.test(line.trim()));
    const isConfigFile = configLines.length >= 5 && (configLines.length / lines.length) > 0.6;
    
    if (isConfigFile) {
        const hasRealCode = (
            /\b(function|class|interface|import|export|require|module\.exports)\b/.test(trimmed) ||
            /=>/g.test(trimmed) ||
            /console\.(log|error|warn)/.test(trimmed) ||
            /\.(then|catch)\s*\(/.test(trimmed) ||
            /app\.(get|post|put|delete|use)/.test(trimmed) ||
            /document\.|window\./.test(trimmed) ||
            /\$\{.*\}/.test(trimmed) ||
            /async\s+function|await\s+/.test(trimmed)
        );
        
        if (!hasRealCode) {
            return 'yaml';
        }
    }

    const hasJavaScript = (
        /\b(const|let|var)\s+\w+/.test(trimmed) ||
        /\bfunction\s+\w+\s*\(/.test(trimmed) ||
        /\b(import|export|require)\s+/.test(trimmed) ||
        /=>/g.test(trimmed) ||
        /console\.(log|error|warn)/.test(trimmed) ||
        /\.(then|catch)\s*\(/.test(trimmed) ||
        /module\.exports/.test(trimmed) ||
        /app\.(get|post|put|delete|use)/.test(trimmed) ||
        /document\.|window\./.test(trimmed) ||
        /\$\{.*\}/.test(trimmed) ||
        /async\s+function|await\s+/.test(trimmed)
    );
    
    if (hasJavaScript) {
        const hasTypeScript = (
            (/:\s*(string|number|boolean|object|any|void|undefined|null)\b/.test(trimmed) && /\binterface\b/.test(trimmed)) ||
            (/\binterface\s+\w+/.test(trimmed) && /\{/.test(trimmed)) ||
            (/\btype\s+\w+\s*=/.test(trimmed) && /\{/.test(trimmed)) ||
            (/<[A-Z]\w*>/.test(trimmed) && /\bfunction\b/.test(trimmed)) ||
            (/\bas\s+\w+/.test(trimmed) && /\bfunction\b/.test(trimmed))
        );
        
        return hasTypeScript ? 'typescript' : 'javascript';
    }
    
    const hasPython = (
        /^def\s+\w+\s*\(/m.test(trimmed) ||
        /^class\s+\w+/m.test(trimmed) ||
        /^(from|import)\s+\w+/m.test(trimmed) ||
        /\bprint\s*\(/.test(trimmed) ||
        /if\s+__name__\s*==\s*['"]__main__['"]/.test(trimmed)
    );
    
    if (hasPython) return 'python';
    
    const hasCSS = (
        /[\w-]+\s*\{\s*[\w-]+\s*:\s*[^;]+;/.test(trimmed) ||
        /@(media|import|keyframes)/.test(trimmed) ||
        /\.([\w-]+)\s*\{/.test(trimmed) ||
        /#[\w-]+\s*\{/.test(trimmed)
    );
    
    if (hasCSS) return 'css';
    
    const hasHTML = (
        /<(html|head|body|div|span|p|h[1-6]|img|a|form|input|button|table|ul|ol|li)\b[^>]*>/i.test(trimmed) &&
        !hasJavaScript
    );
    
    if (hasHTML) return 'markup';
    
    const hasMarkdown = (
        /^#{1,6}\s+/m.test(trimmed) ||
        /```/.test(trimmed) ||
        /\[.*?\]\(.*?\)/.test(trimmed) ||
        /^\s*[\*\-\+]\s+[^:]/m.test(trimmed) ||
        /^\d+\.\s+/m.test(trimmed)
    );
    
    if (hasMarkdown) return 'markdown';
    
    if (/#include\s*</.test(trimmed) || /int\s+main\s*\(/.test(trimmed) || /std::/.test(trimmed)) {
        return 'cpp';
    }
    
    if (/public\s+class\s+\w+/.test(trimmed) || /public\s+static\s+void\s+main/.test(trimmed)) {
        return 'java';
    }
    
    if (/^package\s+\w+/m.test(trimmed) || /func\s+\w+\s*\(/.test(trimmed)) {
        return 'go';
    }
    
    if (/fn\s+\w+\s*\(/.test(trimmed) || /println!\s*\(/.test(trimmed)) {
        return 'rust';
    }
    
    return 'plaintext';
}

app.post('/create/paste', webRateLimit, async (req, res) => {
    try {
        const settings = await settingsStorage.findOne();
        const { content, password, maxViews } = req.body;

        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const maxSizeMB = settings.maxPasteSize || 10;
        const maxSizeBytes = maxSizeMB * 1024 * 1024;
        
        if (content.length > maxSizeBytes) {
            return res.status(400).json({ error: `Content must be less than ${maxSizeMB}MB` });
        }

        let slug;
        let attempts = 0;
        const maxAttempts = 10;

        do {
            slug = await generateSlug();
            attempts++;
            
            if (attempts > maxAttempts) {
                return res.status(500).json({ error: 'Failed to generate unique slug' });
            }
        } while (await storage.findPaste(slug));

        const language = settings.enableSyntaxHighlighting ? detectLanguage(content) : 'plaintext';
        const title = `Paste ${slug}`;

        let hashedPassword = null;
        let isPasswordProtected = false;
        if (password && password.trim()) {
            const bcrypt = require('bcrypt');
            hashedPassword = await bcrypt.hash(password.trim(), 10);
            isPasswordProtected = true;
        }

        const pasteData = {
            slug,
            title,
            content: content.trim(),
            language,
            expiresAt: null,
            password: hashedPassword,
            isPasswordProtected,
            burnAfterRead: false,
            maxViews: maxViews && maxViews > 0 ? parseInt(maxViews) : null
        };

        const paste = await storage.savePaste(pasteData, false);

        res.status(201).json({
            success: true,
            slug: paste.slug,
            url: `${req.protocol}://${req.get('host')}/${paste.slug}`,
            language: paste.language
        });

    } catch (error) {
        console.error('Error creating paste:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/stats', isLoggedIn, checkStaffAccess, async (req, res) => {
    try {
        const stats = await storage.getStats();
        res.json(stats);
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

app.get('/raw/:slug', webRateLimit, async (req, res) => {
    try {
        const { slug } = req.params;
        
        const paste = await storage.findPaste(slug);

        if (!paste) {
            return res.status(404).send('Paste not found');
        }

if (paste.isPasswordProtected) {
    const sessionKey = `paste_${slug}_unlocked`;
    
    if (!req.session[sessionKey] && !req.isStaff()) {
        return res.status(401).send('Password required to access this paste');
    }
}

        if (paste.maxViews && paste.views >= paste.maxViews) {
            await storage.deleteInactivePaste(slug);
            return res.status(404).send('Paste not found');
        }

        res.set('Content-Type', 'text/plain');
        res.send(paste.content);

    } catch (error) {
        console.error('Error loading raw paste:', error);
        res.status(500).send('Error loading paste');
    }
});

app.post('/documents', apiRateLimit, checkApiKey, async (req, res) => {
    try {
        const settings = await settingsStorage.findOne();
        
        if (!settings.enableAPI) {
            return res.status(403).json({ message: 'API_DISABLED' });
        }
        
        let content;
        let password = null;
        let maxViews = null;
        
        if (typeof req.body === 'string') {
            content = req.body;
        } else if (req.body && typeof req.body === 'object') {
            if (req.body.content !== undefined) {
                content = req.body.content;
                password = req.body.password || null;
                maxViews = req.body.maxViews || null;
            } else {
                content = JSON.stringify(req.body, null, 2);
            }
        } else {
            return res.status(400).json({ message: 'NO_CONTENT' });
        }

        if (!content || !String(content).trim()) {
            return res.status(400).json({ message: 'CONTENT_REQUIRED' });
        }

        const maxSizeMB = settings.maxPasteSize || 10;
        const maxSizeBytes = maxSizeMB * 1024 * 1024;
        
        if (String(content).length > maxSizeBytes) {
            return res.status(400).json({ message: 'CONTENT_TOO_LARGE' });
        }

        if (maxViews !== null) {
            const parsedMaxViews = parseInt(maxViews);
            if (isNaN(parsedMaxViews) || parsedMaxViews < 1) {
                return res.status(400).json({ message: 'INVALID_MAX_VIEWS' });
            }
            maxViews = parsedMaxViews;
        }

        if (password !== null && typeof password !== 'string') {
            return res.status(400).json({ message: 'INVALID_PASSWORD_FORMAT' });
        }

        let slug;
        let attempts = 0;
        const maxAttempts = 10;

        do {
            slug = await generateSlug();
            attempts++;
            
            if (attempts > maxAttempts) {
                return res.status(500).json({ message: 'SLUG_GENERATION_FAILED' });
            }
        } while (await storage.findPaste(slug));

        const contentAsString = String(content);
        const language = settings.enableSyntaxHighlighting ? detectLanguage(contentAsString) : 'plaintext';
        const title = `Paste ${slug}`;

        let hashedPassword = null;
        let isPasswordProtected = false;
        if (password && password.trim()) {
            const bcrypt = require('bcrypt');
            hashedPassword = await bcrypt.hash(password.trim(), 10);
            isPasswordProtected = true;
        }

        const pasteData = {
            slug,
            title,
            content: contentAsString.trim(),
            language,
            password: hashedPassword,
            isPasswordProtected,
            maxViews: maxViews
        };

        const paste = await storage.savePaste(pasteData, true);

        const response = {
            key: paste.slug,
            url: `${req.protocol}://${req.get('host')}/${paste.slug}`
        };

        if (isPasswordProtected) {
            response.password_protected = true;
        }

        if (maxViews) {
            response.max_views = maxViews;
        }

        res.status(200).json(response);

    } catch (error) {
        console.error('Error creating paste via documents API:', error);
        res.status(500).json({ message: 'INTERNAL_ERROR' });
    }
});

app.get('/staff', isLoggedIn, checkStaffAccess, async (req, res) => {
    try {
        const settings = await settingsStorage.findOne();

        res.render('settings', {
            user: req.user,
            settings,
            host: req.get('host'),
        });
    } catch (error) {
        console.error('Error loading staff panel:', error);
        res.status(500).send('Error loading staff panel');
    }
});

app.post('/staff/settings', upload.fields([{ name: 'logo' }, { name: 'favicon' }]), isLoggedIn, checkStaffAccess, async (req, res) => {
    try {
        let dbSettings = await settingsStorage.findOne();
        if (!dbSettings) {
            dbSettings = await settingsStorage.create();
        }

        if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
            const { section, settings } = req.body;

            if (section === 'security') {
                if (settings.rateLimit !== undefined) dbSettings.rateLimit = parseInt(settings.rateLimit);
                if (settings.rateLimitWindow !== undefined) dbSettings.rateLimitWindow = settings.rateLimitWindow;
                if (settings.maxPasteSize !== undefined) dbSettings.maxPasteSize = parseFloat(settings.maxPasteSize);
                if (settings.enableAPI !== undefined) dbSettings.enableAPI = settings.enableAPI;
                if (settings.apiRateLimit !== undefined) dbSettings.apiRateLimit = parseInt(settings.apiRateLimit);
                if (settings.apiRateLimitWindow !== undefined) dbSettings.apiRateLimitWindow = settings.apiRateLimitWindow;
                if (settings.requireApiKey !== undefined) dbSettings.requireApiKey = settings.requireApiKey;
                if (settings.apiKey !== undefined) dbSettings.apiKey = settings.apiKey;
            }

            if (section === 'advanced') {
                if (settings.inactiveDeleteAfter !== undefined) dbSettings.inactiveDeleteAfter = settings.inactiveDeleteAfter;
                if (settings.enableSyntaxHighlighting !== undefined) dbSettings.enableSyntaxHighlighting = settings.enableSyntaxHighlighting;
                if (settings.slugLength !== undefined) dbSettings.slugLength = parseInt(settings.slugLength);
                if (settings.slugCharacterSet !== undefined) dbSettings.slugCharacterSet = settings.slugCharacterSet;
            }
        } else {
            const { websiteName, accentColor, description, seoTitle, seoDescription, seoKeywords } = req.body;
            
            if (websiteName) dbSettings.name = websiteName;
            if (accentColor) dbSettings.accentColor = accentColor;
            if (seoTitle) dbSettings.seoTitle = seoTitle;
            if (seoDescription) dbSettings.seoDescription = seoDescription;
            if (seoKeywords) dbSettings.seoKeywords = seoKeywords;
            
            if (req.files && req.files.logo) {
                dbSettings.logo = `/uploads/${req.files.logo[0].filename}`;
            }
            if (req.files && req.files.favicon) {
                dbSettings.favicon = `/uploads/${req.files.favicon[0].filename}`;
            }
        }

        await settingsStorage.save(dbSettings);

        res.json({ success: true, message: 'Settings saved successfully' });
    } catch (error) {
        console.error('Error saving settings:', error);
        res.status(500).json({ success: false, error: 'Failed to save settings' });
    }
});

app.delete('/staff/clear-all-pastes', isLoggedIn, checkStaffAccess, async (req, res) => {
    try {
        const resetStats = req.body.resetStats !== false;
        
        const result = await storage.clearAllPastes(resetStats);
        res.json({ 
            success: true, 
            message: `Deleted ${result.deletedCount} pastes successfully ${resetStats ? '(statistics reset)' : '(statistics preserved)'}`,
            deletedCount: result.deletedCount 
        });
    } catch (error) {
        console.error('Error clearing pastes:', error);
        res.status(500).json({ success: false, error: 'Failed to clear pastes' });
    }
});

app.get('/logout', (req, res) => {
    req.logout((err) => {
        if (err) {
            console.error('Error during logout:', err);
            return next(err);
        }
        res.redirect('/');
    });
});

app.delete('/staff/paste/:slug', isLoggedIn, checkStaffAccess, async (req, res) => {
    try {
        const { slug } = req.params;
        
        const paste = await storage.findPaste(slug);
        if (!paste) {
            return res.status(404).json({ success: false, error: 'Paste not found' });
        }
        const preserveStats = req.body.preserveStats !== false;
        
        await storage.deleteStaffPaste(slug, preserveStats);

        console.log(`Staff member ${req.user.username} (${req.user.id}) permanently deleted paste: ${slug} (stats ${preserveStats ? 'preserved' : 'decremented'})`);

        res.json({ 
            success: true, 
            message: `Paste permanently deleted ${preserveStats ? '(statistics preserved)' : '(statistics updated)'}`,
            slug: slug
        });
    } catch (error) {
        console.error('Error deleting paste:', error);
        res.status(500).json({ success: false, error: 'Failed to delete paste' });
    }
});

app.post('/create/paste', webRateLimit, async (req, res) => {
    try {
        const settings = await settingsStorage.findOne();
        const { content } = req.body;

        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const maxSizeMB = settings.maxPasteSize || 10;
        const maxSizeBytes = maxSizeMB * 1024 * 1024;
        
        if (content.length > maxSizeBytes) {
            return res.status(400).json({ error: `Content must be less than ${maxSizeMB}MB` });
        }

        let slug;
        let attempts = 0;
        const maxAttempts = 10;

        do {
            slug = await generateSlug();
            attempts++;
            
            if (attempts > maxAttempts) {
                return res.status(500).json({ error: 'Failed to generate unique slug' });
            }
        } while (await storage.findPaste(slug));

        const language = settings.enableSyntaxHighlighting ? detectLanguage(content) : 'plaintext';
        const title = `Paste ${slug}`;

        const paste = await storage.savePaste({
            slug,
            title,
            content: content.trim(),
            language
        }, false);

        res.status(201).json({
            success: true,
            slug: paste.slug,
            url: `${req.protocol}://${req.get('host')}/${paste.slug}`,
            language: paste.language
        });

    } catch (error) {
        console.error('Error creating paste:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/documents', apiRateLimit, checkApiKey, async (req, res) => {
    try {
        const settings = await settingsStorage.findOne();
        
        if (!settings.enableAPI) {
            return res.status(403).json({ message: 'API_DISABLED' });
        }
        
        let content;
        
        if (typeof req.body === 'string') {
            content = req.body;
        } else if (req.body && typeof req.body === 'object') {
            if (req.body.content !== undefined) {
                content = req.body.content;
            } else {
                content = JSON.stringify(req.body, null, 2);
            }
        } else {
            return res.status(400).json({ message: 'NO_CONTENT' });
        }

        if (!content || !String(content).trim()) {
            return res.status(400).json({ message: 'CONTENT_REQUIRED' });
        }

        const maxSizeMB = settings.maxPasteSize || 10;
        const maxSizeBytes = maxSizeMB * 1024 * 1024;
        
        if (String(content).length > maxSizeBytes) {
            return res.status(400).json({ message: 'CONTENT_TOO_LARGE' });
        }

        let slug;
        let attempts = 0;
        const maxAttempts = 10;

        do {
            slug = await generateSlug();
            attempts++;
            
            if (attempts > maxAttempts) {
                return res.status(500).json({ message: 'SLUG_GENERATION_FAILED' });
            }
        } while (await storage.findPaste(slug));

        const contentAsString = String(content);
        const language = settings.enableSyntaxHighlighting ? detectLanguage(contentAsString) : 'plaintext';
        const title = `Paste ${slug}`;

        const paste = await storage.savePaste({
            slug,
            title,
            content: contentAsString.trim(),
            language
        }, true);

        res.status(200).json({
            key: paste.slug
        });

    } catch (error) {
        console.error('Error creating paste via documents API:', error);
        res.status(500).json({ message: 'INTERNAL_ERROR' });
    }
});

app.get('/api/stats', isLoggedIn, checkStaffAccess, async (req, res) => {
    try {
        const stats = await storage.getStats();
        res.json(stats);
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

app.get('/:slug', webRateLimit, async (req, res) => {
    try {
        const { slug } = req.params;

        if (slug === 'favicon.ico') {
            return res.status(404).end();
        }

        const paste = await storage.findPaste(slug);

        if (!paste) {
            return res.status(404).render('404', {
                settings: await settingsStorage.findOne() 
            });
        }

if (paste.isPasswordProtected) {
    const sessionKey = `paste_${slug}_unlocked`;
    
    if (!req.session[sessionKey] && !req.isStaff()) {
        return res.render('password-prompt', {
            slug,
            settings: await settingsStorage.findOne()
        });
    }
}

        if (paste.maxViews && paste.views >= paste.maxViews) {
            await storage.deleteInactivePaste(slug);
            return res.status(404).render('404', {
                settings: await settingsStorage.findOne()
            });
        }

        const viewKey = `paste_${slug}_viewed`;
        let shouldIncrementView = false;
        
        if (!req.session[viewKey]) {
            req.session[viewKey] = true;
            shouldIncrementView = true;
        }

        let newViews = paste.views || 0;
        
        if (shouldIncrementView) {
            newViews = newViews + 1;
            await storage.updatePaste(slug, {
                views: newViews,
                lastViewedAt: new Date().toISOString()
            });
        }

        const settings = await settingsStorage.findOne();
        
        const lineCount = paste.content ? (paste.content.match(/\n/g) || []).length + 1 : 1;
        const digits = lineCount.toString().length;
        const calculatedWidth = (digits * 9) + 12;
        const lineNumbersWidth = Math.min(Math.max(calculatedWidth, 35), 65);
        
        res.render('view-paste', {
            paste: {
                ...paste,
                views: newViews
            },
            settings,
            host: req.get('host'),
            lineCount,
            lineNumbersWidth
        });

    } catch (error) {
        console.error('Error loading paste:', error);
        res.status(500).send('Error loading paste');
    }
});

app.post('/:slug', webRateLimit, async (req, res) => {
    try {
        const { slug } = req.params;
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'Password is required' });
        }

        const paste = await storage.findPaste(slug);

        if (!paste) {
            return res.status(404).json({ error: 'Paste not found' });
        }

        if (!paste.isPasswordProtected) {
            return res.status(400).json({ error: 'Paste is not password protected' });
        }

        const bcrypt = require('bcrypt');
        const isValidPassword = await bcrypt.compare(password, paste.password);

        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        const sessionKey = `paste_${slug}_unlocked`;
        req.session[sessionKey] = true;
        
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Session error' });
            }
            res.status(200).json({ success: true });
        });

    } catch (error) {
        console.error('Error verifying password:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something went wrong!');
});

app.listen(config.Port, async () => {
    startCleanupScheduler();

    console.log("――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――");
    console.log("                                                                          ");
    if (config.LicenseKey) console.log(`${color.green.bold.underline(`Plex Paste v${botVersion.version} is now Online!`)} (${color.gray(`${config.LicenseKey.slice(0, -10)}`)})`);
    if (!config.LicenseKey) console.log(`${color.green.bold.underline(`Plex Paste v${botVersion.version} is now Online! `)}`);
    console.log(`• Join our discord server for support, ${color.cyan(`discord.gg/plexdev`)}`);
    console.log(`• Documentation can be found here, ${color.cyan(`docs.plexdevelopment.net`)}`);
    console.log(`• By using this product you agree to all terms located here, ${color.yellow(`plexdevelopment.net/tos`)}`);
    if (config.LicenseKey) console.log("                                                                          ");
    if (config.LicenseKey) console.log(`${color.green.bold.underline(`Source Code:`)}`);
    if (config.LicenseKey) console.log(`• You can buy the full source code at ${color.yellow(`plexdevelopment.net/products/ppsourcecode`)}`);
    if (config.LicenseKey) console.log(`• Use code ${color.green.bold.underline(`PLEX`)} for 10% OFF!`);
    console.log("                                                                          ");
    console.log("――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――");
    console.log(color.yellow("[DASHBOARD] ") + `Web Server has started and is accessible with port ${color.yellow(`${config.Port}`)}`)
});
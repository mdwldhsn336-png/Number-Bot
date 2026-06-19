require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');
const { authenticator } = require('otplib');

// --- ক্র্যাশ প্রোটেকশন ---
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err.message); });

// --- Express Server (For Webhook & Keep-Alive) ---
const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL; 

app.use(express.json());
app.get('/', (req, res) => res.send('Premium Fire OTP Bot v27.0 (Referral & Top Users Bonus) is Running!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- MongoDB Setup ---
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://mdwld2005_db_user:L8W7tzuYEkJgOuNr@firexotpbot.7hhtdlf.mongodb.net/?appName=FireXotpbot";

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- Mongoose Schemas ---
const UserSchema = new mongoose.Schema({
    id: String,
    first_name: String,
    username: String,
    total_numbers: { type: Number, default: 0 },
    total_otps: { type: Number, default: 0 },
    today_otps: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    today_balance: { type: Number, default: 0 },
    last_active_date: String,
    banned: { type: Boolean, default: false },
    joined: String,
    two_fa: { type: Array, default: [] },
    referred_by: { type: String, default: null },
    referral_count: { type: Number, default: 0 },
    referral_earnings: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

const SettingSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    data: mongoose.Schema.Types.Mixed
});
const Setting = mongoose.model('Setting', SettingSchema);

const EarningSchema = new mongoose.Schema({
    user_id: String,
    num_id: String,
    date: String
});
const Earning = mongoose.model('Earning', EarningSchema);

const WithdrawSchema = new mongoose.Schema({
    wd_id: String,
    user_id: String,
    amount: Number,
    method: String,
    account: String,
    status: { type: String, default: 'pending' },
    date: String
});
const Withdraw = mongoose.model('Withdraw', WithdrawSchema);

// --- কনফিগারেশন ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const OTP_GROUP_ID = "@otp_number_grp";
const PAYMENT_GROUP_ID = "-1003925192534"; 
const NUMBER_EXPIRY_MS = 15 * 60 * 1000; 

let bot;
if (SERVER_URL) {
    bot = new TelegramBot(BOT_TOKEN);
    bot.setWebHook(`${SERVER_URL}/bot${BOT_TOKEN}`);
    app.post(`/bot${BOT_TOKEN}`, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
    console.log(`✅ Webhook set to ${SERVER_URL}`);
} else {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    bot.on('polling_error', (err) => console.log("Polling Error:", err.message));
    console.log(`⚠️ Polling mode activated.`);
}

let botUsername = "";
bot.getMe().then(me => { botUsername = me.username; });

let adminState = {};
let userState = {};

// ==========================================
// 🔥 DUAL PANEL API SETUP (FIXED ROUTES)
// ==========================================
const PANELS = {
    stexsms: { baseUrl: 'https://api.2oo9.cloud/MXS47FLFX0U/tness/@public/api' },
    voltxsms: { baseUrl: 'https://api.2oo9.cloud/MXS47FLFX0U/tnevs/@public/api' }
};

let panelKeys = { stexsms: "MKMGV6W3B12", voltxsms: "" }; 

async function loadPanelKeys() {
    try {
        const doc = await Setting.findOne({ key: 'panel_keys' });
        if (doc && doc.data) {
            panelKeys.stexsms = doc.data.stexsms || "MKMGV6W3B12";
            panelKeys.voltxsms = doc.data.voltxsms || "";
        }
    } catch(e) {}
}

async function savePanelKey(panel, key) {
    panelKeys[panel] = key.trim();
    await Setting.findOneAndUpdate({ key: 'panel_keys' }, { data: panelKeys }, { upsert: true });
}

async function panelRequest(method, endpoint, data = null, panelName = 'stexsms') {
    const key = panelKeys[panelName];
    if (!key) throw new Error(`NO_API_KEY_${panelName}`);
    
    const cleanKey = key.trim();
    const url = `${PANELS[panelName].baseUrl}${endpoint}`;
    
    const headers = { 
        'mauthapi': cleanKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    
    try {
        if(method === 'post') {
            return await axios.post(url, data, { headers, timeout: 15000 });
        } else {
            return await axios.get(url, { headers, timeout: 15000 });
        }
    } catch (e) { throw e; }
}

// ==========================================
// 🚀 CONFIG & STATE MANAGERS 
// ==========================================
const activeNumbers = new Map(); 
const deliveredOtps = new Set();
const seenConsoleHits = new Set();
const userLastSession = new Map(); 

// 🟢 Business Date Logic (Day resets at 6:00 AM BD Time)
function getBusinessDate() {
    const now = new Date();
    const bdTimeMs = now.getTime() + (now.getTimezoneOffset() * 60000) + (6 * 3600000);
    const businessTime = new Date(bdTimeMs - (6 * 3600000));
    return businessTime.toISOString().split('T')[0];
}

setInterval(() => {
    const now = Date.now();
    for (let [number, data] of activeNumbers.entries()) {
        if (now - data.createdAt > NUMBER_EXPIRY_MS) {
            activeNumbers.delete(number);
            updateGlobalStats('failed');
        }
    }
}, 60000);

async function getAppConfig() {
    try {
        let doc = await Setting.findOne({ key: 'app_config' });
        let config = doc && doc.data ? doc.data : {};
        if (config.per_otp_rate === undefined) config.per_otp_rate = 5;
        if (config.min_withdraw === undefined) config.min_withdraw = 50;
        if (config.pay_methods === undefined) config.pay_methods = ['Binance'];
        if (config.reward_system === undefined) config.reward_system = true;
        if (config.stexsms_on === undefined) config.stexsms_on = true;     
        if (config.voltxsms_on === undefined) config.voltxsms_on = true;   
        if (config.force_start === undefined) config.force_start = false;  
        if (config.global_feed_on === undefined) config.global_feed_on = true; 
        if (config.ref_otp_commission === undefined) config.ref_otp_commission = 0.5; // Default 0.5 tk per OTP 
        if (config.bonus_top1 === undefined) config.bonus_top1 = 50;
        if (config.bonus_top2 === undefined) config.bonus_top2 = 30;
        if (config.bonus_top3 === undefined) config.bonus_top3 = 20;
        return config;
    } catch(e) { 
        return { per_otp_rate: 5, min_withdraw: 50, pay_methods: ['Binance'], reward_system: true, stexsms_on: true, voltxsms_on: true, force_start: false, global_feed_on: true, ref_otp_commission: 0.5, bonus_top1: 50, bonus_top2: 30, bonus_top3: 20 }; 
    }
}
async function saveAppConfig(data) { await Setting.findOneAndUpdate({ key: 'app_config' }, { data }, { upsert: true }); }

async function ensureUser(user) {
    if (!user || !user.id) return null;
    try {
        const today = getBusinessDate();
        let u = await User.findOne({ id: String(user.id) });
        if (!u) {
            u = new User({ id: String(user.id), first_name: user.first_name || 'User', username: user.username || 'N/A', joined: new Date().toISOString(), last_active_date: today });
            await u.save();
        } else {
            if (u.last_active_date !== today) { u.today_otps = 0; u.today_balance = 0; u.last_active_date = today; await u.save(); }
        }
        return u;
    } catch(e) { return null; }
}

async function updateUserStat(userId, type) {
    try { if (type === 'number') await User.findOneAndUpdate({ id: String(userId) }, { $inc: { total_numbers: 1 } }); } catch(e){}
}
async function updateGlobalStats(type) {
    try {
        let update = {};
        if (type === 'pending') update = { 'data.pending': 1 };
        if (type === 'success') { update = { 'data.success': 1, 'data.pending': -1 }; }
        if (type === 'failed') { update = { 'data.failed': 1, 'data.pending': -1 }; }
        await Setting.findOneAndUpdate({ key: 'global_stats' }, { $inc: update }, { upsert: true });
    } catch(e){}
}

async function loadRanges() {
    try { const doc = await Setting.findOne({ key: 'platforms' }); return doc && doc.data ? doc.data : {}; } catch(e){ return {}; }
}
async function saveRanges(data) {
    try { await Setting.findOneAndUpdate({ key: 'platforms' }, { data }, { upsert: true }); } catch(e){}
}

async function updateTraffic(plat, country) {
    try {
        const trafficKey = `${getPlatIcon(plat)} ${plat.toUpperCase()} - ${country.split(' ')[0]}`;
        const updateStr = `data.${trafficKey}`;
        await Setting.findOneAndUpdate({ key: 'traffic' }, { $inc: { [updateStr]: 1 } }, { upsert: true });
    } catch(e){}
}
async function getTraffic() {
    try { const doc = await Setting.findOne({ key: 'traffic' }); return doc && doc.data ? doc.data : {}; } catch(e){ return {}; }
}
async function get2FA(chatId) {
    try { const u = await User.findOne({ id: String(chatId) }); return u && u.two_fa ? u.two_fa : []; } catch(e){ return []; }
}
async function save2FA(chatId, two_fa_list) {
    try { await User.findOneAndUpdate({ id: String(chatId) }, { two_fa: two_fa_list }); } catch(e){}
}

function getPlatIcon(plat) {
    let p = plat.toLowerCase();
    if(p.includes('insta')) return '📷';
    if(p.includes('face')) return '🔵';
    if(p.includes('whats')) return '🟢';
    if(p.includes('tele')) return '✈️';
    if(p.includes('goog')) return '🔴';
    return '💬';
}

function getCountryByCode(range) {
    if (!range) return "Global";
    const cleanRange = String(range).replace('+', '');
    const codeMap = {
        '224': '🇬🇳 Guinea', '229': '🇧🇯 Benin', '225': '🇨🇮 Ivory Coast', '234': '🇳🇬 Nigeria',
        '237': '🇨🇲 Cameroon', '221': '🇸🇳 Senegal', '228': '🇹🇬 Togo', '223': '🇲🇱 Mali',
        '226': '🇧🇫 Burkina Faso', '243': '🇨🇩 DR Congo', '242': '🇨🇬 Congo', '227': '🇳🇪 Niger',
        '212': '🇲🇦 Morocco', '254': '🇰🇪 Kenya', '233': '🇬🇭 Ghana', '20':  '🇪🇬 Egypt',
        '27':  '🇿🇦 South Africa', '880': '🇧🇩 Bangladesh', '91':  '🇮🇳 India', '92':  '🇵🇰 Pakistan',
        '44':  '🇬🇧 UK', '1':   '🇺🇸 USA/Canada'
    };
    const prefixes = Object.keys(codeMap).sort((a, b) => b.length - a.length);
    for (let p of prefixes) {
        if (cleanRange.startsWith(p)) return codeMap[p];
    }
    return "Global";
}

function getMainMenu(chatId) {
    let kb = [
        [{ text: "📱 GET NUMBER", style: "success" }],
        [{ text: "📡 LIVE RANGE", style: "primary" }, { text: "📊 TRAFFIC", style: "primary" }],
        [{ text: "🏆 Top Users", style: "primary" }, { text: "🎁 Referrals", style: "primary" }],
        [{ text: "🔐 2FA AUTHENTICATOR", style: "danger" }, { text: "👤 ACCOUNT", style: "primary" }],
        [{ text: "🎧 SUPPORT", style: "primary" }]
    ];
    if (chatId === ADMIN_ID) kb.push([{ text: "🛠️ ADMIN PANEL", style: "danger" }]);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

function getAdminMenu() {
    return {
        inline_keyboard: [
            [{ text: "🌐 Manage Sites", callback_data: "adm_sites", style: "primary" }, { text: "⚙️ Manage Ranges", callback_data: "adm_ranges", style: "primary" }],
            [{ text: "📊 Dashboard", callback_data: "adm_dash", style: "primary" }, { text: "📢 Broadcast", callback_data: "adm_broadcast", style: "primary" }],
            [{ text: "👥 Manage Users", callback_data: "adm_users", style: "primary" }, { text: "💳 Payment Settings", callback_data: "adm_paycfg", style: "success" }],
            [{ text: "⚙️ Bot Settings (ON/OFF)", callback_data: "adm_bot_settings", style: "danger" }, { text: "🔑 Manage API Keys", callback_data: "adm_apikey", style: "danger" }]
        ]
    };
}

function extractOTP(msg) {
    if (!msg) return "Code Not Found";
    msg = String(msg).trim();
    if (/^\d{4,8}$/.test(msg)) return msg; 
    const match = msg.match(/(?:\d[\s-]*){4,8}/);
    if (match && match[0]) {
        let digits = match[0].replace(/\D/g, ''); 
        if (digits.length >= 4 && digits.length <= 8) return digits;
    }
    return msg; 
}

function detectLang(text) {
    if (!text) return 'English';
    if (/[\u0980-\u09FF]/.test(text)) return 'Bengali';
    if (/[\u0400-\u04FF]/.test(text)) return 'Russian';
    if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
    return 'English';
}

async function isUserSubscribed(chatId) {
    if (chatId === ADMIN_ID) return true;
    const channels = ['@developer_walid', '@fireotp_method', OTP_GROUP_ID];
    for (let ch of channels) {
        try {
            const member = await bot.getChatMember(ch, chatId);
            if (member.status === 'left' || member.status === 'kicked') return false;
        } catch (e) { return false; }
    }
    return true;
}

async function checkForceSub(chatId) {
    if (chatId === ADMIN_ID) return true;
    const channels = ['@developer_walid', '@fireotp_method', OTP_GROUP_ID];
    let isSubscribed = true;
    let buttons = [];

    for (let ch of channels) {
        try {
            const member = await bot.getChatMember(ch, chatId);
            if (member.status === 'left' || member.status === 'kicked') {
                isSubscribed = false;
                buttons.push([{ text: `📢 Join Channel`, url: `https://t.me/${ch.replace('@', '')}`, style: "danger" }]);
            }
        } catch (e) {
            isSubscribed = false;
            buttons.push([{ text: `📢 Join Channel`, url: `https://t.me/${ch.replace('@', '')}`, style: "danger" }]);
        }
    }

    if (!isSubscribed) {
        buttons.push([{ text: "✅ Joined (Check Again)", callback_data: "check_joined", style: "success" }]);
        bot.sendMessage(chatId, "⚠️ *বট ব্যবহার করতে নিচের চ্যানেলগুলোতে জয়েন করুন:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        return false;
    }
    return true;
}

// 🟢 Fast Number Generation
async function generateNewNumber(chatId, plat, country, panelNameInput = null, rangeValInput = null, msgIdToEdit = null) {
    const config = await getAppConfig();
    const ranges = await loadRanges(); 
    let rangeVal = rangeValInput;
    let panelName = panelNameInput;

    if (!rangeValInput || !panelNameInput) {
        const rangeData = ranges[plat]?.[country];
        if (!rangeData) {
            const errTxt = "❌ *Number Not Found!*\n\n_দুঃখিত, এই মুহূর্তে এই রেঞ্জে কোনো নাম্বার স্টকে নেই। দয়া করে অন্য রেঞ্জ ট্রাই করুন অথবা কিছুক্ষণ পর আবার চেষ্টা করুন।_";
            if (msgIdToEdit) bot.editMessageText(errTxt, {chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown'}).catch(()=>{});
            else bot.sendMessage(chatId, errTxt, {parse_mode: 'Markdown'});
            return;
        }
        rangeVal = typeof rangeData === 'string' ? rangeData : rangeData.range;
        panelName = typeof rangeData === 'string' ? 'stexsms' : (rangeData.panel || 'stexsms');
    }

    if (panelName === 'stexsms' && !config.stexsms_on) {
        const errTxt = "❌ *সার্ভার আপডেট চলছে।*"; 
        if (msgIdToEdit) bot.editMessageText(errTxt, {chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown'}).catch(()=>{});
        else bot.sendMessage(chatId, errTxt, {parse_mode: 'Markdown'});
        return;
    }
    if (panelName === 'voltxsms' && !config.voltxsms_on) {
        const errTxt = "❌ *সার্ভার আপডেট চলছে।*"; 
        if (msgIdToEdit) bot.editMessageText(errTxt, {chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown'}).catch(()=>{});
        else bot.sendMessage(chatId, errTxt, {parse_mode: 'Markdown'});
        return;
    }
    
    let cleanRange = rangeVal.trim();
    if (cleanRange.toUpperCase().includes('XXX')) {
        cleanRange = cleanRange.replace(/XXX/ig, ''); 
    }

    try {
        const res = await panelRequest('post', '/getnum', { rid: cleanRange }, panelName);
        
        if (res.data && res.data.meta && res.data.meta.status === 'ok') {
            const fullPhone = res.data.data.full_number;
            const strippedPhone = fullPhone.replace('+', ''); 
            
            let sentMsg;
            const boxNumber = `╔════════════════════╗\n║ 📱 \`Wait for auto OTP...\`\n╚════════════════════╝`;
            const platDisplay = `${getPlatIcon(plat)} ${plat.charAt(0).toUpperCase() + plat.slice(1)}`;
            
            const text = `📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${country}\n\n${boxNumber}`;
            
            const actionMarkup = { 
                inline_keyboard: [
                    [{ text: `📱 ${fullPhone}`, copy_text: { text: fullPhone }, style: "primary" }],
                    [{ text: "🔁 Change Number", callback_data: `change_${strippedPhone}`, style: "danger" }]
                ] 
            };

            if (msgIdToEdit) {
                await bot.editMessageText(text, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown', reply_markup: actionMarkup }).catch(()=>{});
                sentMsg = { message_id: msgIdToEdit };
            } else {
                sentMsg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: actionMarkup });
            }

            activeNumbers.set(strippedPhone, {
                chatId: chatId,
                plat: plat,
                country: country,
                panel: panelName,
                range: cleanRange,
                createdAt: Date.now(),
                msgId: sentMsg.message_id
            });

            updateUserStat(chatId, 'number');
            updateGlobalStats('pending');
            
        } else {
            let outTxt = "❌ *Number Not Found!*\n\n_দুঃখিত, এই মুহূর্তে এই রেঞ্জে কোনো নাম্বার স্টকে নেই। দয়া করে অন্য রেঞ্জ ট্রাই করুন অথবা কিছুক্ষণ পর আবার চেষ্টা করুন।_";
            if (msgIdToEdit) bot.editMessageText(outTxt, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown' }).catch(()=>{});
            else bot.sendMessage(chatId, outTxt, { parse_mode: 'Markdown' });
        }
    } catch (error) { 
        let errTxt = "⚠️ *সার্ভার সাময়িক ব্যস্ত আছে। একটু পর আবার চেষ্টা করুন।*";
        if (msgIdToEdit) bot.editMessageText(errTxt, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown' }).catch(()=>{}); 
        else bot.sendMessage(chatId, errTxt, { parse_mode: 'Markdown' });
    }
}

// ==========================================
// 🔄 BACKGROUND TASKS (1 SECOND POLLING)
// ==========================================

let isPollingOTP = false;
setInterval(async () => {
    if (activeNumbers.size === 0 || isPollingOTP) return;
    isPollingOTP = true;
    const config = await getAppConfig();
    
    for (const pName of ['stexsms', 'voltxsms']) {
        if (pName === 'stexsms' && !config.stexsms_on) continue;
        if (pName === 'voltxsms' && !config.voltxsms_on) continue;
        if (!panelKeys[pName]) continue;
        
        try {
            const res = await panelRequest('get', '/success-otp', null, pName);
            if (res.data && res.data.meta && res.data.meta.status === 'ok') {
                const otps = res.data.data.otps || [];
                
                for (let otpData of otps) {
                    const otpId = String(otpData.otp_id);
                    const number = otpData.number;
                    
                    if (deliveredOtps.has(otpId)) continue;
                    
                    if (activeNumbers.has(number)) {
                        const session = activeNumbers.get(number);
                        deliveredOtps.add(otpId);
                        
                        userLastSession.set(session.chatId, { plat: session.plat, country: session.country, panel: session.panel, range: session.range });

                        const otpCode = extractOTP(otpData.message);
                        const detectedLang = detectLang(otpData.message);
                        
                        let earningText = "";

                        if (config.reward_system !== false) {
                            let earnedAmount = config.per_otp_rate || 0;
                            await Earning.create({ num_id: otpId, user_id: String(session.chatId), date: getBusinessDate() });
                            
                            const uDoc = await User.findOne({ id: String(session.chatId) });
                            if(uDoc) {
                                uDoc.balance = parseFloat((uDoc.balance + earnedAmount).toFixed(2));
                                uDoc.today_balance = parseFloat((uDoc.today_balance + earnedAmount).toFixed(2));
                                uDoc.total_otps += 1;
                                uDoc.today_otps += 1;
                                
                                // 🟢 Give Referral Commission
                                const refComm = config.ref_otp_commission || 0.5;
                                if (uDoc.referred_by && refComm > 0) {
                                    const refUser = await User.findOne({ id: uDoc.referred_by });
                                    if (refUser) {
                                        refUser.balance = parseFloat((refUser.balance + refComm).toFixed(2));
                                        refUser.today_balance = parseFloat((refUser.today_balance + refComm).toFixed(2));
                                        refUser.referral_earnings = parseFloat(((refUser.referral_earnings || 0) + refComm).toFixed(2));
                                        await refUser.save();
                                    }
                                }

                                await uDoc.save();
                                earningText = `\n\n🎉 *Congratulations! Boss*\n💰 *Earned:* \`${parseFloat(earnedAmount.toFixed(2))}\` ৳\n💳 *Total Balance:* \`${parseFloat(uDoc.balance.toFixed(2))}\` ৳`;
                            }
                        } else {
                            const uDoc = await User.findOne({ id: String(session.chatId) });
                            if(uDoc) {
                                uDoc.total_otps += 1;
                                uDoc.today_otps += 1;
                                await uDoc.save();
                            }
                        }

                        updateGlobalStats('success');
                        updateTraffic(session.plat, session.country);
                        
                        const safePhoneText = `📱 +${number}`;
                        bot.editMessageReplyMarkup({ 
                            inline_keyboard: [[{ text: safePhoneText, copy_text: { text: `+${number}` }, style: "primary" }]] 
                        }, { chat_id: session.chatId, message_id: session.msgId }).catch(()=>{});

                        const formatPhone = '+' + number;
                        const platDisplay = `${getPlatIcon(session.plat)} ${session.plat.charAt(0).toUpperCase() + session.plat.slice(1)}`;
                        const boxNumber = `╔════════════════════╗\n║ 📱 \`${formatPhone}\` ║ LN- ${detectedLang}\n╚════════════════════╝`;
                        
                        const safeSid = (session.plat || 'App').replace(/[^a-zA-Z0-9]/g, '');
                        const deepLinkUrl = `https://t.me/${botUsername}?start=gn_${pName}_${session.range}_${safeSid}`;

                        const otpMarkup = { 
                            inline_keyboard: [
                                [{ text: ` ${otpCode}`, copy_text: { text: otpCode }, style: "success" }],
                                [
                                    { text: "🔄 Get New Number", callback_data: "get_new_num", style: "success" },
                                    { text: "💬 OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}`, style: "primary" }
                                ]
                            ] 
                        };
                        
                        bot.sendMessage(session.chatId, `🎉 *New OTP Received* 🎉\n\n📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${session.country}\n\n${boxNumber}${earningText}`, { parse_mode: 'Markdown', reply_markup: otpMarkup }).catch(()=>{});
                        
                        if (!config.global_feed_on) {
                            const groupMsg = `🎉 *New OTP Received* 🎉\n\n📱 *Platform:* ${session.plat}\n🌍 *Country:* ${session.country}\n🎯 *Number:* \`${session.range}\`\n\n💬 *SMS:* \`${otpData.message}\``;
                            const groupMarkup = { 
                                inline_keyboard: [
                                    [{ text: `  ${otpCode}`, copy_text: { text: otpCode }, style: "success" }],
                                    [{ text: "🚀 Get Number From This Range", url: deepLinkUrl, style: "primary" }]
                                ] 
                            };
                            bot.sendMessage(OTP_GROUP_ID, groupMsg, {parse_mode: 'Markdown', reply_markup: groupMarkup}).catch(()=>{});
                        }

                        activeNumbers.delete(number);
                    }
                }
            }
        } catch(e) { }
    }
    isPollingOTP = false;
}, 1000); 

let isPollingFeed = false;
setInterval(async () => {
    if (isPollingFeed) return;
    isPollingFeed = true;
    
    const config = await getAppConfig();
    
    if (!config.global_feed_on) {
        isPollingFeed = false;
        return;
    }

    const rangesDb = await loadRanges();

    for (const pName of ['stexsms', 'voltxsms']) {
        if (pName === 'stexsms' && !config.stexsms_on) continue;
        if (pName === 'voltxsms' && !config.voltxsms_on) continue;
        if (!panelKeys[pName]) continue;
        
        try {
            const res = await panelRequest('get', '/console', null, pName);
            if (res.data && res.data.meta && res.data.meta.status === 'ok') {
                const hits = res.data.data.hits || [];
                
                for(let hit of hits.reverse()) {
                    const uniqueId = `${pName}_${hit.time}_${hit.range}_${hit.message.substring(0,5)}`;
                    
                    if(!seenConsoleHits.has(uniqueId)) {
                        seenConsoleHits.add(uniqueId);
                        
                        if(seenConsoleHits.size > 1500) { 
                            const firstItem = seenConsoleHits.values().next().value;
                            seenConsoleHits.delete(firstItem);
                        }
                        
                        const otpCode = extractOTP(hit.message);
                        
                        let consoleCountry = getCountryByCode(hit.range);
                        for (const [plat, countries] of Object.entries(rangesDb)) {
                            for (const [cName, data] of Object.entries(countries)) {
                                let rVal = typeof data === 'string' ? data : data.range;
                                if (rVal === hit.range || rVal.replace(/XXX/ig, '') === hit.range.replace(/XXX/ig, '')) {
                                    consoleCountry = cName;
                                }
                            }
                        }

                        let displaySid = hit.sid || 'Unknown';
                        const lowerMsg = hit.message.toLowerCase();
                        if (lowerMsg.includes('instagram') || lowerMsg.includes('ig code')) displaySid = 'Instagram';
                        else if (lowerMsg.includes('facebook') || lowerMsg.includes('fb')) displaySid = 'Facebook';
                        else if (lowerMsg.includes('whatsapp') || lowerMsg.includes('wa')) displaySid = 'WhatsApp';
                        else if (lowerMsg.includes('telegram') || lowerMsg.includes('tg')) displaySid = 'Telegram';
                        else if (lowerMsg.includes('google') || lowerMsg.includes('gmail') || lowerMsg.includes('g-')) displaySid = 'Google';
                        else if (lowerMsg.includes('tiktok')) displaySid = 'TikTok';

                        const safeSid = displaySid.replace(/[^a-zA-Z0-9]/g, '');
                        const deepLinkUrl = `https://t.me/${botUsername}?start=gn_${pName}_${hit.range}_${safeSid}`;

                        const msg = `🎉 *New OTP Received* 🎉\n\n📱 *Platform:* ${displaySid}\n🌍 *Country:* ${consoleCountry}\n🎯 *Number:* \`${hit.range}\`\n\n💬 *SMS:* \`${hit.message}\``;
                        const markup = { 
                            inline_keyboard: [
                                [{ text: `  ${otpCode}`, copy_text: { text: otpCode }, style: "success" }],
                                [{ text: "🚀 Get Number From This Range", url: deepLinkUrl, style: "primary" }] 
                            ] 
                        };
                        
                        bot.sendMessage(OTP_GROUP_ID, msg, {parse_mode: 'Markdown', reply_markup: markup}).catch(()=>{});
                    }
                }
            }
        } catch(e) {}
    }
    isPollingFeed = false;
}, 6000);

// 🟢 NEW: 6 AM Daily Reset for Top 3 Bonus
setInterval(async () => {
    const now = new Date();
    const bdTimeMs = now.getTime() + (now.getTimezoneOffset() * 60000) + (6 * 3600000);
    const bdTime = new Date(bdTimeMs);
    
    // Check if it's exactly 6 AM (allow a small window within the minute)
    if (bdTime.getHours() === 6 && bdTime.getMinutes() === 0) {
        if (!global.dailyResetDone || global.dailyResetDone !== bdTime.getDate()) {
            global.dailyResetDone = bdTime.getDate();
            
            try {
                const config = await getAppConfig();
                // 🟢 Top 3 Condition: >= 50 OTPs today AND >= 3 Referrals total
                const topUsers = await User.find({ today_otps: { $gte: 50 }, referral_count: { $gte: 3 } }).sort({ today_otps: -1 }).limit(3);
                
                let broadcastTxt = "🏆 *TODAY'S TOP WINNERS* 🏆\n\n";
                let hasWinners = false;
                const bonuses = [config.bonus_top1 || 50, config.bonus_top2 || 30, config.bonus_top3 || 20];
                const medals = ["🥇", "🥈", "🥉"];
                
                for (let i = 0; i < topUsers.length; i++) {
                    hasWinners = true;
                    const u = topUsers[i];
                    const bonus = bonuses[i];
                    u.balance += bonus;
                    await u.save();
                    
                    let maskedId = String(u.id).substring(0, 4) + "****";
                    broadcastTxt += `${medals[i]} *Top ${i+1}:* ${u.first_name} (ID: \`${maskedId}\`)\n🎁 *Bonus:* \`${bonus}\` ৳ | *OTPs:* ${u.today_otps}\n\n`;
                    
                    bot.sendMessage(u.id, `🎉 *CONGRATULATIONS!* 🎉\n\nআপনি আজকের Top ${i+1} ইউজার হয়েছেন!\n🎁 *Bonus:* \`${bonus}\` ৳ আপনার একাউন্টে যোগ করা হয়েছে!`, { parse_mode: 'Markdown' }).catch(()=>{});
                }
                
                if (hasWinners) {
                    bot.sendMessage("@taskesy_news", broadcastTxt, { parse_mode: 'Markdown' }).catch(()=>{});
                }
                
                // Reset daily stats for everyone
                await User.updateMany({}, { $set: { today_otps: 0, today_balance: 0, last_active_date: getBusinessDate() } });
            } catch (e) { console.log("Reset Error:", e); }
        }
    }
}, 30000); 

// --- Commands & Messages ---
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param = match[1] ? match[1].trim() : '';
    
    // Deep Link Logic
    if (param.startsWith('gn_')) {
        const u = await ensureUser(msg.from);
        if (u && u.banned) return bot.sendMessage(chatId, "🚫 *You are banned.*", { parse_mode: 'Markdown' });
        if (!(await checkForceSub(chatId))) return;

        const parts = param.split('_');
        if(parts.length >= 4) {
           const pName = parts[1];
           const reqRange = parts[2];
           const platName = parts.slice(3).join(' ');
           
           let foundCountry = getCountryByCode(reqRange);
           const ranges = await loadRanges();
           for (const [p, countries] of Object.entries(ranges)) {
               for (const [c, data] of Object.entries(countries)) {
                   let r = typeof data === 'string' ? data : data.range;
                   if (r === reqRange || r.replace(/XXX/ig, '') === reqRange.replace(/XXX/ig, '')) {
                       foundCountry = c;
                   }
               }
           }
           
           bot.sendMessage(chatId, "🚀 *Generating requested number...*", {parse_mode: 'Markdown'}).then(sentMsg => {
               generateNewNumber(chatId, platName, foundCountry, pName, reqRange, sentMsg.message_id);
           });
           return;
        }
    }

    // 🟢 Normal Start & Referral Setup
    let u = await User.findOne({ id: String(chatId) });
    if (!u) {
        u = new User({ 
            id: String(chatId), 
            first_name: msg.from.first_name || 'User', 
            username: msg.from.username || 'N/A', 
            joined: new Date().toISOString(), 
            last_active_date: getBusinessDate() 
        });
        
        // Setup Referral if param exists and isn't user's own ID
        if (param && param !== String(chatId) && !param.startsWith('gn_')) {
            const referrer = await User.findOne({ id: param });
            if (referrer) {
                u.referred_by = referrer.id;
                referrer.referral_count = (referrer.referral_count || 0) + 1;
                await referrer.save();
                bot.sendMessage(referrer.id, `🎉 *New Referral Joined!*\n👤 Name: ${u.first_name}\n_You will earn commission per OTP they receive!_`, { parse_mode: 'Markdown' }).catch(()=>{});
            }
        }
        await u.save();
    } else {
        const today = getBusinessDate();
        if (u.last_active_date !== today) { 
            u.today_otps = 0; 
            u.today_balance = 0; 
            u.last_active_date = today; 
            await u.save(); 
        }
    }

    if (u.banned) return bot.sendMessage(chatId, "🚫 *You are banned.*", { parse_mode: 'Markdown' });
    if (!(await checkForceSub(chatId))) return;

    const welcomeMsg = ` 💐*WELCOME TO FIRE OTP BOT*\n\n👋 Hello, *${msg.from.first_name}*!\n\n🚀 _Get unlimited virtual numbers and instant OTPs for any platform in seconds._\n\n👇 Please choose an option from the menu below:`;
    bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(chatId) });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    if (text.startsWith('/')) return;

    const config = await getAppConfig();
    let checkU = await User.findOne({ id: String(chatId) });
    
    if (config.force_start && !checkU && text !== '/start') {
        return bot.sendMessage(chatId, "⚠️ *বটটি ব্যবহার করতে প্রথমে /start বাটনে ক্লিক করুন!*", { parse_mode: 'Markdown' });
    }

    const u = await ensureUser(msg.from);
    if (u && u.banned) return bot.sendMessage(chatId, "🚫 *You are banned.*", { parse_mode: 'Markdown' });

    const menuButtons = ["📱 GET NUMBER", "📡 LIVE RANGE", "📊 TRAFFIC", "🔐 2FA AUTHENTICATOR", "👤 ACCOUNT", "🎧 SUPPORT", "🛠️ ADMIN PANEL", "🏆 Top Users", "🎁 Referrals"];
    if (menuButtons.some(btn => text.includes(btn))) {
        if(adminState[chatId]) delete adminState[chatId];
        if(userState[chatId]) delete userState[chatId];
    }
    
    // --- USER STATE MACHINE ---
    if (userState[chatId]) {
        const state = userState[chatId];
        if (state.action === 'wait_2fa_secret') {
            const secret = text.trim().replace(/\s+/g, '').toUpperCase();
            try {
                authenticator.generate(secret); 
                const saved2fa = await get2FA(chatId);
                saved2fa.push({ secret: secret, added: new Date().toISOString() });
                await save2FA(chatId, saved2fa);
                bot.sendMessage(chatId, `✅ *2FA Secret সফলভাবে সেভ হয়েছে!*`, { parse_mode: 'Markdown' });
            } catch (e) { 
                bot.sendMessage(chatId, `❌ *ভুল বা ইনভ্যালিড 2FA সিক্রেট কোড!*`, { parse_mode: 'Markdown' }); 
            }
            delete userState[chatId]; return;
        }
        else if (state.action === 'wait_wd_id') {
            state.account_id = text.trim();
            state.action = 'wait_wd_amount';
            bot.sendMessage(chatId, `✅ *Method:* ${state.method}\n✅ *Account/ID:* \`${state.account_id}\`\n\n💰 *এবার কত টাকা উইথড্র করতে চান তা লিখুন:*`, { parse_mode: 'Markdown' });
            return;
        }
        else if (state.action === 'wait_wd_amount') {
            const amount = parseFloat(text.trim());
            if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "❌ *Please enter a valid amount.*", { parse_mode: 'Markdown' });
            
            try {
                const config = await getAppConfig();
                const userDoc = await User.findOne({ id: String(chatId) });
                
                if (amount < config.min_withdraw) return bot.sendMessage(chatId, `⚠️ *Minimum Withdraw is ${config.min_withdraw} ৳*`, { parse_mode: 'Markdown' });
                if (amount > userDoc.balance) return bot.sendMessage(chatId, "❌ *Insufficient Balance!*", { parse_mode: 'Markdown' });

                userDoc.balance = parseFloat((userDoc.balance - amount).toFixed(2));
                await userDoc.save();

                const wd_id = Math.random().toString(36).substring(2, 10).toUpperCase();
                await Withdraw.create({ wd_id: wd_id, user_id: String(chatId), amount: amount, method: state.method, account: state.account_id, date: getLocDate() });

                bot.sendMessage(chatId, `✅ *Withdraw Request Submitted!*\n\n💰 *Amount:* \`${amount}\` ৳\n💳 *Method:* ${state.method}\n\n_Please wait for admin approval._`, { parse_mode: 'Markdown' });

                const wdGroupMsg = `🔔 *NEW WITHDRAW REQUEST*\n\n👤 *User ID:* \`${chatId}\`\n💳 *Method:* ${state.method}\n🏦 *Account/ID:* \`${state.account_id}\`\n💰 *Amount:* \`${amount}\` ৳\n\n_Select an action below:_`;
                const wdMarkup = { inline_keyboard: [[ { text: "✅ Approve", callback_data: `wd_appr_${wd_id}`, style: "success" }, { text: "❌ Cancel", callback_data: `wd_canc_${wd_id}`, style: "danger" } ]]};
                bot.sendMessage(PAYMENT_GROUP_ID, wdGroupMsg, { parse_mode: 'Markdown', reply_markup: wdMarkup }).catch(()=>{});
            } catch (e) { bot.sendMessage(chatId, "❌ Error processing request."); }
            delete userState[chatId]; return;
        }
    }

    // --- ADMIN STATE MACHINE ---
    if (adminState[chatId]) {
        const state = adminState[chatId];

        if (state.action === 'wait_site_add') {
            const ranges = await loadRanges();
            if (!ranges[text]) ranges[text] = {};
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ সাইট *${getPlatIcon(text)} ${text}* যুক্ত হয়েছে!`, { parse_mode: 'Markdown' });
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_country_name') {
            state.country = text;
            bot.sendMessage(chatId, `✅ Country: ${text}\n\n📌 এবার কোন প্যানেল থেকে রেঞ্জ অ্যাড করবেন তা সিলেক্ট করুন:`, {
                reply_markup: { inline_keyboard: [
                    [{ text: "⚙️ Stexsms", callback_data: "setpan_stexsms" }, { text: "⚙️ Voltxsms", callback_data: "setpan_voltxsms" }]
                ]}
            });
            return; 
        }
        else if (state.action === 'wait_range_val') {
            const ranges = await loadRanges();
            if (!ranges[state.platform]) ranges[state.platform] = {};
            ranges[state.platform][state.country] = { range: text, panel: state.panel };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ *${state.platform}* এর জন্য রেঞ্জ সেভ হয়েছে! (Panel: ${state.panel})`, { parse_mode: 'Markdown' });
            
            const platDisplay = `${getPlatIcon(state.platform)} ${state.platform.charAt(0).toUpperCase() + state.platform.slice(1)}`;
            const broadcastMsg = `📢 *NEW NUMBER ADDED!* 🔥\n\n📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${state.country}\n\n🚀 _এখনই /start দিয়ে Number নিয়ে কাজ শুরু করুন!_`;
            try {
                const users = await User.find({});
                users.forEach(usr => bot.sendMessage(usr.id, broadcastMsg, { parse_mode: 'Markdown' }).catch(()=>{}));
            } catch (e) {}

            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_range_edit') {
            const ranges = await loadRanges();
            ranges[state.platform][state.country] = { range: text, panel: state.panel };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ Range updated successfully! (Panel: ${state.panel})`);
            
            const platDisplay = `${getPlatIcon(state.platform)} ${state.platform.charAt(0).toUpperCase() + state.platform.slice(1)}`;
            const broadcastMsg = `📢 *NEW NUMBER UPDATED!* 🔥\n\n📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${state.country}\n\n🚀 _এখনই /start দিয়ে Number নিয়ে কাজ শুরু করুন!_`;
            try {
                const users = await User.find({});
                users.forEach(usr => bot.sendMessage(usr.id, broadcastMsg, { parse_mode: 'Markdown' }).catch(()=>{}));
            } catch (e) {}

            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_apikey_add') {
            const newKey = text.trim();
            try {
                await savePanelKey(state.panel, newKey);
                bot.sendMessage(chatId, `✅ *${state.panel.toUpperCase()} API Key saved successfully!*`, { parse_mode: 'Markdown' });
            } catch (e) {} delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_broadcast_notice') {
            bot.sendMessage(chatId, "✅ *Broadcasting...*", { parse_mode: 'Markdown' });
            try {
                const users = await User.find({});
                users.forEach(usr => bot.sendMessage(usr.id, `📢 *Notice from Admin:*\n\n${text}`, { parse_mode: 'Markdown' }).catch(()=>{}));
            } catch (e) {} delete adminState[chatId]; return;
        }
        
        // 🟢 Reward/Bonus Editor States
        else if (state.action === 'wait_otp_rate') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) {
                const config = await getAppConfig(); config.per_otp_rate = val; await saveAppConfig(config);
                bot.sendMessage(chatId, `✅ *OTP Rate updated to ${val} ৳*`, { parse_mode: 'Markdown' });
            } else bot.sendMessage(chatId, "❌ Invalid amount");
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_ref_com') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) {
                const config = await getAppConfig(); config.ref_otp_commission = val; await saveAppConfig(config);
                bot.sendMessage(chatId, `✅ *Ref Commission updated to ${val} ৳*`, { parse_mode: 'Markdown' });
            } else bot.sendMessage(chatId, "❌ Invalid amount");
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_t1') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) {
                const config = await getAppConfig(); config.bonus_top1 = val; await saveAppConfig(config);
                bot.sendMessage(chatId, `✅ *Top 1 Bonus updated to ${val} ৳*`, { parse_mode: 'Markdown' });
            } else bot.sendMessage(chatId, "❌ Invalid amount");
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_t2') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) {
                const config = await getAppConfig(); config.bonus_top2 = val; await saveAppConfig(config);
                bot.sendMessage(chatId, `✅ *Top 2 Bonus updated to ${val} ৳*`, { parse_mode: 'Markdown' });
            } else bot.sendMessage(chatId, "❌ Invalid amount");
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_t3') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) {
                const config = await getAppConfig(); config.bonus_top3 = val; await saveAppConfig(config);
                bot.sendMessage(chatId, `✅ *Top 3 Bonus updated to ${val} ৳*`, { parse_mode: 'Markdown' });
            } else bot.sendMessage(chatId, "❌ Invalid amount");
            delete adminState[chatId]; return;
        }

        else if (state.action === 'wait_min_wd') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val > 0) {
                const config = await getAppConfig(); config.min_withdraw = val; await saveAppConfig(config);
                bot.sendMessage(chatId, `✅ *Min Withdraw updated to ${val} ৳*`, { parse_mode: 'Markdown' });
            } else bot.sendMessage(chatId, "❌ Invalid amount");
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_pay_method_add') {
            const m = text.trim();
            if(m) {
                const config = await getAppConfig(); 
                if(!config.pay_methods.includes(m)) { config.pay_methods.push(m); await saveAppConfig(config); }
                bot.sendMessage(chatId, `✅ *Payment Method '${m}' added!*`, { parse_mode: 'Markdown' });
            }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_manage_userid') {
            const uid = text.trim();
            const targetUser = await User.findOne({ id: String(uid) });
            if (!targetUser) { bot.sendMessage(chatId, "❌ *User not found!*", { parse_mode: 'Markdown' }); } 
            else {
                const msgText = `👤 *USER DETAILS*\n\nID: \`${targetUser.id}\`\nName: ${targetUser.first_name}\nUsername: ${targetUser.username}\n\n💰 *Total Bal:* \`${parseFloat(targetUser.balance.toFixed(2))}\` ৳\n\n📊 *Total OTPs:* \`${targetUser.total_otps}\`\n🚫 *Status:* ${targetUser.banned ? 'BANNED' : 'ACTIVE'}`;
                const markup = { inline_keyboard: [[{ text: targetUser.banned ? "✅ Unban User" : "🚫 Ban User", callback_data: `adm_togban_${targetUser.id}`, style: targetUser.banned ? "success" : "danger" }]]};
                bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: markup });
            }
            delete adminState[chatId]; return;
        }
    }

    if (!(await checkForceSub(chatId))) return;

    try {
        if (text === "🛠️ ADMIN PANEL" && chatId === ADMIN_ID) {
            bot.sendMessage(chatId, "🛠 *Admin Control Panel*\n\nSelect an option below:", { parse_mode: 'Markdown', reply_markup: getAdminMenu() });
        }
        else if (text === "📱 GET NUMBER") {
            const ranges = await loadRanges();
            let inlineKeyboard = []; let row = [];
            for (const [plat, countries] of Object.entries(ranges)) {
                if (Object.keys(countries).length > 0) {
                    row.push({ text: `${getPlatIcon(plat)} ${plat.toUpperCase()}`, callback_data: `u_site_${plat}`, style: "primary" });
                    if (row.length === 2) { inlineKeyboard.push(row); row = []; }
                }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            if (inlineKeyboard.length === 0) return bot.sendMessage(chatId, "⚠️ *কোনো সাইট বা নাম্বার স্টকে নেই।*", { parse_mode: 'Markdown' });
            bot.sendMessage(chatId, "📌 *Select a Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (text === "📡 LIVE RANGE") {
            bot.sendMessage(chatId, "📡 *Click below to check Live Ranges & Realtime Global OTP feed:*", { 
                parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: [[{ text: "🔥 Go To Live OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}` }]] } 
            });
        }
        else if (text === "📊 TRAFFIC") {
            const traffic = await getTraffic();
            if (Object.keys(traffic).length === 0) return bot.sendMessage(chatId, "⚠️ *এখনও কোনো ট্রাফিক ডাটা নেই।*", { parse_mode: 'Markdown' });
            let sorted = Object.entries(traffic).sort((a, b) => b[1] - a[1]);
            let msgText = "📊 *BOT OTP TRAFFIC*\n\n";
            sorted.forEach(([key, count], index) => { msgText += `*${index + 1}.* ${key} ➔ \`${count} OTPs\`\n`; });
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
        }
        // 🟢 NEW: Top Users System
        else if (text === "🏆 Top Users") {
            const topUsers = await User.find({ today_otps: { $gt: 0 } }).sort({ today_otps: -1 }).limit(10);
            
            let msgText = "🏆 *TODAY'S TOP 10 USERS* 🏆\n\n";
            if (topUsers.length === 0) {
                msgText += "_No OTPs generated yet today._\n\n";
            } else {
                const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
                topUsers.forEach((u, index) => {
                    let mId = u.id.substring(0, 4) + "****";
                    msgText += `${medals[index] || "🏅"} *${u.first_name}* (ID: ${mId})\n🎯 *OTPs:* \`${u.today_otps}\`\n\n`;
                });
            }
            
            msgText += "⚠️ _লিস্ট প্রতিদিন সকাল ৬ টায় রিসেট হবে।_\n🎉 _Top 3 জনকে প্রতিদিন বোনাস দেওয়া হবে!_";
            
            bot.sendMessage(chatId, msgText, { 
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: "👁️ See Your Position", callback_data: "my_rank", style: "primary" }]] }
            });
        }
        // 🟢 NEW: Referral System Info
        else if (text === "🎁 Referrals") {
            const uData = await ensureUser(msg.from);
            const config = await getAppConfig();
            const refLink = `https://t.me/${botUsername}?start=${uData.id}`;
            
            const msgText = `🎁 *YOUR REFERRAL SYSTEM*\n\n🔗 *Your Referral Link:*\n\`${refLink}\`\n\n👥 *Total Referred:* \`${uData.referral_count || 0}\` Users\n💰 *Total Earnings:* \`${parseFloat((uData.referral_earnings || 0).toFixed(2))}\` ৳\n\n⚡️ _You will get ${config.ref_otp_commission || 0.5} ৳ for EVERY successful OTP your referred user receives!_`;
            
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
        }
        else if (text === "👤 ACCOUNT") {
            const uData = await ensureUser(msg.from);
            const config = await getAppConfig();
            let balText = `💰 *Total Balance:* \`${parseFloat(uData.balance.toFixed(2))}\` ৳\n💸 *Today Earnings:* \`${parseFloat(uData.today_balance.toFixed(2))}\` ৳`;
            if (config.reward_system === false) balText = "";

            const msgText = `👤 *USER ACCOUNT*\n\n🔖 *ID:* \`${uData.id}\`\n👤 *Name:* ${uData.first_name}\n\n${balText}\n\n📊 *Total OTPs:* \`${uData.total_otps}\`\n📈 *Today OTPs:* \`${uData.today_otps}\``;
            
            let markup = { inline_keyboard: [] };
            if (config.reward_system !== false) {
                markup.inline_keyboard.push([{ text: "💵 Withdraw Funds", callback_data: "wd_start", style: "success" }]);
            }
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: markup });
        }
        else if (text === "🔐 2FA AUTHENTICATOR") {
            const saved2fa = await get2FA(chatId);
            let markup = { inline_keyboard: [[{ text: "➕ Add New 2FA Secret", callback_data: "add_2fa", style: "primary" }]] };
            if (saved2fa.length === 0) { 
                bot.sendMessage(chatId, "🔐 *2FA Authenticator*\n\nআপনার কোনো 2FA অ্যাকাউন্ট নেই।", { parse_mode: 'Markdown', reply_markup: markup }); 
            } else { 
                saved2fa.forEach((item, index) => {
                    let shortKey = item.secret.substring(0, 5) + '...';
                    markup.inline_keyboard.unshift([
                        { text: `🔑 Key: ${shortKey}`, callback_data: `get_2fa_${index}`, style: "success" },
                        { text: `🗑️ Delete`, callback_data: `del_2fa_${index}`, style: "danger" }
                    ]);
                });
                bot.sendMessage(chatId, "🔐 *2FA Authenticator*\n\nআপনার সেভ করা 2FA অ্যাকাউন্টগুলো নিচে দেওয়া হলো:", { parse_mode: 'Markdown', reply_markup: markup });
            }
        }
        else if (text === "🎧 SUPPORT") {
            bot.sendMessage(chatId, "🎧 *SUPPORT CENTER*\n\nবট ব্যবহার করতে সমস্যা হলে অ্যাডমিনকে মেসেজ দিন:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "👨‍💻 Contact Admin", url: `tg://user?id=${ADMIN_ID}`, style: "primary" }]] } });
        }
    } catch (e) {
        bot.sendMessage(chatId, "⚠️ *সার্ভার ত্রুটি!*", { parse_mode: 'Markdown' });
    }
});

// --- Callbacks ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data === "check_joined") {
        const subbed = await isUserSubscribed(chatId);
        if (subbed) {
            bot.deleteMessage(chatId, msgId).catch(()=>{});
            const u = await ensureUser(query.from);
            const welcomeMsg = ` 💐*WELCOME TO FIRE OTP BOT*\n\n👋 Hello, *${u.first_name}*!\n\n🚀 _Get unlimited virtual numbers and instant OTPs for any platform in seconds._\n\n👇 Please choose an option from the menu below:`;
            bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(chatId) });
        } else {
            bot.sendMessage(chatId, "⚠️ *আপনি এখনও সবগুলো চ্যানেলে জয়েন করেননি!*", { parse_mode: 'Markdown' });
        }
        bot.answerCallbackQuery(query.id).catch(()=>{});
        return;
    }

    bot.answerCallbackQuery(query.id).catch(()=>{});

    try {
        if (data === "admin_main" && chatId === ADMIN_ID) {
            bot.editMessageText("🛠 *Admin Control Panel*\n\nSelect an option below:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getAdminMenu() }).catch(()=>{});
        }
        
        else if (data === "adm_bot_settings" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            let kb = [
                [{ text: `⚙️ Stexsms: ${config.stexsms_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_stexsms" }],
                [{ text: `⚙️ Voltxsms: ${config.voltxsms_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_voltxsms" }],
                [{ text: `🚀 Force /start: ${config.force_start ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_forcestart" }],
                [{ text: `🌐 Global Live OTP: ${config.global_feed_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_globalfeed" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText("⚙️ *Bot Settings*\n\nপ্যানেল এবং অন্যান্য সেটিংস অন/অফ করুন:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        else if (data.startsWith("tog_") && chatId === ADMIN_ID) {
            const key = data.split('_')[1];
            const config = await getAppConfig();
            if (key === 'stexsms') config.stexsms_on = !config.stexsms_on;
            if (key === 'voltxsms') config.voltxsms_on = !config.voltxsms_on;
            if (key === 'forcestart') config.force_start = !config.force_start;
            if (key === 'globalfeed') config.global_feed_on = !config.global_feed_on;
            await saveAppConfig(config);

            let kb = [
                [{ text: `⚙️ Stexsms: ${config.stexsms_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_stexsms" }],
                [{ text: `⚙️ Voltxsms: ${config.voltxsms_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_voltxsms" }],
                [{ text: `🚀 Force /start: ${config.force_start ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_forcestart" }],
                [{ text: `🌐 Global Live OTP: ${config.global_feed_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_globalfeed" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText("⚙️ *Bot Settings*\n\nপ্যানেল এবং অন্যান্য সেটিংস অন/অফ করুন:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }

        else if (data === "adm_apikey" && chatId === ADMIN_ID) {
            let msgText = `🔑 *Panel API Keys:*\n\n`;
            msgText += `*Stexsms:* \`${panelKeys.stexsms ? panelKeys.stexsms.substring(0, 8) + '...' : 'Not Set'}\`\n`;
            msgText += `*Voltxsms:* \`${panelKeys.voltxsms ? panelKeys.voltxsms.substring(0, 8) + '...' : 'Not Set'}\`\n`;
            
            let inlineKeyboard = [
                [{ text: "✏️ Set Stexsms Key", callback_data: "set_key_stexsms", style: "primary" }, { text: "✏️ Set Voltxsms Key", callback_data: "set_key_voltxsms", style: "primary" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText(msgText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }).catch(()=>{});
        }
        else if (data.startsWith("set_key_") && chatId === ADMIN_ID) {
            const panelName = data.split('_')[2];
            adminState[chatId] = { action: 'wait_apikey_add', panel: panelName };
            bot.sendMessage(chatId, `✏️ *${panelName.toUpperCase()} Panel* এর API Key টি পেস্ট করুন:`, { parse_mode: 'Markdown' });
        }

        else if (data.startsWith('setpan_') && chatId === ADMIN_ID) {
            const panel = data.split('_')[1];
            if (adminState[chatId] && adminState[chatId].country) {
                adminState[chatId].panel = panel;
                adminState[chatId].action = 'wait_range_val';
                bot.editMessageText(`✅ Panel: ${panel.toUpperCase()}\n\n✏️ এবার রেঞ্জ টাইপ করুন (যেমন: 26134 বা 22501XXX):`, {chat_id: chatId, message_id: msgId}).catch(()=>{});
            }
        }
        else if (data.startsWith('edpan_') && chatId === ADMIN_ID) {
            const p = data.split('_')[1];
            if(adminState[chatId] && adminState[chatId].platform) {
                adminState[chatId].panel = p;
                adminState[chatId].action = 'wait_range_edit';
                bot.editMessageText(`✅ Panel: ${p.toUpperCase()}\n\n✏️ এবার নতুন রেঞ্জ টাইপ করুন:`, {chat_id: chatId, message_id: msgId}).catch(()=>{});
            }
        }

        else if (data === "adm_dash" && chatId === ADMIN_ID) {
            const totalUsers = await User.countDocuments();
            const statDoc = await Setting.findOne({ key: 'global_stats' });
            const gStats = statDoc && statDoc.data ? statDoc.data : { success: 0, pending: 0, failed: 0 };
            const dashText = `📊 *BOT DASHBOARD*\n\n👥 *Total Users:* \`${totalUsers}\`\n\n📈 *Order Stats:*\n✅ Success: \`${gStats.success || 0}\`\n⏳ Pending: \`${gStats.pending || 0}\`\n❌ Failed: \`${gStats.failed || 0}\``;
            bot.editMessageText(dashText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]] }}).catch(()=>{});
        }
        else if (data === "adm_broadcast" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_broadcast_notice' };
            bot.sendMessage(chatId, "✏️ *সব ইউজারদের পাঠানোর জন্য মেসেজটি লিখুন:*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_users" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_manage_userid' };
            bot.sendMessage(chatId, "✏️ *Enter User ID to manage:*", { parse_mode: 'Markdown' });
        }
        else if (data.startsWith('adm_togban_') && chatId === ADMIN_ID) {
            const targetId = data.split('_')[2];
            const targetUser = await User.findOne({ id: String(targetId) });
            if (targetUser) {
                targetUser.banned = !targetUser.banned;
                await targetUser.save();
                bot.editMessageText(`✅ *User ${targetUser.banned ? 'BANNED' : 'UNBANNED'} successfully!*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            }
        }
        else if (data === "adm_userlist" && chatId === ADMIN_ID) {
            const users = await User.find({});
            let userList = "👥 *USER LIST*\n\nID | Name | Bal\n-----------------------\n";
            users.forEach(u => { userList += `${u.id} | ${u.first_name || 'N/A'} | ${u.balance || 0}\n`; });
            const buffer = Buffer.from(userList, 'utf-8');
            bot.sendDocument(chatId, buffer, {}, { filename: 'users.txt', contentType: 'text/plain' }).catch(()=>{});
        }
        
        // 🟢 Advanced Payment & Reward Settings Interface
        else if (data === "adm_paycfg" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            let msg = `💳 *Payment & Reward Settings*\n\n💰 *Per OTP Earning:* \`${config.per_otp_rate}\` ৳\n📉 *Min Withdraw:* \`${config.min_withdraw}\` ৳\n👥 *Ref Comm/OTP:* \`${config.ref_otp_commission || 0.5}\` ৳\n🏆 *Top Bonus:* 1st:\`${config.bonus_top1 || 50}\` | 2nd:\`${config.bonus_top2 || 30}\` | 3rd:\`${config.bonus_top3 || 20}\`\n💳 *Methods:* ${config.pay_methods.join(', ') || 'None'}`;
            
            let kb = [
                [{ text: `🎁 Reward System: ${config.reward_system ? "ON 🟢" : "OFF 🔴"}`, callback_data: "adm_tog_reward", style: "primary" }],
                [{ text: "✏️ Edit Earning/OTP", callback_data: "adm_edit_otprate" }, { text: "✏️ Ref Comm/OTP", callback_data: "adm_edit_refcom" }],
                [{ text: "🥇 Top 1", callback_data: "adm_t1" }, { text: "🥈 Top 2", callback_data: "adm_t2" }, { text: "🥉 Top 3", callback_data: "adm_t3" }],
                [{ text: "✏️ Edit Min Withdraw", callback_data: "adm_edit_minwd" }],
                [{ text: "➕ Add Pay Method", callback_data: "adm_add_paym", style: "success" }, { text: "🗑️ Del Method", callback_data: "adm_del_paym", style: "danger" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText(msg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        else if (data === "adm_tog_reward" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            config.reward_system = !config.reward_system;
            await saveAppConfig(config);
            
            let msg = `💳 *Payment & Reward Settings*\n\n💰 *Per OTP Earning:* \`${config.per_otp_rate}\` ৳\n📉 *Min Withdraw:* \`${config.min_withdraw}\` ৳\n👥 *Ref Comm/OTP:* \`${config.ref_otp_commission || 0.5}\` ৳\n🏆 *Top Bonus:* 1st:\`${config.bonus_top1 || 50}\` | 2nd:\`${config.bonus_top2 || 30}\` | 3rd:\`${config.bonus_top3 || 20}\`\n💳 *Methods:* ${config.pay_methods.join(', ') || 'None'}`;
            let kb = [
                [{ text: `🎁 Reward System: ${config.reward_system ? "ON 🟢" : "OFF 🔴"}`, callback_data: "adm_tog_reward", style: "primary" }],
                [{ text: "✏️ Edit Earning/OTP", callback_data: "adm_edit_otprate" }, { text: "✏️ Ref Comm/OTP", callback_data: "adm_edit_refcom" }],
                [{ text: "🥇 Top 1", callback_data: "adm_t1" }, { text: "🥈 Top 2", callback_data: "adm_t2" }, { text: "🥉 Top 3", callback_data: "adm_t3" }],
                [{ text: "✏️ Edit Min Withdraw", callback_data: "adm_edit_minwd" }],
                [{ text: "➕ Add Pay Method", callback_data: "adm_add_paym", style: "success" }, { text: "🗑️ Del Method", callback_data: "adm_del_paym", style: "danger" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText(msg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        
        else if (data === "adm_edit_otprate" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_otp_rate' }; bot.sendMessage(chatId, "✏️ *Enter new earning per OTP (৳):*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_edit_refcom" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_ref_com' }; bot.sendMessage(chatId, "✏️ *Enter Referral Commission per OTP (৳):*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_t1" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_t1' }; bot.sendMessage(chatId, "✏️ *Enter Top 1 Bonus Amount (৳):*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_t2" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_t2' }; bot.sendMessage(chatId, "✏️ *Enter Top 2 Bonus Amount (৳):*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_t3" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_t3' }; bot.sendMessage(chatId, "✏️ *Enter Top 3 Bonus Amount (৳):*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_edit_minwd" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_min_wd' }; bot.sendMessage(chatId, "✏️ *Enter new minimum withdraw limit (৳):*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_add_paym" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_pay_method_add' }; bot.sendMessage(chatId, "✏️ *Enter new payment method name:*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_del_paym" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            let kb = [];
            config.pay_methods.forEach(m => { kb.push([{ text: `🗑️ ${m}`, callback_data: `admdel_m_${m}`, style: "danger" }]); });
            kb.push([{ text: "🔙 Back", callback_data: "adm_paycfg", style: "primary" }]);
            bot.editMessageText("📌 *Select method to delete:*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        else if (data.startsWith('admdel_m_') && chatId === ADMIN_ID) {
            const m = data.split('admdel_m_')[1];
            const config = await getAppConfig();
            config.pay_methods = config.pay_methods.filter(x => x !== m);
            await saveAppConfig(config);
            bot.editMessageText(`✅ Deleted '${m}'`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_paycfg", style: "danger" }]] } }).catch(()=>{});
        }
        
        else if (data === "adm_sites" && chatId === ADMIN_ID) {
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) {
                inlineKeyboard.push([{ text: `❌ Delete ${getPlatIcon(plat)} ${plat}`, callback_data: `del_site_${plat}`, style: "danger" }]);
            }
            inlineKeyboard.push([{ text: "➕ Add New Site", callback_data: "add_site", style: "success" }]);
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]);
            bot.editMessageText("🌐 *Manage Sites*\n\nসাইট ডিলিট করতে ক্রসে ক্লিক করুন:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data === "add_site" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_site_add' }; 
            bot.sendMessage(chatId, "✏️ নতুন সাইটের নাম দিন:");
        }
        else if (data.startsWith('del_site_') && chatId === ADMIN_ID) {
            const plat = data.split('del_site_')[1];
            const ranges = await loadRanges() || {};
            if(ranges[plat]) { delete ranges[plat]; await saveRanges(ranges); }
            bot.editMessageText(`✅ ${plat} ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_sites", style: "danger" }]] } }).catch(()=>{});
        }
        else if (data === "adm_ranges" && chatId === ADMIN_ID) {
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) {
                inlineKeyboard.push([{ text: `${getPlatIcon(plat)} ${plat}`, callback_data: `ar_p_${plat}`, style: "primary" }]);
            }
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]);
            bot.editMessageText("⚙️ *Select Site to Manage Ranges*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('ar_p_') && chatId === ADMIN_ID) {
            const plat = data.split('_').slice(2).join('_');
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            if (ranges[plat]) {
                for (const country of Object.keys(ranges[plat])) { inlineKeyboard.push([{ text: `🌍 ${country}`, callback_data: `ar_c_${plat}_${country}`, style: "primary" }]); }
            }
            inlineKeyboard.push([{ text: "➕ Add Country & Range", callback_data: `ar_add_${plat}`, style: "success" }]);
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "adm_ranges", style: "danger" }]);
            bot.editMessageText(`⚙️ *Manage Countries: ${getPlatIcon(plat)} ${plat}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('ar_add_') && chatId === ADMIN_ID) {
            const plat = data.split('_').slice(2).join('_');
            adminState[chatId] = { action: 'wait_country_name', platform: plat };
            bot.sendMessage(chatId, "✏️ নতুন কান্ট্রির নাম ও ফ্ল্যাগ দিন (যেমন: 🇧🇩 Bangladesh):");
        }
        else if (data.startsWith('ar_c_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges() || {};
            const rangeData = ranges[plat]?.[country];
            
            const currentRange = typeof rangeData === 'string' ? rangeData : (rangeData ? rangeData.range : "Not set");
            const currentPanel = typeof rangeData === 'string' ? 'stexsms' : (rangeData ? rangeData.panel : "stexsms");
            
            let inlineKeyboard = [
                [{ text: "✏️ Edit Range", callback_data: `ar_ed_${plat}_${country}`, style: "primary" }, { text: "❌ Delete Country", callback_data: `ar_del_${plat}_${country}`, style: "danger" }],
                [{ text: "🔙 Back", callback_data: `ar_p_${plat}`, style: "danger" }]
            ];
            bot.editMessageText(`⚙️ *Platform:* ${plat}\n🌍 *Country:* ${country}\n🔌 *Panel:* ${currentPanel.toUpperCase()}\n🔢 *Current Range:* \`${currentRange}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('ar_ed_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            adminState[chatId] = { action: 'wait_range_edit_panel', platform: plat, country: country };
            
            bot.editMessageText(`📌 কোন প্যানেলের রেঞ্জ আপডেট করবেন?`, { chat_id: chatId, message_id: msgId, reply_markup: {
                inline_keyboard: [[{text: "Stexsms", callback_data:"edpan_stexsms"}, {text: "Voltxsms", callback_data:"edpan_voltxsms"}]]
            }}).catch(()=>{});
        }
        else if (data.startsWith('ar_del_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges() || {};
            if (ranges[plat] && ranges[plat][country]) { delete ranges[plat][country]; await saveRanges(ranges); }
            bot.editMessageText(`✅ কান্ট্রি ও রেঞ্জ ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: `ar_p_${plat}`, style: "danger" }]] } }).catch(()=>{});
        }

        // --- Withdraw Controls ---
        else if (data === "wd_start") {
            const config = await getAppConfig();
            if (config.reward_system === false) {
                bot.sendMessage(chatId, "⚠️ Reward system is currently disabled.");
                return;
            }
            let methods = config.pay_methods || [];
            if(methods.length === 0) {
                bot.sendMessage(chatId, "⚠️ No payment methods available.");
                return;
            }
            let inlineKeyboard = [];
            methods.forEach(m => { inlineKeyboard.push([{ text: `💳 ${m}`, callback_data: `wd_m_${m}`, style: "primary" }]); });
            bot.sendMessage(chatId, "📌 *Select Payment Method:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (data.startsWith('wd_m_')) {
            const method = data.split('wd_m_')[1];
            userState[chatId] = { action: 'wait_wd_id', method: method };
            bot.sendMessage(chatId, `✏️ *আপনার ${method} Account ID / Number দিন:*`, { parse_mode: 'Markdown' });
        }

        // --- User 2FA Controls ---
        else if (data === "add_2fa") {
            userState[chatId] = { action: 'wait_2fa_secret' };
            bot.sendMessage(chatId, "✏️ *আপনার 2FA Secret Key (Base32 format) টি পাঠান:*", { parse_mode: 'Markdown' });
        }
        else if (data.startsWith('get_2fa_')) {
            const index = parseInt(data.split('_')[2]);
            const saved2fa = await get2FA(chatId);
            if (saved2fa[index]) {
                const token = authenticator.generate(saved2fa[index].secret);
                const markup = { inline_keyboard: [[{ text: `  ${token}`, copy_text: { text: token }, style: "success" }]] };
                bot.sendMessage(chatId, `🔐 *Live 2FA OTP Code:*\n\n\`${token}\``, { parse_mode: 'Markdown', reply_markup: markup });
            }
        }
        else if (data.startsWith('del_2fa_')) {
            const index = parseInt(data.split('_')[2]);
            const saved2fa = await get2FA(chatId);
            if (saved2fa[index]) {
                saved2fa.splice(index, 1); await save2FA(chatId, saved2fa);
                bot.editMessageText("✅ *2FA Secret ডিলিট করা হয়েছে!*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            }
        }

        // 🟢 My Rank Logic
        else if (data === "my_rank") {
            const u = await User.findOne({ id: String(chatId) });
            if (!u || u.today_otps === 0) {
                bot.answerCallbackQuery(query.id, { text: `আপনি আজকে এখনও কোনো OTP পাননি!`, show_alert: true });
            } else {
                const higherCount = await User.countDocuments({ today_otps: { $gt: u.today_otps } });
                const myRank = higherCount + 1;
                bot.answerCallbackQuery(query.id, { text: `🏆 Your Position: #${myRank}\n🎯 Today's OTPs: ${u.today_otps}`, show_alert: true });
            }
        }

        // --- User Fast Number Flows ---
        else if (data.startsWith('u_site_')) {
            const plat = data.split('_').slice(2).join('_');
            const ranges = await loadRanges();
            let inlineKeyboard = []; let row = [];
            for (const country of Object.keys(ranges[plat] || {})) {
                row.push({ text: country, callback_data: `u_cntry_${plat}_${country}`, style: "primary" });
                if (row.length === 2) { inlineKeyboard.push(row); row = []; }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            bot.editMessageText(`📌 *Select Country for ${getPlatIcon(plat)} ${plat.toUpperCase()}:*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('u_cntry_')) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            bot.deleteMessage(chatId, msgId).catch(()=>{});
            await generateNewNumber(chatId, plat, country, null, null, null);
        }
        else if (data.startsWith('cancel_')) {
            const num = data.split('_')[1];
            const session = activeNumbers.get(num);
            
            if (session && session.chatId === chatId) {
                activeNumbers.delete(num);
                bot.editMessageText("❌ *Number Cancelled.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            } else { 
                bot.editMessageText("❌ *Session Expired or Already Processed.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{}); 
            }
        }
        else if (data.startsWith('change_')) {
            const num = data.split('_')[1];
            const session = activeNumbers.get(num);
            
            if (session && session.chatId === chatId) {
                const { plat, country, panel, range } = session;
                activeNumbers.delete(num);
                bot.editMessageText("❌ *Number Cancelled. Generating New...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
                
                await generateNewNumber(chatId, plat, country, panel, range, msgId);
            } else { 
                bot.editMessageText("❌ *Session Expired or Already Processed.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{}); 
            }
        }
        else if (data === "get_new_num") {
            const lastSession = userLastSession.get(chatId);
            if (lastSession) {
                bot.sendMessage(chatId, "🚀 *Generating requested number...*", {parse_mode: 'Markdown'}).then(sentMsg => {
                    generateNewNumber(chatId, lastSession.plat, lastSession.country, lastSession.panel, lastSession.range, sentMsg.message_id);
                });
            } else {
                bot.sendMessage(chatId, "📌 *Session expired. Go to GET NUMBER from menu to start again.*", { parse_mode: 'Markdown' });
            }
        }
    } catch(e) { 
        console.error("Callback Error:", e);
    }
});

Promise.all([loadPanelKeys()]).then(() => {
    console.log("🔑 DB Settings Loaded. Default APIs injected.");
});

console.log("🚀 V27.0 Referral & Top Users System Booted Successfully!");

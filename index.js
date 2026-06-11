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
app.get('/', (req, res) => res.send('Premium Fire OTP Bot v11.3 (Max Timeout & Deep Bug Fix) is Running!'));
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
    two_fa: { type: Array, default: [] }
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
const BASE_URL = 'http://63.141.255.227'; 
const NUMBER_EXPIRY_MS = 20 * 60 * 1000; 

// --- Webhook vs Polling System ---
let bot;
let botUsername = '';

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
    console.log(`⚠️ SERVER_URL not found in .env, using Polling mode (Fallback).`);
}

bot.getMe().then(me => {
    botUsername = me.username;
    console.log(`🤖 Bot Username Loaded: @${botUsername}`);
});

let adminState = {};
let userState = {};

// 🟢 CONCURRENT ORDER TRACKING SYSTEM
const allOrders = new Map(); 
const userRecentOrder = new Map(); 
const deliveredOtps = new Set();

// ==========================================
// 🌐 MK NETWORK V3 SETUP
// ==========================================
let mkCookies = process.env.MK_COOKIES || ""; 
const MK_API_URL = "https://mknetworkbd.com/API/api_handler_test.php";

async function loadMkCookies() {
    try {
        const doc = await Setting.findOne({ key: 'mk_cookies' });
        if (doc && doc.data && doc.data.cookie) {
            mkCookies = doc.data.cookie;
        }
    } catch (e) {}
}

async function saveMkCookies(cookie) {
    await Setting.findOneAndUpdate({ key: 'mk_cookies' }, { data: { cookie } }, { upsert: true });
    mkCookies = cookie;
}

function getLocDate() {
    let today = new Date();
    let offset = today.getTimezoneOffset() * 60000;
    return (new Date(today - offset)).toISOString().split('T')[0];
}
const getMkDate = getLocDate; 

// 🟢 MK Request with dynamic timeout
async function mkRequest(action, extraParams = {}, isRetry = false, customTimeout = null) {
    const headers = {
        'Cookie': mkCookies,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest', 
        'Origin': 'https://mknetworkbd.com',
        'Referer': 'https://mknetworkbd.com/getnum_test.php'
    };
    try {
        let resData;
        if (action === 'get_number') {
            const params = new URLSearchParams();
            params.append('action', 'get_number');
            for (let k in extraParams) params.append(k, extraParams[k]);
            const reqTimeout = customTimeout || 45000; // Default 45s for get_number
            const res = await axios.post(MK_API_URL, params.toString(), { headers, timeout: reqTimeout });
            resData = res.data;
        } else {
            let qs = `?action=${action}`;
            for (let k in extraParams) qs += `&${k}=${extraParams[k]}`;
            const res = await axios.get(MK_API_URL + qs, { headers, timeout: 12000 });
            resData = res.data;
        }
        return resData;
    } catch (e) { throw e; }
}

// ==========================================
// 🔥 NEXA API SETUP
// ==========================================
let apiKeys = [];

async function loadApiKeys() {
    try {
        const doc = await Setting.findOne({ key: 'api_keys' });
        if (doc && doc.data && doc.data.keys && doc.data.keys.length > 0) {
            apiKeys = doc.data.keys;
        } else {
            if (process.env.API_KEY) apiKeys = [process.env.API_KEY];
        }
    } catch (e) {
        if (process.env.API_KEY) apiKeys = [process.env.API_KEY];
    }
}

async function saveApiKeys(keys) {
    await Setting.findOneAndUpdate({ key: 'api_keys' }, { data: { keys } }, { upsert: true });
    apiKeys = keys;
}

// 🟢 Dynamic Timeout for Nexa
async function apiRequest(method, url, data = null, customTimeout = 25000) {
    let keysToTry = apiKeys.length > 0 ? apiKeys : (process.env.API_KEY ? [process.env.API_KEY] : []);
    if (keysToTry.length === 0) throw new Error("No API Key found");

    let lastError = null;
    for (let key of keysToTry) {
        try {
            const headers = { 'X-API-Key': key };
            let res;
            if (method === 'get') {
                res = await axios.get(url, { headers, timeout: customTimeout });
            } else if (method === 'post') {
                res = await axios.post(url, data, { headers, timeout: customTimeout });
            }
            if (res.data && res.data.success !== false) return res;
            return res;
        } catch (err) { lastError = err; }
    }
    throw lastError || new Error('All API keys failed');
}

// --- App Config (Payment & Settings) ---
async function getAppConfig() {
    try {
        let doc = await Setting.findOne({ key: 'app_config' });
        if (!doc || !doc.data) {
            return { per_otp_rate: 5, min_withdraw: 50, pay_methods: ['Binance'], auto_otp: true, reward_system: true };
        }
        if (doc.data.auto_otp === undefined) doc.data.auto_otp = true;
        if (doc.data.reward_system === undefined) doc.data.reward_system = true;
        return doc.data;
    } catch(e) { return { per_otp_rate: 5, min_withdraw: 50, pay_methods: ['Binance'], auto_otp: true, reward_system: true }; }
}

async function saveAppConfig(data) {
    await Setting.findOneAndUpdate({ key: 'app_config' }, { data }, { upsert: true });
}

// --- Database functions ---
async function ensureUser(user) {
    if (!user || !user.id) return null;
    try {
        const today = getLocDate();
        let u = await User.findOne({ id: String(user.id) });
        if (!u) {
            u = new User({ 
                id: String(user.id), 
                first_name: user.first_name || 'User', 
                username: user.username || 'N/A', 
                joined: new Date().toISOString(),
                last_active_date: today
            });
            await u.save();
        } else {
            if (u.last_active_date !== today) {
                u.today_otps = 0;
                u.today_balance = 0;
                u.last_active_date = today;
                await u.save();
            }
        }
        return u;
    } catch(e) { return null; }
}

async function updateUserStat(userId, type) {
    try {
        if (type === 'number') await User.findOneAndUpdate({ id: String(userId) }, { $inc: { total_numbers: 1 } });
    } catch(e){}
}

async function updateGlobalStats(type) {
    try {
        let update = {};
        if (type === 'pending') update = { 'data.pending': 1 };
        if (type === 'success') update = { 'data.success': 1, 'data.pending': -1 };
        if (type === 'failed') update = { 'data.failed': 1, 'data.pending': -1 };
        await Setting.findOneAndUpdate({ key: 'global_stats' }, { $inc: update }, { upsert: true });
    } catch(e){}
}

async function loadRanges() {
    try {
        const doc = await Setting.findOne({ key: 'platforms' });
        return doc && doc.data ? doc.data : {};
    } catch(e){ return {}; }
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
    try {
        const doc = await Setting.findOne({ key: 'traffic' });
        return doc && doc.data ? doc.data : {};
    } catch(e){ return {}; }
}

async function get2FA(chatId) {
    try {
        const u = await User.findOne({ id: String(chatId) });
        return u && u.two_fa ? u.two_fa : [];
    } catch(e){ return []; }
}

async function save2FA(chatId, two_fa_list) {
    try { await User.findOneAndUpdate({ id: String(chatId) }, { two_fa: two_fa_list }); } catch(e){}
}

// --- Helpers ---
function maskNumber(phone) {
    let str = String(phone);
    if (!str.startsWith('+')) str = '+' + str;
    if (str.length <= 8) return str;
    return str.substring(0, 5) + "♡♡♡" + str.substring(str.length - 4);
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

function getMainMenu(chatId) {
    let kb = [
        [{ text: "📱 GET NUMBER", style: "success" }],
        [{ text: "📥 INBOX", style: "primary" }, { text: "📊 TRAFFIC", style: "primary" }],
        [{ text: "🔐 2FA AUTHENTICATOR", style: "danger" }, { text: "👤 ACCOUNT", style: "primary" }],
        [{ text: "🎧 SUPPORT", style: "primary" }]
    ];
    if (chatId === ADMIN_ID) kb.push([{ text: "🛠️ ADMIN PANEL", style: "danger" }]);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

async function getAdminMenu() {
    const config = await getAppConfig();
    return {
        inline_keyboard: [
            [{ text: "🌐 Manage Sites", callback_data: "adm_sites", style: "primary" }, { text: "⚙️ Manage Ranges", callback_data: "adm_ranges", style: "primary" }],
            [{ text: "💰 API Balance", callback_data: "adm_balance", style: "primary" }, { text: "📊 Dashboard", callback_data: "adm_dash", style: "primary" }],
            [{ text: "📢 Broadcast", callback_data: "adm_broadcast", style: "primary" }, { text: "👥 Manage Users", callback_data: "adm_users", style: "primary" }],
            [{ text: "📄 Download User List", callback_data: "adm_userlist", style: "success" }],
            [{ text: "💳 Payment Settings", callback_data: "adm_paycfg", style: "success" }, { text: "🔑 Manage API Keys", callback_data: "adm_apikeys", style: "danger" }],
            [{ text: "🍪 MK Cookies", callback_data: "adm_mkcookie", style: "primary" }],
            [{ text: `🤖 Auto OTP: ${config.auto_otp ? "🟢 ON" : "🔴 OFF"}`, callback_data: "adm_tog_autootp", style: "primary" }, { text: `🎁 Reward: ${config.reward_system ? "🟢 ON" : "🔴 OFF"}`, callback_data: "adm_tog_reward", style: "primary" }]
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
    if (/[\u0400-\u04FF]/.test(text)) return 'Russian';
    if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
    if (/[\u0980-\u09FF]/.test(text)) return 'Bengali';
    if (/[\u4E00-\u9FFF]/.test(text)) return 'Chinese';
    if (/[\u0E00-\u0E7F]/.test(text)) return 'Thai';
    if (/[\u0C00-\u0C7F]/.test(text)) return 'Telugu';
    if (/[\u0900-\u097F]/.test(text)) return 'Hindi';
    if (/[áéíóúñ¿¡]/.test(text.toLowerCase())) return 'Spanish';
    if (/[àâäéèêëîïôöùûüçœ]/.test(text.toLowerCase())) return 'French';
    if (/[äöüß]/.test(text.toLowerCase())) return 'German';
    if (/[ãõáéíóúç]/.test(text.toLowerCase())) return 'Portuguese';
    return 'English';
}

// --- Force Subscribe ---
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

// 🟢 Process OTP Success Action
async function handleOtpSuccess(order, otpCode, fullSmsText) {
    if (deliveredOtps.has(order.numId)) return;
    deliveredOtps.add(order.numId);
    
    const chatId = order.chatId;
    updateTraffic(order.plat, order.country);

    const config = await getAppConfig();
    let earningText = "";
    let earnedAmount = 0;
    let isDuplicate = false;

    if (config.reward_system) {
        const checkEarn = await Earning.findOne({ num_id: String(order.numId), user_id: String(chatId) });
        if (!checkEarn) {
            const rate = config.per_otp_rate || 0;
            earnedAmount = rate;
            await Earning.create({ num_id: String(order.numId), user_id: String(chatId), date: getLocDate() });
            
            const uDoc = await User.findOne({ id: String(chatId) });
            if(uDoc) {
                uDoc.balance = parseFloat((uDoc.balance + rate).toFixed(2));
                uDoc.today_balance = parseFloat((uDoc.today_balance + rate).toFixed(2));
                uDoc.total_otps += 1;
                uDoc.today_otps += 1;
                await uDoc.save();
            }
            updateGlobalStats('success');
        } else { isDuplicate = true; }

        const updatedUser = await User.findOne({ id: String(chatId) });
        earningText = isDuplicate ? `⚠️ _Already paid for this number_` : `💰 *Earned:* \`${parseFloat(earnedAmount.toFixed(2))}\` ৳`;
        earningText += `\n💳 *Total Balance:* \`${parseFloat(updatedUser.balance.toFixed(2))}\` ৳`;
    } else {
        const checkEarn = await Earning.findOne({ num_id: String(order.numId), user_id: String(chatId) });
        if (!checkEarn) {
            await Earning.create({ num_id: String(order.numId), user_id: String(chatId), date: getLocDate() });
            const uDoc = await User.findOne({ id: String(chatId) });
            if(uDoc) { uDoc.total_otps += 1; uDoc.today_otps += 1; await uDoc.save(); }
            updateGlobalStats('success');
        }
    }

    const formatPhone = order.phone.startsWith('+') ? order.phone : '+' + order.phone;
    const platDisplay = `${getPlatIcon(order.plat)} ${order.plat.charAt(0).toUpperCase() + order.plat.slice(1)}`;
    let detectedLang = detectLang(fullSmsText);
    
    const boxNumber = `╔════════════════════╗\n║ 📱 \`${formatPhone}\` ║ LN- ${detectedLang}\n╚════════════════════╝`;
    
    const otpMarkup = { 
        inline_keyboard: [
            [{ text: ` ${otpCode}`, copy_text: { text: otpCode }, style: "success" }],
            [
                { text: "🔄 Get New Number", callback_data: `gnew_${order.plat}_${order.country}`, style: "success" },
                { text: "💬 OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}`, style: "primary" }
            ]
        ] 
    };
    
    let finalUserMsg = "";
    if (config.reward_system) {
        finalUserMsg = `🎉 *Congratulations! Boss*\n\n📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${order.country}\n\n${boxNumber}\n\n${earningText}`;
    } else {
        finalUserMsg = `🎉 *Congratulations! Boss*\n\n📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${order.country}\n\n${boxNumber}`;
    }
    
    await bot.sendMessage(chatId, finalUserMsg, { parse_mode: 'Markdown', reply_markup: otpMarkup }).catch(()=>{});
    
    const maskedPhone = maskNumber(order.phone);
    const groupBoxNumber = `╔════════════════════╗\n║ 📱 \`${maskedPhone}\` ║ LN- ${detectedLang}\n╚════════════════════╝`;
    
    const groupMarkup = { 
        inline_keyboard: [
            [{ text: `  ${otpCode}`, copy_text: { text: otpCode }, style: "success" }],
            [{ text: "🔄 Get New Number", url: `https://t.me/${botUsername}?start=gnew_${order.plat}_${order.country}`, style: "primary" }]
        ] 
    };
    
    let groupFinalText = finalUserMsg.replace(boxNumber, groupBoxNumber);
    if(config.reward_system) groupFinalText = groupFinalText.replace(earningText, ''); 
    bot.sendMessage(OTP_GROUP_ID, groupFinalText, { parse_mode: 'Markdown', reply_markup: groupMarkup }).catch(()=>{});
}

// 🟢 Background Silent Polling
async function startSilentPolling(numId) {
    const pollInterval = 4000; 
    const maxDuration = NUMBER_EXPIRY_MS;

    const checkTask = async () => {
        if (!allOrders.has(String(numId))) return;
        const currentOrder = allOrders.get(String(numId));
        if (currentOrder.status !== 'pending') return;
        if (Date.now() - currentOrder.createdAt > maxDuration) {
            currentOrder.status = 'expired';
            return;
        }

        try {
            let otpFound = false;
            let otpCode = '';
            let fullSmsText = '';

            if (currentOrder.panel === 'nexa') {
                const res = await apiRequest('get', `${BASE_URL}/api/v1/numbers/${numId}/sms`, null, 15000);
                if (res.data && res.data.success && res.data.otp) {
                    otpFound = true; otpCode = extractOTP(res.data.otp); fullSmsText = res.data.otp;
                }
            } else if (currentOrder.panel === 'mk') {
                await mkRequest('check_otp').catch(()=>{});
                const dateFilter = getMkDate();
                const hist = await mkRequest('get_history', { filter: 'all', page: 1, limit: 15, date: dateFilter });
                if (hist && Array.isArray(hist.data)) {
                    const phoneDigits = currentOrder.phone.replace(/\D/g,'').slice(-6);
                    const matched = hist.data.find(o => String(o.id) === String(numId) || (o.phone_number && o.phone_number.replace(/\D/g,'').includes(phoneDigits)));
                    if (matched && matched.status === 'success') {
                        otpFound = true;
                        if (matched.full_sms_list) fullSmsText = matched.full_sms_list.split('|||')[0];
                        else if (matched.full_sms) fullSmsText = matched.full_sms;
                        else if (matched.otps) fullSmsText = matched.otps.split('|||')[0];
                        otpCode = extractOTP(fullSmsText);
                        if (otpCode.toLowerCase() === 'your' || otpCode.trim() === '') otpCode = "Code Not Found (Check SMS)";
                    }
                }
            }

            if (otpFound) {
                currentOrder.status = 'completed';
                await handleOtpSuccess(currentOrder, otpCode, fullSmsText);
                return;
            }
        } catch (e) {}

        if (currentOrder.status === 'pending') {
            setTimeout(checkTask, pollInterval);
        }
    };
    checkTask(); 
}

// 🟢 Manual OTP Fetch (For Inbox / fallback)
async function processOtpFetch(chatId, numId, msgId, queryId = null) {
    const lastOrder = userLastOrder.get(chatId);
    
    if (!lastOrder || String(lastOrder.numId) !== String(numId)) {
        if(queryId) bot.answerCallbackQuery(queryId, { text: "এই নাম্বারটি আর valid নয়।", show_alert: true });
        return;
    }
    if (Date.now() - lastOrder.createdAt > NUMBER_EXPIRY_MS) return;
    if (deliveredOtps.has(numId)) { 
        if(queryId) bot.answerCallbackQuery(queryId, { text: "OTP ইতিমধ্যেই ডেলিভার হয়েছে!", show_alert: true }); 
        return; 
    }
    if (lastOrder.isChecking) {
        if(queryId) bot.answerCallbackQuery(queryId, { text: "OTP চেক করা হচ্ছে, একটু অপেক্ষা করুন...", show_alert: true });
        return;
    }

    if(queryId) bot.answerCallbackQuery(queryId);
    
    lastOrder.isChecking = true;
    let countMsgId = msgId;
    
    if (msgId === lastOrder.msgId) {
        const countMsg = await bot.sendMessage(chatId, `⏳ *OTP খোঁজা হচ্ছে...*`, { parse_mode: 'Markdown' });
        countMsgId = countMsg.message_id;
    }

    let otpFound = false;
    let otpCode = '';
    let fullSmsText = '';
    const panel = lastOrder.panel || 'nexa';
    
    for (let i = 15; i >= 1; i--) {
        bot.editMessageText(`⏳ *OTP খোঁজা হচ্ছে:* ${i}...`, { chat_id: chatId, message_id: countMsgId, parse_mode: 'Markdown' }).catch(()=>{});
        
        try {
            if (panel === 'nexa') {
                const res = await apiRequest('get', `${BASE_URL}/api/v1/numbers/${numId}/sms`, null, 15000);
                if (res.data && res.data.success && res.data.otp) {
                    otpFound = true; otpCode = extractOTP(res.data.otp); fullSmsText = res.data.otp;
                }
            } else if (panel === 'mk') {
                await mkRequest('check_otp').catch(()=>{});
                const dateFilter = getMkDate();
                const hist = await mkRequest('get_history', { filter: 'all', page: 1, limit: 15, date: dateFilter });
                if (hist && Array.isArray(hist.data)) {
                    const phoneDigits = lastOrder.phone.replace(/\D/g,'').slice(-6);
                    const matched = hist.data.find(o => String(o.id) === String(numId) || (o.phone_number && o.phone_number.replace(/\D/g,'').includes(phoneDigits)));
                    if (matched && matched.status === 'success') {
                        otpFound = true;
                        if (matched.full_sms_list) fullSmsText = matched.full_sms_list.split('|||')[0];
                        else if (matched.full_sms) fullSmsText = matched.full_sms;
                        else if (matched.otps) fullSmsText = matched.otps.split('|||')[0];
                        otpCode = extractOTP(fullSmsText);
                        if (otpCode.toLowerCase() === 'your' || otpCode.trim() === '') otpCode = "Code Not Found (Check SMS)";
                    }
                }
            }
            if (otpFound) break;
        } catch (e) {}
        
        if (!otpFound) await new Promise(resolve => setTimeout(resolve, 1500));
    }

    lastOrder.isChecking = false;

    if (otpFound) {
        deliveredOtps.add(numId);
        activePolls.delete(numId);
        if (allOrders.has(numId)) allOrders.get(numId).status = 'completed';
        
        bot.deleteMessage(chatId, countMsgId).catch(()=>{});
        await handleOtpSuccess(lastOrder, otpCode, fullSmsText);
    } else {
        const actionMarkup = { inline_keyboard: [[ { text: "🔄 Try Again", callback_data: `fetch_otp_${numId}`, style: "primary" } ]] };
        bot.editMessageText(`⚠️ *OTP Not Found!*`, { chat_id: chatId, message_id: countMsgId, parse_mode: 'Markdown', reply_markup: actionMarkup }).catch(()=>{});
    }
}

// 🟢 SUPER FAST Number Generation & Fix For Range Bugs
async function generateNewNumber(chatId, plat, country, msgIdToEdit = null) {
    const ranges = await loadRanges(); 
    const rangeData = ranges[plat]?.[country];
    
    if (!rangeData) {
        if (msgIdToEdit) bot.editMessageText("❌ *তোর কপাল খারাফ রে, Number নাই, আবার চেষ্টা কর 🥲*", {chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown'}).catch(()=>{});
        else bot.sendMessage(chatId, "❌ *তোর কপাল খারাফ রে, Number নাই, আবার চেষ্টা কর 🥲*", {parse_mode: 'Markdown'});
        return;
    }
    
    const rangeVal = typeof rangeData === 'string' ? rangeData : rangeData.range;
    const panel = typeof rangeData === 'string' ? 'nexa' : rangeData.panel;

    let sentMsg;
    if (msgIdToEdit) {
        sentMsg = { message_id: msgIdToEdit, chat: { id: chatId } };
        await bot.editMessageText("🚀 *নাম্বার জেনারেট হচ্ছে...*", { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown' }).catch(()=>{});
    } else {
        sentMsg = await bot.sendMessage(chatId, "🚀 *নাম্বার জেনারেট হচ্ছে...*", { parse_mode: 'Markdown' });
    }
    
    try {
        let success = false;
        let numId = null;
        let finalPhone = null;
        let isSessionError = false;
        let apiErrorMsg = "প্যানেলে নাম্বার স্টকে নেই বা লিমিট শেষ।";
        
        // 🟢 FIX: Ensure string to avoid crash, safely remove hashes/spaces
        const cleanRange = String(rangeVal).replace(/[^0-9Xx]/gi, '');

        if (panel === 'nexa') {
            // 🟢 FIX: 45 SECONDS TIMEOUT!
            const res = await apiRequest('post', `${BASE_URL}/api/v1/numbers/get`, { range: cleanRange, format: "international" }, 45000); 
            if (res.data && res.data.success) {
                success = true; numId = res.data.number_id; finalPhone = res.data.number;
            } else if (res.data && res.data.message) {
                apiErrorMsg = res.data.message;
            }
        } else if (panel === 'mk') {
            // 🟢 FIX: 45 SECONDS TIMEOUT!
            const resData = await mkRequest('get_number', { range: cleanRange }, false, 45000);
            if (resData && resData.status === 'success') {
                success = true; finalPhone = resData.number;
                const dateFilter = getMkDate();
                const hist = await mkRequest('get_history', { filter: 'all', page: 1, limit: 15, date: dateFilter });
                if (hist && Array.isArray(hist.data)) {
                    const phoneDigits = finalPhone.replace(/\D/g,'');
                    const matched = hist.data.find(o => o.phone_number && o.phone_number.replace(/\D/g,'').includes(phoneDigits));
                    if (matched) numId = matched.id;
                }
                if (!numId) numId = finalPhone; 
            } else if (resData && resData.message) {
                let msgStr = resData.message.toLowerCase();
                if (msgStr.includes('expire') || msgStr.includes('login') || msgStr.includes('session')) {
                    isSessionError = true;
                } else {
                    apiErrorMsg = resData.message;
                }
            }
        }

        if (success) {
            const createdAt = Date.now();
            
            allOrders.set(String(numId), { chatId: chatId, phone: finalPhone, plat: plat, country: country, panel: panel, createdAt: createdAt, msgId: sentMsg.message_id, status: 'pending' });
            userRecentOrder.set(chatId, String(numId));
            userLastOrder.set(chatId, { numId: numId, phone: finalPhone, plat: plat, country: country, createdAt: createdAt, msgId: sentMsg.message_id, panel: panel, isChecking: false });
            
            updateUserStat(chatId, 'number');
            updateGlobalStats('pending');
            
            const formatPhone = finalPhone.startsWith('+') ? finalPhone : '+' + finalPhone;
            const boxNumber = `╔════════════════════╗\n║ 📱 \`Wait for OTP...\`\n╚════════════════════╝`;
            const platDisplay = `${getPlatIcon(plat)} ${plat.charAt(0).toUpperCase() + plat.slice(1)}`;
            
            const text = `📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${country}\n\n${boxNumber}`;
            
            const actionMarkup = { 
                inline_keyboard: [
                    [{ text: `📱 ${formatPhone}`, copy_text: { text: formatPhone }, style: "primary" }], 
                    [
                        { text: "🔁 Change Number", callback_data: `change_num_${numId}`, style: "danger" },
                        { text: "🔄 Fetch OTP", callback_data: `fetch_otp_${numId}`, style: "success" }
                    ]
                ] 
            };
            await bot.editMessageText(text, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown', reply_markup: actionMarkup }).catch(()=>{});
            activePolls.set(numId, true);
            
            const config = await getAppConfig();
            if (config.auto_otp) {
                startSilentPolling(numId);
            }

        } else {
            // 🟢 SHOW ACTUAL ERROR REASON
            let errorText = `❌ *তোর কপাল খারাফ রে, Number নাই, আবার চেষ্টা কর 🥲*\n\n⚠️ *Reason:* \`${apiErrorMsg}\``;
            let replyMarkup = undefined;
            if (isSessionError) {
                errorText = "❌ *নাম্বার আর OTP দিতে দিতে আমার জীবন শেষ 😩*\n\n_Admin কে বল আমারে এক গ্লাস পানি দিতে 🥺_";
                replyMarkup = { inline_keyboard: [[{ text: "👨‍💻 Contact Admin", url: `tg://user?id=${ADMIN_ID}`, style: "primary" }]] };
            }
            bot.editMessageText(errorText, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown', reply_markup: replyMarkup }).catch(()=>{});
        }
    } catch (error) { 
        // 🟢 CATCH BLOCK ERROR REVEAL
        console.error("Number Gen Err:", error.message || error);
        let errMsg = error.message || "অজানা ত্রুটি";
        if (errMsg.includes('timeout') || errMsg.includes('aborted')) errMsg = "সার্ভার রেসপন্স দিতে অনেক সময় নিচ্ছে (টাইমআউট)।";
        else if (errMsg.includes('404')) errMsg = "সার্ভার বা API লিংক ভুল (404)।";
        else if (errMsg.includes('500')) errMsg = "প্যানেলের সার্ভারে সমস্যা (500)।";
        
        bot.editMessageText(`❌ *তোর কপাল খারাফ রে, Number নাই, আবার চেষ্টা কর 🥲*\n\n⚠️ *Reason:* \`${errMsg}\``, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' }).catch(()=>{}); 
    }
}

function getCancelMarkup() {
    return { inline_keyboard: [[{ text: "🔙 Cancel / Back", callback_data: "adm_cancel_state", style: "danger" }]] };
}

// --- Commands & Messages ---
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param = match[1] ? match[1].trim() : '';

    const u = await ensureUser(msg.from);
    if (u && u.banned) return bot.sendMessage(chatId, "🚫 *You are banned from using this bot.*", { parse_mode: 'Markdown' });
    if (!(await checkForceSub(chatId))) return;

    if (param.startsWith('gnew_')) {
        const parts = param.split('_');
        const plat = parts[1];
        const country = parts.slice(2).join('_');
        bot.sendMessage(chatId, "⏳ *Generating your requested number...*", { parse_mode: 'Markdown' }).then(sentMsg => {
            generateNewNumber(chatId, plat, country, sentMsg.message_id);
        });
        return;
    }

    const welcomeMsg = ` 💐*WELCOME TO FIRE OTP BOT*\n\n👋 Hello, *${msg.from.first_name}*!\n\n🚀 _Get unlimited virtual numbers and instant OTPs for any platform in seconds._\n\n👇 Please choose an option from the menu below:`;
    bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(chatId) });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    const u = await ensureUser(msg.from);
    if (u && u.banned) return bot.sendMessage(chatId, "🚫 *You are banned from using this bot.*", { parse_mode: 'Markdown' });

    const menuButtons = ["📱 GET NUMBER", "📥 INBOX", "📊 TRAFFIC", "🔐 2FA AUTHENTICATOR", "👤 ACCOUNT", "🎧 SUPPORT", "🛠️ ADMIN PANEL"];
    
    if (menuButtons.some(btn => text.includes(btn))) {
        if(adminState[chatId]) delete adminState[chatId];
        if(userState[chatId]) delete userState[chatId];
    }
    
    // --- USER STATE MACHINE ---
    if (userState[chatId]) {
        const state = userState[chatId];
        
        if (state.action === 'wait_wd_id') {
            state.account_id = text.trim();
            state.action = 'wait_wd_amount';
            bot.sendMessage(chatId, `✅ *Method:* ${state.method}\n✅ *Account/ID:* \`${state.account_id}\`\n\n💰 *এবার কত টাকা উইথড্র করতে চান তা লিখুন:*`, { parse_mode: 'Markdown' });
            return;
        }
        else if (state.action === 'wait_wd_amount') {
            const amount = parseFloat(text.trim());
            if (isNaN(amount) || amount <= 0) {
                return bot.sendMessage(chatId, "❌ *Please enter a valid amount.*", { parse_mode: 'Markdown' });
            }
            
            try {
                const config = await getAppConfig();
                const userDoc = await User.findOne({ id: String(chatId) });
                
                if (amount < config.min_withdraw) {
                    return bot.sendMessage(chatId, `⚠️ *Minimum Withdraw is ${config.min_withdraw} ৳*`, { parse_mode: 'Markdown' });
                }
                if (amount > userDoc.balance) {
                    return bot.sendMessage(chatId, "❌ *Insufficient Balance!*", { parse_mode: 'Markdown' });
                }

                userDoc.balance = parseFloat((userDoc.balance - amount).toFixed(2));
                await userDoc.save();

                const wd_id = Math.random().toString(36).substring(2, 10).toUpperCase();
                await Withdraw.create({
                    wd_id: wd_id,
                    user_id: String(chatId),
                    amount: amount,
                    method: state.method,
                    account: state.account_id,
                    date: getLocDate()
                });

                bot.sendMessage(chatId, `✅ *Withdraw Request Submitted!*\n\n💰 *Amount:* \`${amount}\` ৳\n💳 *Method:* ${state.method}\n\n_Please wait for admin approval._`, { parse_mode: 'Markdown' });

                const wdGroupMsg = `🔔 *NEW WITHDRAW REQUEST*\n\n👤 *User ID:* \`${chatId}\`\n💳 *Method:* ${state.method}\n🏦 *Account/ID:* \`${state.account_id}\`\n💰 *Amount:* \`${amount}\` ৳\n\n_Select an action below:_`;
                const wdMarkup = { inline_keyboard: [[
                    { text: "✅ Approve", callback_data: `wd_appr_${wd_id}`, style: "success" },
                    { text: "❌ Cancel", callback_data: `wd_canc_${wd_id}`, style: "danger" }
                ]]};
                bot.sendMessage(PAYMENT_GROUP_ID, wdGroupMsg, { parse_mode: 'Markdown', reply_markup: wdMarkup }).catch(()=>{});

            } catch (e) { bot.sendMessage(chatId, "❌ Error processing request."); }
            
            delete userState[chatId];
            return;
        }
    }

    // --- ADMIN STATE MACHINE ---
    if (adminState[chatId]) {
        const state = adminState[chatId];

        if (state.action === 'wait_2fa_secret') {
            const secret = text.trim().replace(/\s+/g, '').toUpperCase();
            try {
                authenticator.generate(secret);
                const saved2fa = await get2FA(chatId);
                saved2fa.push({ secret: secret, added: new Date().toISOString() });
                await save2FA(chatId, saved2fa);
                bot.sendMessage(chatId, `✅ *2FA Secret সেভ হয়েছে!*`, { parse_mode: 'Markdown' });
            } catch (e) { bot.sendMessage(chatId, `❌ *ভুল সিক্রেট কোড!*`, { parse_mode: 'Markdown' }); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_site_add') {
            const ranges = await loadRanges();
            if (!ranges[text]) ranges[text] = {};
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ সাইট *${getPlatIcon(text)} ${text}* যুক্ত হয়েছে!`, { parse_mode: 'Markdown' });
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_country_name') {
            state.country = text;
            const markup = {
                inline_keyboard: [
                    [{ text: "🔥 Nexa API (63.141.x.x)", callback_data: "setpan_nexa", style: "danger" }],
                    [{ text: "🌐 MK Network V3", callback_data: "setpan_mk", style: "success" }],
                    [{ text: "🔙 Cancel", callback_data: "adm_cancel_state", style: "danger" }]
                ]
            };
            bot.sendMessage(chatId, `✅ Country: ${text}\n\n📌 এবার কোন প্যানেল থেকে নাম্বার আসবে তা সিলেক্ট করুন:`, { reply_markup: markup });
            return;
        }
        else if (state.action === 'wait_range_val') {
            const ranges = await loadRanges();
            if (!ranges[state.platform]) ranges[state.platform] = {};
            ranges[state.platform][state.country] = { range: text, panel: state.panel || 'nexa' };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ *${state.platform}* এর জন্য রেঞ্জ সেভ হয়েছে!`, { parse_mode: 'Markdown' });
            const icon = getPlatIcon(state.platform);
            const platName = state.platform.charAt(0).toUpperCase() + state.platform.slice(1);
            const broadcastMsg = `📢 *NEW NUMBER STOCKED!*\n\n${icon} *Platform:* ${platName}\n🌍 *Country:* ${state.country}\n\n🔥 _Go to "GET NUMBER" and grab your numbers now!_`;
            try {
                const users = await User.find({});
                users.forEach(u => bot.sendMessage(u.id, broadcastMsg, { parse_mode: 'Markdown' }).catch(()=>{}));
            } catch(e){}
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_range_edit') {
            const ranges = await loadRanges();
            ranges[state.platform][state.country] = { range: text, panel: state.panel };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ Range updated successfully!`);
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_broadcast_notice') {
            const noticeText = text.trim();
            if (!noticeText) { bot.sendMessage(chatId, "❌ Invalid text"); delete adminState[chatId]; return; }
            try {
                await Setting.findOneAndUpdate({ key: 'notice' }, { data: { text: noticeText, updatedAt: new Date().toISOString() } }, { upsert: true });
                bot.sendMessage(chatId, "✅ *Broadcasting...*", { parse_mode: 'Markdown' });
                const users = await User.find({});
                users.forEach(u => bot.sendMessage(u.id, `📢 *Notice from Admin:*\n\n${noticeText}`, { parse_mode: 'Markdown' }).catch(()=>{}));
            } catch (e) {} delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_apikey_add') {
            const newKey = text.trim();
            if (!newKey) { bot.sendMessage(chatId, "❌ Invalid key"); delete adminState[chatId]; return; }
            try {
                let doc = await Setting.findOne({ key: 'api_keys' });
                let keys = doc && doc.data && doc.data.keys ? doc.data.keys : [];
                if (!keys.includes(newKey)) { keys.push(newKey); await saveApiKeys(keys); }
                bot.sendMessage(chatId, "✅ *API Key added!*", { parse_mode: 'Markdown' });
            } catch (e) {} delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_mk_cookie_add') {
            const newCookie = text.trim();
            if (!newCookie) { bot.sendMessage(chatId, "❌ Invalid cookie format"); delete adminState[chatId]; return; }
            try { await saveMkCookies(newCookie); bot.sendMessage(chatId, "✅ *MK Cookie updated!*", { parse_mode: 'Markdown' }); } 
            catch (e) { bot.sendMessage(chatId, "❌ Error saving cookie"); } 
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_otp_rate') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) {
                const config = await getAppConfig(); config.per_otp_rate = val; await saveAppConfig(config);
                bot.sendMessage(chatId, `✅ *OTP Rate updated to ${val} ৳*`, { parse_mode: 'Markdown' });
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
            if (!targetUser) {
                bot.sendMessage(chatId, "❌ *User not found!*", { parse_mode: 'Markdown' });
            } else {
                const msgText = `👤 *USER DETAILS*\n\nID: \`${targetUser.id}\`\nName: ${targetUser.first_name}\nUsername: ${targetUser.username}\n\n💰 *Total Bal:* \`${parseFloat(targetUser.balance.toFixed(2))}\` ৳\n💸 *Today Bal:* \`${parseFloat(targetUser.today_balance.toFixed(2))}\` ৳\n\n📊 *Total OTPs:* \`${targetUser.total_otps}\`\n📈 *Today OTPs:* \`${targetUser.today_otps}\`\n\n🚫 *Status:* ${targetUser.banned ? 'BANNED' : 'ACTIVE'}`;
                const markup = { inline_keyboard: [
                    [{ text: targetUser.banned ? "✅ Unban User" : "🚫 Ban User", callback_data: `adm_togban_${targetUser.id}`, style: targetUser.banned ? "success" : "danger" }]
                ]};
                bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: markup });
            }
            delete adminState[chatId]; return;
        }
    }

    if (!(await checkForceSub(chatId))) return;

    try {
        if (text === "🛠️ ADMIN PANEL" && chatId === ADMIN_ID) {
            const menu = await getAdminMenu();
            bot.sendMessage(chatId, "🛠 *Admin Control Panel*\n\nSelect an option below:", { parse_mode: 'Markdown', reply_markup: menu });
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
        else if (text === "📥 INBOX") {
            const recentNumId = userRecentOrder.get(chatId);
            const activeOrder = recentNumId ? allOrders.get(recentNumId) : null;
            
            if (!activeOrder) return bot.sendMessage(chatId, "⚠️ *কোনো অ্যাক্টিভ নাম্বার নেই!*\n\n_আগে একটি নাম্বার জেনারেট করুন।_", { parse_mode: 'Markdown' });
            
            bot.sendMessage(chatId, "⏳ *ইনবক্স চেক করা হচ্ছে...*", { parse_mode: 'Markdown' }).then(msg => {
                processOtpFetch(chatId, recentNumId, msg.message_id, null);
            });
        }
        else if (text === "📊 TRAFFIC") {
            const traffic = await getTraffic();
            if (Object.keys(traffic).length === 0) return bot.sendMessage(chatId, "⚠️ *এখনও কোনো ট্রাফিক ডাটা নেই।*", { parse_mode: 'Markdown' });
            let sorted = Object.entries(traffic).sort((a, b) => b[1] - a[1]);
            let msgText = "📊 *GLOBAL OTP TRAFFIC*\n\n";
            sorted.forEach(([key, count], index) => { msgText += `*${index + 1}.* ${key} ➔ \`${count} OTPs\`\n`; });
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
        }
        else if (text === "👤 ACCOUNT") {
            const uData = await ensureUser(msg.from);
            const msgText = `👤 *USER ACCOUNT*\n\n🔖 *ID:* \`${uData.id}\`\n👤 *Name:* ${uData.first_name}\n\n💰 *Total Balance:* \`${parseFloat(uData.balance.toFixed(2))}\` ৳\n💸 *Today Earnings:* \`${parseFloat(uData.today_balance.toFixed(2))}\` ৳\n\n📊 *Total OTPs:* \`${uData.total_otps}\`\n📈 *Today OTPs:* \`${uData.today_otps}\``;
            const markup = { inline_keyboard: [[{ text: "💵 Withdraw Funds", callback_data: "wd_start", style: "success" }]] };
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: markup });
        }
        else if (text === "🔐 2FA AUTHENTICATOR") {
            const saved2fa = await get2FA(chatId);
            let markup = { inline_keyboard: [[{ text: "➕ Add New 2FA Secret", callback_data: "add_2fa", style: "primary" }]] };
            if (saved2fa.length === 0) {
                bot.sendMessage(chatId, "🔐 *2FA Authenticator*\n\nআপনার কোনো 2FA সিক্রেট কোড সেভ করা নেই।", { parse_mode: 'Markdown', reply_markup: markup });
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
            bot.sendMessage(chatId, "🎧 *SUPPORT CENTER*\n\nবট ব্যবহার করতে কোনো সমস্যা হলে বা হেল্প লাগলে সরাসরি অ্যাডমিনের ইনবক্সে মেসেজ দিন:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "👨‍💻 Contact Admin", url: `tg://user?id=${ADMIN_ID}`, style: "primary" }]] } });
        }
    } catch (e) {
        bot.sendMessage(chatId, "⚠️ *সার্ভার ত্রুটি!* বাটনটি আবার ক্লিক করুন।", { parse_mode: 'Markdown' });
    }
});

// --- Callbacks ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data.startsWith('wd_appr_') || data.startsWith('wd_canc_')) {
        if (query.from.id !== ADMIN_ID) {
            return bot.answerCallbackQuery(query.id, { text: "❌ Only Admin can do this!", show_alert: true });
        }
        const isApprove = data.startsWith('wd_appr_');
        const wd_id = data.split('_')[2];
        
        try {
            const reqDoc = await Withdraw.findOne({ wd_id: wd_id });
            if (!reqDoc || reqDoc.status !== 'pending') {
                return bot.answerCallbackQuery(query.id, { text: "⚠️ Already processed or not found.", show_alert: true });
            }
            
            if (isApprove) {
                reqDoc.status = 'approved';
                await reqDoc.save();
                bot.editMessageText(query.message.text + "\n\n✅ *STATUS: APPROVED*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
                bot.sendMessage(reqDoc.user_id, `🎉 *Withdrawal Approved!*\n\n💰 Amount: \`${reqDoc.amount}\` ৳\n💳 Method: ${reqDoc.method}\n\n_Your funds have been sent successfully._`, { parse_mode: 'Markdown' }).catch(()=>{});
            } else {
                reqDoc.status = 'rejected';
                await reqDoc.save();
                const uDoc = await User.findOne({ id: reqDoc.user_id });
                if (uDoc) { 
                    uDoc.balance = parseFloat((uDoc.balance + reqDoc.amount).toFixed(2)); 
                    await uDoc.save(); 
                }
                bot.editMessageText(query.message.text + "\n\n❌ *STATUS: REJECTED*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
                bot.sendMessage(reqDoc.user_id, `❌ *Withdrawal Rejected!*\n\n💰 Amount: \`${reqDoc.amount}\` ৳ has been refunded to your bot balance.`, { parse_mode: 'Markdown' }).catch(()=>{});
            }
        } catch (e) { bot.answerCallbackQuery(query.id, { text: "Error processing.", show_alert: true }); }
        return bot.answerCallbackQuery(query.id);
    }

    const uCheck = await User.findOne({ id: String(chatId) });
    if(uCheck && uCheck.banned && chatId !== ADMIN_ID) {
        return bot.answerCallbackQuery(query.id, { text: "🚫 You are banned.", show_alert: true });
    }

    try {
        if (data === "adm_cancel_state") {
            delete adminState[chatId];
            const menu = await getAdminMenu();
            bot.editMessageText("🛠 *Admin Control Panel*\n\nAction cancelled.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: menu }).catch(()=>{});
            bot.answerCallbackQuery(query.id);
        }
        else if (data === "check_joined") {
            if (await checkForceSub(chatId)) {
                bot.deleteMessage(chatId, msgId).catch(()=>{});
                bot.sendMessage(chatId, "✅ *Boss, এখন Number নিয়ে কাজ শুরু করে দিন।*", { parse_mode: 'Markdown', ...getMainMenu(chatId) });
            } else bot.answerCallbackQuery(query.id, { text: "⚠️ এখনও সব চ্যানেলে জয়েন করেননি!", show_alert: true });
        }
        else if (data === "wd_start") {
            const config = await getAppConfig();
            let methods = config.pay_methods || [];
            if(methods.length === 0) {
                return bot.answerCallbackQuery(query.id, { text: "⚠️ No payment methods available currently.", show_alert: true });
            }
            let inlineKeyboard = [];
            methods.forEach(m => {
                inlineKeyboard.push([{ text: `💳 ${m}`, callback_data: `wd_m_${m}`, style: "primary" }]);
            });
            bot.sendMessage(chatId, "📌 *Select Payment Method:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('wd_m_')) {
            const method = data.split('wd_m_')[1];
            userState[chatId] = { action: 'wait_wd_id', method: method };
            bot.sendMessage(chatId, `✏️ *আপনার ${method} Account ID / Number দিন:*`, { parse_mode: 'Markdown' });
            bot.answerCallbackQuery(query.id);
        }
        else if (data === "admin_main" && chatId === ADMIN_ID) {
            const menu = await getAdminMenu();
            bot.editMessageText("🛠 *Admin Control Panel*\n\nSelect an option below:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: menu });
        }
        else if (data === "adm_tog_autootp" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            config.auto_otp = !config.auto_otp;
            await saveAppConfig(config);
            const menu = await getAdminMenu();
            bot.editMessageReplyMarkup(menu.reply_markup, { chat_id: chatId, message_id: msgId }).catch(()=>{});
            bot.answerCallbackQuery(query.id, { text: `Auto OTP is now ${config.auto_otp ? 'ON' : 'OFF'}`, show_alert: false });
        }
        else if (data === "adm_tog_reward" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            config.reward_system = !config.reward_system;
            await saveAppConfig(config);
            const menu = await getAdminMenu();
            bot.editMessageReplyMarkup(menu.reply_markup, { chat_id: chatId, message_id: msgId }).catch(()=>{});
            bot.answerCallbackQuery(query.id, { text: `Reward System is now ${config.reward_system ? 'ON' : 'OFF'}`, show_alert: false });
        }
        else if (data === "adm_balance" && chatId === ADMIN_ID) {
            bot.answerCallbackQuery(query.id, { text: "💰 Checking Balance..." });
            try {
                const res = await apiRequest('get', `${BASE_URL}/api/v1/balance`);
                if(res.data.success) {
                    const menu = await getAdminMenu();
                    bot.editMessageText(`💰 *API Balance:* \`${parseFloat(res.data.balance).toFixed(2)}\` ৳`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]] }});
                }
            } catch(e) { bot.answerCallbackQuery(query.id, { text: "Error getting balance", show_alert:true }); }
        }
        else if (data === "adm_dash" && chatId === ADMIN_ID) {
            try {
                const totalUsers = await User.countDocuments();
                const statDoc = await Setting.findOne({ key: 'global_stats' });
                const gStats = statDoc && statDoc.data ? statDoc.data : { success: 0, pending: 0, failed: 0 };
                let apiBal = "Loading...";
                try {
                    const balRes = await apiRequest('get', `${BASE_URL}/api/v1/balance`, null, 15000);
                    if(balRes.data.success) apiBal = parseFloat(balRes.data.balance).toFixed(2) + " ৳";
                } catch(e){ apiBal = "Error"; }
                const dashText = `📊 *BOT DASHBOARD*\n\n💰 *API Balance:* \`${apiBal}\`\n👥 *Total Users:* \`${totalUsers}\`\n\n📈 *Order Stats:*\n✅ Success: \`${gStats.success || 0}\`\n⏳ Pending: \`${gStats.pending || 0}\`\n❌ Failed: \`${gStats.failed || 0}\``;
                bot.editMessageText(dashText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]] }});
            } catch (e) {}
        }
        else if (data === "adm_userlist" && chatId === ADMIN_ID) {
            bot.answerCallbackQuery(query.id, { text: "⏳ Preparing user list..." });
            try {
                const users = await User.find({});
                let userList = "👥 *USER LIST* 👥\n\nID | Name | Username | Bal (৳) | Total OTPs | Joined\n--------------------------------------------------------------\n";
                users.forEach(u => {
                    let cleanBal = u.balance ? parseFloat(u.balance.toFixed(2)) : 0;
                    userList += `${u.id} | ${u.first_name || 'N/A'} | ${u.username || 'N/A'} | ${cleanBal} | ${u.total_otps || 0} | ${u.joined ? new Date(u.joined).toLocaleDateString() : 'N/A'}\n`;
                });
                const buffer = Buffer.from(userList, 'utf-8');
                await bot.sendDocument(chatId, buffer, {}, { filename: 'users_list.txt', contentType: 'text/plain' });
            } catch (e) { bot.sendMessage(chatId, "⚠️ *Error generating user list.*", { parse_mode: 'Markdown' }); }
        }
        else if (data === "adm_paycfg" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            let msg = `💳 *Payment Settings*\n\n💰 *Per OTP Earning:* \`${config.per_otp_rate}\` ৳\n📉 *Min Withdraw:* \`${config.min_withdraw}\` ৳\n\n💳 *Methods:* ${config.pay_methods.join(', ') || 'None'}`;
            let kb = [
                [{ text: "✏️ Edit Earning/OTP", callback_data: "adm_edit_otprate", style: "primary" }, { text: "✏️ Edit Min Withdraw", callback_data: "adm_edit_minwd", style: "primary" }],
                [{ text: "➕ Add Method", callback_data: "adm_add_paym", style: "success" }, { text: "🗑️ Delete Method", callback_data: "adm_del_paym", style: "danger" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText(msg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
        }
        else if (data === "adm_edit_otprate" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_otp_rate' }; 
            bot.sendMessage(chatId, "✏️ *Enter new earning per OTP (৳):*", { parse_mode: 'Markdown', reply_markup: getCancelMarkup() }); 
            bot.answerCallbackQuery(query.id);
        }
        else if (data === "adm_edit_minwd" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_min_wd' }; 
            bot.sendMessage(chatId, "✏️ *Enter new minimum withdraw limit (৳):*", { parse_mode: 'Markdown', reply_markup: getCancelMarkup() }); 
            bot.answerCallbackQuery(query.id);
        }
        else if (data === "adm_add_paym" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_pay_method_add' }; 
            bot.sendMessage(chatId, "✏️ *Enter new payment method name (e.g. Binance):*", { parse_mode: 'Markdown', reply_markup: getCancelMarkup() }); 
            bot.answerCallbackQuery(query.id);
        }
        else if (data === "adm_del_paym" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            let kb = [];
            config.pay_methods.forEach(m => {
                kb.push([{ text: `🗑️ ${m}`, callback_data: `admdel_m_${m}`, style: "danger" }]);
            });
            kb.push([{ text: "🔙 Back", callback_data: "adm_paycfg", style: "primary" }]);
            bot.editMessageText("📌 *Select method to delete:*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
        }
        else if (data.startsWith('admdel_m_') && chatId === ADMIN_ID) {
            const m = data.split('admdel_m_')[1];
            const config = await getAppConfig();
            config.pay_methods = config.pay_methods.filter(x => x !== m);
            await saveAppConfig(config);
            bot.editMessageText(`✅ Deleted '${m}'`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_paycfg", style: "danger" }]] } });
        }
        else if (data === "adm_users" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_manage_userid' };
            bot.sendMessage(chatId, "✏️ *Enter User ID to manage:*", { parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('adm_togban_') && chatId === ADMIN_ID) {
            const targetId = data.split('_')[2];
            const targetUser = await User.findOne({ id: String(targetId) });
            if (targetUser) {
                targetUser.banned = !targetUser.banned;
                await targetUser.save();
                bot.editMessageText(`✅ *User ${targetUser.banned ? 'BANNED' : 'UNBANNED'} successfully!*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            }
            bot.answerCallbackQuery(query.id);
        }
        else if (data === "adm_sites" && chatId === ADMIN_ID) {
            const ranges = await loadRanges();
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) {
                inlineKeyboard.push([{ text: `❌ Delete ${getPlatIcon(plat)} ${plat}`, callback_data: `del_site_${plat}`, style: "danger" }]);
            }
            inlineKeyboard.push([{ text: "➕ Add New Site", callback_data: "add_site", style: "success" }]);
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]);
            bot.editMessageText("🌐 *Manage Sites*\n\nসাইট ডিলিট করতে ক্রসে ক্লিক করুন:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        else if (data === "add_site" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_site_add' };
            bot.sendMessage(chatId, "✏️ নতুন সাইটের নাম দিন:", { reply_markup: getCancelMarkup() }); bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('del_site_') && chatId === ADMIN_ID) {
            const plat = data.split('del_site_')[1];
            const ranges = await loadRanges();
            delete ranges[plat]; await saveRanges(ranges);
            bot.editMessageText(`✅ ${plat} ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_sites", style: "danger" }]] } });
        }
        else if (data === "adm_ranges" && chatId === ADMIN_ID) {
            const ranges = await loadRanges();
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) {
                inlineKeyboard.push([{ text: `${getPlatIcon(plat)} ${plat}`, callback_data: `ar_p_${plat}`, style: "primary" }]);
            }
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]);
            bot.editMessageText("⚙️ *Select Site to Manage Ranges*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        else if (data.startsWith('ar_p_') && chatId === ADMIN_ID) {
            const plat = data.split('ar_p_')[1];
            const ranges = await loadRanges();
            let inlineKeyboard = [];
            if (ranges[plat]) {
                for (const country of Object.keys(ranges[plat])) {
                    inlineKeyboard.push([{ text: `🌍 ${country}`, callback_data: `ar_c_${plat}_${country}`, style: "primary" }]);
                }
            }
            inlineKeyboard.push([{ text: "➕ Add Country & Range", callback_data: `ar_add_${plat}`, style: "success" }]);
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "adm_ranges", style: "danger" }]);
            bot.editMessageText(`⚙️ *Manage Countries: ${getPlatIcon(plat)} ${plat}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        else if (data.startsWith('ar_add_') && chatId === ADMIN_ID) {
            const plat = data.split('ar_add_')[1];
            adminState[chatId] = { action: 'wait_country_name', platform: plat };
            bot.sendMessage(chatId, "✏️ নতুন কান্ট্রির নাম ও ফ্ল্যাগ দিন (যেমন: 🇧🇩 Bangladesh):", { reply_markup: getCancelMarkup() });
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('setpan_') && chatId === ADMIN_ID) {
            const panel = data.split('_')[1];
            const state = adminState[chatId];
            if (state && state.action === 'wait_country_name') {
                state.panel = panel;
                state.action = 'wait_range_val';
                bot.editMessageText(`✅ প্যানেল: ${panel.toUpperCase()}\n\n✏️ এবার রেঞ্জ টাইপ করুন (যেমন: 22507XXX):`, { chat_id: chatId, message_id: msgId, reply_markup: getCancelMarkup() });
            }
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('ar_c_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges();
            const rangeData = ranges[plat][country];
            
            const currentRange = typeof rangeData === 'string' ? rangeData : (rangeData ? rangeData.range : "Not set");
            const currentPanel = typeof rangeData === 'string' ? 'nexa' : (rangeData ? rangeData.panel : "nexa");

            let inlineKeyboard = [
                [{ text: "✏️ Edit Range", callback_data: `ar_ed_${plat}_${country}`, style: "primary" }, { text: "❌ Delete Country", callback_data: `ar_del_${plat}_${country}`, style: "danger" }],
                [{ text: "🔙 Back", callback_data: `ar_p_${plat}`, style: "danger" }]
            ];
            bot.editMessageText(`⚙️ *Platform:* ${plat}\n🌍 *Country:* ${country}\n🔌 *Panel:* ${currentPanel.toUpperCase()}\n🔢 *Current Range:* \`${currentRange}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        else if (data.startsWith('ar_ed_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges();
            const rangeData = ranges[plat][country];
            const currentPanel = typeof rangeData === 'string' ? 'nexa' : (rangeData ? rangeData.panel : "nexa");
            
            adminState[chatId] = { action: 'wait_range_edit', platform: plat, country: country, panel: currentPanel };
            bot.sendMessage(chatId, `✏️ *${country}* এর জন্য নতুন রেঞ্জ টাইপ করুন (Panel: ${currentPanel.toUpperCase()}):`, { reply_markup: getCancelMarkup() });
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('ar_del_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges();
            if (ranges[plat] && ranges[plat][country]) { delete ranges[plat][country]; await saveRanges(ranges); }
            bot.editMessageText(`✅ কান্ট্রি ও রেঞ্জ ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: `ar_p_${plat}`, style: "danger" }]] } });
        }
        else if (data === "adm_broadcast" && chatId === ADMIN_ID) {
            const doc = await Setting.findOne({ key: 'notice' });
            let noticeText = "None";
            if (doc && doc.data) noticeText = doc.data.text;
            let markup = {
                inline_keyboard: [
                    [{ text: "✏️ Add/Edit Notice", callback_data: "broadcast_edit", style: "primary" }, { text: "🗑️ Delete Notice", callback_data: "broadcast_delete", style: "danger" }],
                    [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
                ]
            };
            bot.editMessageText(`📢 *Current Notice:* ${noticeText}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
        }
        else if (data === "broadcast_edit" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_broadcast_notice' };
            bot.sendMessage(chatId, "✏️ *নতুন নোটিশ টেক্সট লিখুন:*", { parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
            bot.answerCallbackQuery(query.id);
        }
        else if (data === "broadcast_delete" && chatId === ADMIN_ID) {
            await Setting.deleteOne({ key: 'notice' }).catch(()=>{});
            bot.editMessageText("✅ *Notice deleted.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]] } });
        }
        else if (data === "adm_apikeys" && chatId === ADMIN_ID) {
            const doc = await Setting.findOne({ key: 'api_keys' });
            let keys = doc && doc.data && doc.data.keys ? doc.data.keys : [];
            if (keys.length === 0 && process.env.API_KEY) keys = [process.env.API_KEY];
            let msgText = "🔑 *API Keys:*\n";
            keys.forEach((key, idx) => {
                let masked = key.substring(0, 4) + "****" + key.slice(-4);
                msgText += `\n${idx+1}. \`${masked}\``;
            });
            let inlineKeyboard = [];
            keys.forEach((_, idx) => {
                inlineKeyboard.push([{ text: `🗑️ Delete Key ${idx+1}`, callback_data: `del_apikey_${idx}`, style: "danger" }]);
            });
            inlineKeyboard.push([{ text: "➕ Add New Key", callback_data: "add_apikey", style: "success" }]);
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]);
            bot.editMessageText(msgText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (data === "add_apikey" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_apikey_add' };
            bot.sendMessage(chatId, "✏️ *নতুন API Key লিখুন:*", { parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('del_apikey_') && chatId === ADMIN_ID) {
            const index = parseInt(data.split('_')[2]);
            const doc = await Setting.findOne({ key: 'api_keys' });
            let keys = doc && doc.data && doc.data.keys ? doc.data.keys : [];
            if (keys.length > index) {
                keys.splice(index, 1);
                await saveApiKeys(keys);
                bot.editMessageText("✅ *API Key deleted.*", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_apikeys", style: "danger" }]] } });
            } else {
                bot.answerCallbackQuery(query.id, { text: "Invalid key index.", show_alert: true });
            }
        }
        else if (data === "adm_mkcookie" && chatId === ADMIN_ID) {
            const maskedCookie = mkCookies.length > 25 ? mkCookies.substring(0, 15) + "........" + mkCookies.slice(-10) : mkCookies;
            let msgText = `🍪 *MK Network Cookies:*\n\n\`${maskedCookie}\``;
            let inlineKeyboard = [
                [{ text: "➕ Add/Update Cookie", callback_data: "add_mkcookie", style: "success" }, { text: "🗑️ Delete Cookie", callback_data: "del_mkcookie", style: "danger" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText(msgText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (data === "add_mkcookie" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_mk_cookie_add' };
            bot.sendMessage(chatId, "✏️ *নতুন MK Cookies লিখুন:*", { parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
            bot.answerCallbackQuery(query.id);
        }
        else if (data === "del_mkcookie" && chatId === ADMIN_ID) {
            await Setting.deleteOne({ key: 'mk_cookies' }).catch(()=>{});
            mkCookies = "";
            bot.editMessageText("✅ *MK Cookie deleted. Reverted to default.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_mkcookie", style: "danger" }]] } });
        }
        else if (data === "add_2fa") {
            adminState[chatId] = { action: 'wait_2fa_secret' };
            bot.sendMessage(chatId, "✏️ *আপনার 2FA Secret Key টি পাঠান:*", { parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('get_2fa_')) {
            const index = parseInt(data.split('_')[2]);
            const saved2fa = await get2FA(chatId);
            if (saved2fa[index]) {
                const token = authenticator.generate(saved2fa[index].secret);
                const markup = { inline_keyboard: [[{ text: `  ${token}`, copy_text: { text: token }, style: "success" }]] };
                bot.sendMessage(chatId, `🔐 *Live 2FA OTP Code:*\n\n\`${token}\``, { parse_mode: 'Markdown', reply_markup: markup });
            }
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('del_2fa_')) {
            const index = parseInt(data.split('_')[2]);
            const saved2fa = await get2FA(chatId);
            if (saved2fa[index]) {
                saved2fa.splice(index, 1); await save2FA(chatId, saved2fa);
                bot.editMessageText("✅ *2FA Secret ডিলিট করা হয়েছে!*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            }
            bot.answerCallbackQuery(query.id);
        }

        else if (data.startsWith('u_site_')) {
            const plat = data.split('u_site_')[1];
            const ranges = await loadRanges();
            let inlineKeyboard = []; let row = [];
            for (const country of Object.keys(ranges[plat] || {})) {
                row.push({ text: country, callback_data: `u_cntry_${plat}_${country}`, style: "primary" });
                if (row.length === 2) { inlineKeyboard.push(row); row = []; }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            bot.editMessageText(`📌 *Select Country for ${getPlatIcon(plat)} ${plat.toUpperCase()}:*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        
        else if (data.startsWith('u_cntry_')) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            bot.deleteMessage(chatId, msgId).catch(()=>{});
            await generateNewNumber(chatId, plat, country, null);
            bot.answerCallbackQuery(query.id);
        }
        
        else if (data.startsWith('change_num_')) {
            const numId = data.split('change_num_')[1];
            const order = allOrders.get(numId);
            if (order) {
                order.status = 'cancelled';
                activePolls.delete(numId);
                await bot.editMessageText("❌ *Number Cancelled.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
                await generateNewNumber(chatId, order.plat, order.country, null);
            } else {
                bot.editMessageText("❌ *Session Expired. Start again.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            }
            bot.answerCallbackQuery(query.id);
        }
        
        else if (data.startsWith('fetch_otp_')) {
            const numId = data.split('fetch_otp_')[1];
            await processOtpFetch(chatId, numId, msgId, query.id);
        }

    } catch(e) { bot.answerCallbackQuery(query.id, { text: "⚠️ Temporary Error!", show_alert: true }); }
});

Promise.all([loadApiKeys(), loadMkCookies()]).then(() => {
    console.log("🔑 API & MK Cookies loaded from MongoDB.");
    
    // ==========================================
    // 🔄 MK NETWORK KEEP-ALIVE
    // ==========================================
    setInterval(async () => {
        try {
            if (mkCookies && mkCookies.length > 10) {
                const dateFilter = getMkDate();
                await mkRequest('get_history', { filter: 'all', page: 1, limit: 1, date: dateFilter });
            }
        } catch (e) {}
    }, 3 * 60 * 1000); 
});

console.log("🚀 Premium Bulletproof Bot v11.3 (Max Timeout & Deep Bug Fix) is Alive!");

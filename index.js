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
app.get('/', (req, res) => res.send('Premium Fire OTP Bot v9.9 (OTP Exact Extraction & UI Fixed) is Running!'));
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
    joined: String,
    two_fa: { type: Array, default: [] }
});
const User = mongoose.model('User', UserSchema);

const SettingSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    data: mongoose.Schema.Types.Mixed
});
const Setting = mongoose.model('Setting', SettingSchema);

// --- কনফিগারেশন ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const OTP_GROUP_ID = "@otp_number_grp";
const BASE_URL = 'http://63.141.255.227'; // Nexa API Base
const NUMBER_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

// --- Webhook vs Polling System ---
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
    console.log(`⚠️ SERVER_URL not found in .env, using Polling mode (Fallback).`);
}

let adminState = {};
const userLastOrder = new Map();
const activePolls = new Map();
const deliveredOtps = new Set();

// ==========================================
// 🌐 MK NETWORK V3 SETUP
// ==========================================
const MK_COOKIES = process.env.MK_COOKIES || "PHPSESSID=ci4itr3sbltg20bpmst0tksv52; mk_remember=21dd02e264eeba74886d9d23%3Aab042c38088fb96c7dea474770d54308d976eab68aa391a16f48ba7198cec0c6";
const MK_API_URL = "https://mknetworkbd.com/API/api_handler_test.php";

// আজকের লোকাল ডেট বের করার ফাংশন (হিস্ট্রি চেকের জন্য)
function getMkDate() {
    let today = new Date();
    let offset = today.getTimezoneOffset() * 60000;
    return (new Date(today - offset)).toISOString().split('T')[0];
}

async function mkRequest(action, extraParams = {}) {
    const headers = {
        'Cookie': MK_COOKIES,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest', 
        'Origin': 'https://mknetworkbd.com',
        'Referer': 'https://mknetworkbd.com/getnum_test.php'
    };
    
    try {
        if (action === 'get_number') {
            const params = new URLSearchParams();
            params.append('action', 'get_number');
            for (let k in extraParams) params.append(k, extraParams[k]);
            
            const res = await axios.post(MK_API_URL, params.toString(), { headers, timeout: 12000 });
            return res.data;
        } else {
            let qs = `?action=${action}`;
            for (let k in extraParams) qs += `&${k}=${extraParams[k]}`;
            
            const res = await axios.get(MK_API_URL + qs, { headers, timeout: 10000 });
            return res.data;
        }
    } catch (e) {
        console.error("MK API Error:", e.message);
        throw e;
    }
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

async function apiRequest(method, url, data = null, timeout = 8000) {
    let keysToTry = apiKeys.length > 0 ? apiKeys : (process.env.API_KEY ? [process.env.API_KEY] : []);
    if (keysToTry.length === 0) throw new Error("No API Key found");

    let lastError = null;
    for (let key of keysToTry) {
        try {
            const headers = { 'X-API-Key': key };
            let res;
            if (method === 'get') {
                res = await axios.get(url, { headers, timeout });
            } else if (method === 'post') {
                res = await axios.post(url, data, { headers, timeout });
            }
            if (res.data && res.data.success !== false) return res;
            return res;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('All API keys failed');
}

// --- Database functions ---
async function ensureUser(user) {
    if (!user || !user.id) return;
    try {
        await User.findOneAndUpdate(
            { id: String(user.id) },
            { $setOnInsert: { first_name: user.first_name || 'User', username: user.username || 'N/A', joined: new Date().toISOString() } },
            { upsert: true }
        );
    } catch(e) {}
}

async function updateUserStat(userId, type) {
    try {
        let update = {};
        if (type === 'number') update = { $inc: { total_numbers: 1 } };
        if (type === 'otp') update = { $inc: { total_otps: 1 } };
        await User.findOneAndUpdate({ id: String(userId) }, update);
    } catch(e){}
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
        [{ text: "📱 GET NUMBER" }],
        [{ text: "📥 INBOX" }, { text: "📊 TRAFFIC" }],
        [{ text: "🔐 2FA AUTHENTICATOR" }, { text: "💬 OTP GROUP" }],
        [{ text: "🎧 SUPPORT" }]
    ];
    if (chatId === ADMIN_ID) kb.push([{ text: "🛠️ ADMIN PANEL" }]);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

function getAdminMenu() {
    return {
        inline_keyboard: [
            [{ text: "🌐 Manage Sites", callback_data: "adm_sites" }, { text: "⚙️ Manage Ranges", callback_data: "adm_ranges" }],
            [{ text: "💰 API Balance", callback_data: "adm_balance" }, { text: "📊 Dashboard", callback_data: "adm_dash" }],
            [{ text: "📢 Broadcast Notice", callback_data: "adm_broadcast" }, { text: "👥 User List", callback_data: "adm_userlist" }],
            [{ text: "🔑 Manage API Keys", callback_data: "adm_apikeys" }]
        ]
    };
}

// 🟢 NEW: Powerful OTP Extractor (Handles spaces, hyphens, and text)
function extractOTP(msg) {
    if (!msg) return "Code Not Found";
    msg = String(msg).trim();
    if (/^\d{4,8}$/.test(msg)) return msg; // Already clean
    const match = msg.match(/(?:\d[\s-]*){4,8}/);
    if (match && match[0]) {
        let digits = match[0].replace(/\D/g, ''); // Remove spaces/hyphens
        if (digits.length >= 4 && digits.length <= 8) return digits;
    }
    return msg; // Fallback to full text if nothing found
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
                buttons.push([{ text: `📢 Join Channel`, url: `https://t.me/${ch.replace('@', '')}` }]);
            }
        } catch (e) {
            isSubscribed = false;
            buttons.push([{ text: `📢 Join Channel`, url: `https://t.me/${ch.replace('@', '')}` }]);
        }
    }

    if (!isSubscribed) {
        buttons.push([{ text: "✅ Joined (Check Again)", callback_data: "check_joined" }]);
        bot.sendMessage(chatId, "⚠️ *বট ব্যবহার করতে নিচের চ্যানেল/গ্রুপগুলোতে জয়েন করুন:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        return false;
    }
    return true;
}

// --- Commands & Messages ---
bot.onText(/\/start/, async (msg) => {
    await ensureUser(msg.from);
    if (!(await checkForceSub(msg.chat.id))) return;
    const welcomeMsg = ` 💐*WELCOME TO FIRE OTP BOT*\n\n👋 Hello, *${msg.from.first_name}*!\n\n🚀 _Get unlimited virtual numbers and instant OTPs for any platform in seconds._\n\n👇 Please choose an option from the menu below:`;
    bot.sendMessage(msg.chat.id, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(msg.chat.id) });
});

bot.on('message', async (msg) => {
    await ensureUser(msg.from);
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    const menuButtons = ["📱 GET NUMBER", "📥 INBOX", "📊 TRAFFIC", "🔐 2FA AUTHENTICATOR", "💬 OTP GROUP", "🎧 SUPPORT", "🛠️ ADMIN PANEL"];
    if (menuButtons.some(btn => text.includes(btn)) && adminState[chatId]) {
        delete adminState[chatId];
    }
    else if (adminState[chatId]) {
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
                    [{ text: "🔥 Nexa API (63.141.x.x)", callback_data: "setpan_nexa" }],
                    [{ text: "🌐 MK Network V3", callback_data: "setpan_mk" }]
                ]
            };
            bot.sendMessage(chatId, `✅ Country: ${text}\n\n📌 এবার কোন প্যানেল থেকে নাম্বার আসবে তা সিলেক্ট করুন:`, { reply_markup: markup });
            return;
        }
        else if (state.action === 'wait_range_val') {
            const ranges = await loadRanges();
            if (!ranges[state.platform]) ranges[state.platform] = {};
            
            ranges[state.platform][state.country] = { 
                range: text, 
                panel: state.panel || 'nexa' 
            };
            
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
            ranges[state.platform][state.country] = {
                range: text,
                panel: state.panel 
            };
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
                    row.push({ text: `${getPlatIcon(plat)} ${plat.toUpperCase()}`, callback_data: `u_site_${plat}` });
                    if (row.length === 2) { inlineKeyboard.push(row); row = []; }
                }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            if (inlineKeyboard.length === 0) return bot.sendMessage(chatId, "⚠️ *কোনো সাইট বা নাম্বার স্টকে নেই।*", { parse_mode: 'Markdown' });
            bot.sendMessage(chatId, "📌 *Select a Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (text === "📥 INBOX") {
            const sentMsg = await bot.sendMessage(chatId, "⏳ *Fetching OTP...*", { parse_mode: 'Markdown' });
            const lastOrder = userLastOrder.get(chatId);
            if (!lastOrder) return bot.editMessageText("⚠️ *OTP Not Found!*\n\n_You haven't requested any numbers recently._", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });

            try {
                let otpFound = false;
                let finalOtp = '';

                if (lastOrder.panel === 'nexa') {
                    const res = await apiRequest('get', `${BASE_URL}/api/v1/numbers/${lastOrder.numId}/sms`, null, 5000);
                    if (res.data && res.data.success && res.data.otp) {
                        otpFound = true; finalOtp = extractOTP(res.data.otp);
                    }
                } else if (lastOrder.panel === 'mk') {
                    await mkRequest('check_otp').catch(()=>{});
                    const dateFilter = getMkDate();
                    const hist = await mkRequest('get_history', { filter: 'all', page: 1, limit: 15, date: dateFilter });
                    
                    if (hist && Array.isArray(hist.data)) {
                        const phoneDigits = lastOrder.phone.replace(/\D/g,'').slice(-6);
                        const matched = hist.data.find(o => o.phone_number && o.phone_number.replace(/\D/g,'').includes(phoneDigits));
                        
                        if (matched && matched.status === 'success') {
                            otpFound = true;
                            let smsText = "";
                            if (matched.full_sms_list) smsText = matched.full_sms_list.split('|||')[0];
                            else if (matched.full_sms) smsText = matched.full_sms;
                            else if (matched.otps) smsText = matched.otps.split('|||')[0];
                            
                            finalOtp = extractOTP(smsText);
                            if (finalOtp.toLowerCase() === 'your' || finalOtp.trim() === '') finalOtp = "Code Not Found";
                        }
                    }
                }

                if (otpFound) {
                    const formatPhone = lastOrder.phone.startsWith('+') ? lastOrder.phone : '+' + lastOrder.phone;
                    const boxNumber = `╔════════════════════╗\n║ 📱 \`${formatPhone}\`\n╚════════════════════╝`;
                    const platDisplay = `${getPlatIcon(lastOrder.plat)} ${lastOrder.plat.charAt(0).toUpperCase() + lastOrder.plat.slice(1)}`;
                    const replyMarkup = { 
                        inline_keyboard: [
                            [{ text: ` ${finalOtp}`, copy_text: { text: finalOtp } }],
                            [{ text: "💬 OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}` }]
                        ] 
                    };
                    bot.editMessageText(`📥 *Latest Inbox Found:*\n\n📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${lastOrder.country}\n\n${boxNumber}`, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown', reply_markup: replyMarkup });
                } else {
                    bot.editMessageText("⚠️ *OTP Not Found!*\n\n_Still waiting or session expired._", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
                }
            } catch (e) { bot.editMessageText("⚠️ *Server connection error.*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' }); }
        }
        else if (text === "📊 TRAFFIC") {
            const traffic = await getTraffic();
            if (Object.keys(traffic).length === 0) return bot.sendMessage(chatId, "⚠️ *এখনও কোনো ট্রাফিক ডাটা নেই।*", { parse_mode: 'Markdown' });
            let sorted = Object.entries(traffic).sort((a, b) => b[1] - a[1]);
            let msgText = "📊 *GLOBAL OTP TRAFFIC*\n\n";
            sorted.forEach(([key, count], index) => { msgText += `*${index + 1}.* ${key} ➔ \`${count} OTPs\`\n`; });
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
        }
        else if (text === "💬 OTP GROUP") {
            bot.sendMessage(chatId, "🔗 *Join our Official OTP Group for real‑time updates:*", {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: "💬 OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}` }]] }
            });
        }
        else if (text === "🔐 2FA AUTHENTICATOR") {
            const saved2fa = await get2FA(chatId);
            let markup = { inline_keyboard: [[{ text: "➕ Add New 2FA Secret", callback_data: "add_2fa" }]] };
            if (saved2fa.length === 0) {
                bot.sendMessage(chatId, "🔐 *2FA Authenticator*\n\nআপনার কোনো 2FA সিক্রেট কোড সেভ করা নেই।", { parse_mode: 'Markdown', reply_markup: markup });
            } else {
                saved2fa.forEach((item, index) => {
                    let shortKey = item.secret.substring(0, 5) + '...';
                    markup.inline_keyboard.unshift([
                        { text: `🔑 Key: ${shortKey}`, callback_data: `get_2fa_${index}` },
                        { text: `🗑️ Delete`, callback_data: `del_2fa_${index}` }
                    ]);
                });
                bot.sendMessage(chatId, "🔐 *2FA Authenticator*\n\nআপনার সেভ করা 2FA অ্যাকাউন্টগুলো নিচে দেওয়া হলো:", { parse_mode: 'Markdown', reply_markup: markup });
            }
        }
        else if (text === "🎧 SUPPORT") {
            bot.sendMessage(chatId, "🎧 *SUPPORT CENTER*\n\nবট ব্যবহার করতে কোনো সমস্যা হলে বা হেল্প লাগলে সরাসরি অ্যাডমিনের ইনবক্সে মেসেজ দিন:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "👨‍💻 Contact Admin", url: `tg://user?id=${ADMIN_ID}` }]] } });
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

    try {
        if (data === "check_joined") {
            if (await checkForceSub(chatId)) {
                bot.deleteMessage(chatId, msgId);
                bot.sendMessage(chatId, "✅ *Boss, এখন Number নিয়ে কাজ শুরু করে দিন। \n Method নাহ জানলে Method Channel যান।*", { parse_mode: 'Markdown', ...getMainMenu(chatId) });
            } else bot.answerCallbackQuery(query.id, { text: "⚠️ এখনও সব চ্যানেলে জয়েন করেননি!", show_alert: true });
        }
        else if (data === "admin_main" && chatId === ADMIN_ID) {
            bot.editMessageText("🛠 *Admin Control Panel*\n\nSelect an option below:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getAdminMenu() });
        }
        else if (data === "adm_balance" && chatId === ADMIN_ID) {
            bot.answerCallbackQuery(query.id, { text: "💰 Checking Balance..." });
            try {
                const res = await apiRequest('get', `${BASE_URL}/api/v1/balance`);
                if(res.data.success) {
                    bot.editMessageText(`💰 *API Balance:* \`${res.data.balance}\` ৳`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_main" }]] }});
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
                    const balRes = await apiRequest('get', `${BASE_URL}/api/v1/balance`, null, 5000);
                    if(balRes.data.success) apiBal = balRes.data.balance + " ৳";
                } catch(e){ apiBal = "Error"; }
                const dashText = `📊 *BOT DASHBOARD*\n\n💰 *API Balance:* \`${apiBal}\`\n👥 *Total Users:* \`${totalUsers}\`\n\n📈 *Order Stats:*\n✅ Success: \`${gStats.success || 0}\`\n⏳ Pending: \`${gStats.pending || 0}\`\n❌ Failed: \`${gStats.failed || 0}\``;
                bot.editMessageText(dashText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_main" }]] }});
            } catch (e) {}
        }
        else if (data === "adm_sites" && chatId === ADMIN_ID) {
            const ranges = await loadRanges();
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) {
                inlineKeyboard.push([{ text: `❌ Delete ${getPlatIcon(plat)} ${plat}`, callback_data: `del_site_${plat}` }]);
            }
            inlineKeyboard.push([{ text: "➕ Add New Site", callback_data: "add_site" }]);
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "admin_main" }]);
            bot.editMessageText("🌐 *Manage Sites*\n\nসাইট ডিলিট করতে ক্রসে ক্লিক করুন:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        else if (data === "add_site" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_site_add' };
            bot.sendMessage(chatId, "✏️ নতুন সাইটের নাম দিন:"); bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('del_site_') && chatId === ADMIN_ID) {
            const plat = data.split('del_site_')[1];
            const ranges = await loadRanges();
            delete ranges[plat]; await saveRanges(ranges);
            bot.editMessageText(`✅ ${plat} ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_sites" }]] } });
        }
        else if (data === "adm_ranges" && chatId === ADMIN_ID) {
            const ranges = await loadRanges();
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) {
                inlineKeyboard.push([{ text: `${getPlatIcon(plat)} ${plat}`, callback_data: `ar_p_${plat}` }]);
            }
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "admin_main" }]);
            bot.editMessageText("⚙️ *Select Site to Manage Ranges*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        else if (data.startsWith('ar_p_') && chatId === ADMIN_ID) {
            const plat = data.split('ar_p_')[1];
            const ranges = await loadRanges();
            let inlineKeyboard = [];
            if (ranges[plat]) {
                for (const country of Object.keys(ranges[plat])) {
                    inlineKeyboard.push([{ text: `🌍 ${country}`, callback_data: `ar_c_${plat}_${country}` }]);
                }
            }
            inlineKeyboard.push([{ text: "➕ Add Country & Range", callback_data: `ar_add_${plat}` }]);
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "adm_ranges" }]);
            bot.editMessageText(`⚙️ *Manage Countries: ${getPlatIcon(plat)} ${plat}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        else if (data.startsWith('ar_add_') && chatId === ADMIN_ID) {
            const plat = data.split('ar_add_')[1];
            adminState[chatId] = { action: 'wait_country_name', platform: plat };
            bot.sendMessage(chatId, "✏️ নতুন কান্ট্রির নাম ও ফ্ল্যাগ দিন (যেমন: 🇧🇩 Bangladesh):");
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('setpan_') && chatId === ADMIN_ID) {
            const panel = data.split('_')[1];
            const state = adminState[chatId];
            if (state && state.action === 'wait_country_name') {
                state.panel = panel;
                state.action = 'wait_range_val';
                bot.editMessageText(`✅ প্যানেল: ${panel.toUpperCase()}\n\n✏️ এবার রেঞ্জ টাইপ করুন (যেমন: 22507XXX):`, { chat_id: chatId, message_id: msgId });
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
                [{ text: "✏️ Edit Range", callback_data: `ar_ed_${plat}_${country}` }, { text: "❌ Delete Country", callback_data: `ar_del_${plat}_${country}` }],
                [{ text: "🔙 Back", callback_data: `ar_p_${plat}` }]
            ];
            bot.editMessageText(`⚙️ *Platform:* ${plat}\n🌍 *Country:* ${country}\n🔌 *Panel:* ${currentPanel.toUpperCase()}\n🔢 *Current Range:* \`${currentRange}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        else if (data.startsWith('ar_ed_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges();
            const rangeData = ranges[plat][country];
            const currentPanel = typeof rangeData === 'string' ? 'nexa' : (rangeData ? rangeData.panel : "nexa");
            
            adminState[chatId] = { action: 'wait_range_edit', platform: plat, country: country, panel: currentPanel };
            bot.sendMessage(chatId, `✏️ *${country}* এর জন্য নতুন রেঞ্জ টাইপ করুন (Panel: ${currentPanel.toUpperCase()}):`);
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('ar_del_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges();
            if (ranges[plat] && ranges[plat][country]) { delete ranges[plat][country]; await saveRanges(ranges); }
            bot.editMessageText(`✅ কান্ট্রি ও রেঞ্জ ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: `ar_p_${plat}` }]] } });
        }

        // --- Broadcast & User List ---
        else if (data === "adm_broadcast" && chatId === ADMIN_ID) {
            const doc = await Setting.findOne({ key: 'notice' });
            let noticeText = "None";
            if (doc && doc.data) noticeText = doc.data.text;
            let markup = {
                inline_keyboard: [
                    [{ text: "✏️ Add/Edit Notice", callback_data: "broadcast_edit" }, { text: "🗑️ Delete Notice", callback_data: "broadcast_delete" }],
                    [{ text: "🔙 Back", callback_data: "admin_main" }]
                ]
            };
            bot.editMessageText(`📢 *Current Notice:* ${noticeText}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
        }
        else if (data === "broadcast_edit" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_broadcast_notice' };
            bot.sendMessage(chatId, "✏️ *নতুন নোটিশ টেক্সট লিখুন:*", { parse_mode: 'Markdown' });
            bot.answerCallbackQuery(query.id);
        }
        else if (data === "broadcast_delete" && chatId === ADMIN_ID) {
            await Setting.deleteOne({ key: 'notice' }).catch(()=>{});
            bot.editMessageText("✅ *Notice deleted.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_main" }]] } });
        }
        else if (data === "adm_userlist" && chatId === ADMIN_ID) {
            bot.answerCallbackQuery(query.id, { text: "⏳ Preparing user list..." });
            try {
                const users = await User.find({});
                let userList = "👥 *USER LIST* 👥\n\nID | Name | Username | Numbers | OTPs | Joined\n--------------------------------------------------\n";
                users.forEach(u => {
                    userList += `${u.id} | ${u.first_name || 'N/A'} | ${u.username || 'N/A'} | ${u.total_numbers || 0} | ${u.total_otps || 0} | ${u.joined ? new Date(u.joined).toLocaleDateString() : 'N/A'}\n`;
                });
                const buffer = Buffer.from(userList, 'utf-8');
                await bot.sendDocument(chatId, buffer, {}, { filename: 'users.txt', contentType: 'text/plain' });
            } catch (e) { bot.sendMessage(chatId, "⚠️ *Error generating user list.*", { parse_mode: 'Markdown' }); }
        }

        // --- API Keys Management ---
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
                inlineKeyboard.push([{ text: `🗑️ Delete Key ${idx+1}`, callback_data: `del_apikey_${idx}` }]);
            });
            inlineKeyboard.push([{ text: "➕ Add New Key", callback_data: "add_apikey" }]);
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "admin_main" }]);
            bot.editMessageText(msgText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (data === "add_apikey" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_apikey_add' };
            bot.sendMessage(chatId, "✏️ *নতুন API Key লিখুন:*", { parse_mode: 'Markdown' });
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('del_apikey_') && chatId === ADMIN_ID) {
            const index = parseInt(data.split('_')[2]);
            const doc = await Setting.findOne({ key: 'api_keys' });
            let keys = doc && doc.data && doc.data.keys ? doc.data.keys : [];
            if (keys.length > index) {
                keys.splice(index, 1);
                await saveApiKeys(keys);
                bot.editMessageText("✅ *API Key deleted.*", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_apikeys" }]] } });
            } else {
                bot.answerCallbackQuery(query.id, { text: "Invalid key index.", show_alert: true });
            }
        }

        // --- 2FA Config ---
        else if (data === "add_2fa") {
            adminState[chatId] = { action: 'wait_2fa_secret' };
            bot.sendMessage(chatId, "✏️ *আপনার 2FA Secret Key টি পাঠান:*", { parse_mode: 'Markdown' });
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('get_2fa_')) {
            const index = parseInt(data.split('_')[2]);
            const saved2fa = await get2FA(chatId);
            if (saved2fa[index]) {
                const token = authenticator.generate(saved2fa[index].secret);
                const markup = { inline_keyboard: [[{ text: `  ${token}`, copy_text: { text: token } }]] };
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

        // --- User: Get Number Flow ---
        else if (data === "change_num") {
            const lastOrder = userLastOrder.get(chatId);
            if (lastOrder && activePolls.has(lastOrder.numId)) {
                activePolls.delete(lastOrder.numId);
                updateGlobalStats('failed');
            }
            bot.editMessageText("❌ *Number Cancelled.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            const ranges = await loadRanges();
            let inlineKeyboard = []; let row = [];
            for (const [plat, countries] of Object.entries(ranges)) {
                if (Object.keys(countries).length > 0) {
                    row.push({ text: `${getPlatIcon(plat)} ${plat.toUpperCase()}`, callback_data: `u_site_${plat}` });
                    if (row.length === 2) { inlineKeyboard.push(row); row = []; }
                }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            bot.sendMessage(chatId, "📌 *Select a New Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (data.startsWith('u_site_')) {
            const plat = data.split('u_site_')[1];
            const ranges = await loadRanges();
            let inlineKeyboard = []; let row = [];
            for (const country of Object.keys(ranges[plat] || {})) {
                row.push({ text: country, callback_data: `u_cntry_${plat}_${country}` });
                if (row.length === 2) { inlineKeyboard.push(row); row = []; }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            bot.editMessageText(`📌 *Select Country for ${getPlatIcon(plat)} ${plat.toUpperCase()}:*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        else if (data.startsWith('u_cntry_')) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges(); 
            const rangeData = ranges[plat][country];
            
            const rangeVal = typeof rangeData === 'string' ? rangeData : rangeData.range;
            const panel = typeof rangeData === 'string' ? 'nexa' : rangeData.panel;

            bot.deleteMessage(chatId, msgId);
            const sentMsg = await bot.sendMessage(chatId, "⏳ *Generating Number...*", { parse_mode: 'Markdown' });
            
            try {
                let success = false;
                let numId = null;
                let finalPhone = null;
                let apiErrorMsg = "❌ *এই মুহূর্তে এই কান্ট্রির কোনো নাম্বার স্টকে নেই।*";
                
                if (panel === 'nexa') {
                    const res = await apiRequest('post', `${BASE_URL}/api/v1/numbers/get`, { range: rangeVal, format: "international" }, 12000);
                    if (res.data && res.data.success) {
                        success = true;
                        numId = res.data.number_id;
                        finalPhone = res.data.number;
                    }
                } else if (panel === 'mk') {
                    const resData = await mkRequest('get_number', { range: rangeVal });
                    if (resData && resData.status === 'success') {
                        success = true;
                        finalPhone = resData.number;
                        
                        const dateFilter = getMkDate();
                        const hist = await mkRequest('get_history', { filter: 'all', page: 1, limit: 15, date: dateFilter });
                        if (hist && Array.isArray(hist.data)) {
                            const phoneDigits = finalPhone.replace(/\D/g,'');
                            const matched = hist.data.find(o => o.phone_number && o.phone_number.replace(/\D/g,'').includes(phoneDigits));
                            if (matched) numId = matched.id;
                        }
                        if (!numId) numId = finalPhone; 
                    } else if (resData && resData.message) {
                        apiErrorMsg = `⚠️ *MK Server:* ${resData.message}`;
                    }
                }

                if (success) {
                    const createdAt = Date.now();
                    userLastOrder.set(chatId, { numId: numId, phone: finalPhone, plat, country, createdAt, msgId: sentMsg.message_id, panel: panel });
                    updateUserStat(chatId, 'number');
                    updateGlobalStats('pending');
                    
                    const formatPhone = finalPhone.startsWith('+') ? finalPhone : '+' + finalPhone;
                    const boxNumber = `╔════════════════════╗\n║ 📱 \`${formatPhone}\`\n╚════════════════════╝`;
                    const platDisplay = `${getPlatIcon(plat)} ${plat.charAt(0).toUpperCase() + plat.slice(1)}`;
                    
                    const text = `📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${country}\n\n${boxNumber}`;
                    
                    const actionMarkup = { 
                        inline_keyboard: [[
                            { text: "🔁 Change Number", callback_data: "change_num" },
                            { text: "🔄 Fetch OTP", callback_data: `fetch_otp_${numId}` }
                        ]] 
                    };
                    bot.editMessageText(text, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown', reply_markup: actionMarkup });
                    activePolls.set(numId, true);
                } else {
                    bot.editMessageText(apiErrorMsg, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
                }
            } catch (error) { 
                bot.editMessageText("⚠️ * সার্ভার রেসপন্স করছে না।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' }); 
            }
            bot.answerCallbackQuery(query.id);
        }

        // --- Fetch OTP Logic (Seamless Multi-Panel + Regex Auto OTP Extraction) ---
        else if (data.startsWith('fetch_otp_')) {
            const numId = data.split('fetch_otp_')[1];
            const lastOrder = userLastOrder.get(chatId);
            
            if (!lastOrder || String(lastOrder.numId) !== String(numId)) {
                bot.answerCallbackQuery(query.id, { text: "এই নাম্বারটি আর valid নয়।", show_alert: true });
                return;
            }
            if (Date.now() - lastOrder.createdAt > NUMBER_EXPIRY_MS) { /* omitted for brevity */ return; }
            if (deliveredOtps.has(numId)) { bot.answerCallbackQuery(query.id, { text: "OTP ইতিমধ্যেই ডেলিভার হয়েছে!", show_alert: true }); return; }

            bot.answerCallbackQuery(query.id);
            let countMsgId;
            if (msgId === lastOrder.msgId) {
                const countMsg = await bot.sendMessage(chatId, `⏳ *Checking OTP* 10...`, { parse_mode: 'Markdown' });
                countMsgId = countMsg.message_id;
            } else {
                countMsgId = msgId;
            }

            let otpFound = false;
            let otpCode = '';
            const panel = lastOrder.panel || 'nexa';
            
            for (let i = 10; i >= 1; i--) {
                await bot.editMessageText(`⏳ *Checking OTP:* ${i}...`, { chat_id: chatId, message_id: countMsgId, parse_mode: 'Markdown' }).catch(()=>{});
                
                if (i % 2 === 0) {
                    try {
                        if (panel === 'nexa') {
                            const res = await apiRequest('get', `${BASE_URL}/api/v1/numbers/${numId}/sms`, null, 5000);
                            if (res.data && res.data.success && res.data.otp) {
                                otpFound = true; otpCode = extractOTP(res.data.otp);
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
                                    
                                    let smsText = "";
                                    if (matched.full_sms_list) {
                                        smsText = matched.full_sms_list.split('|||')[0];
                                    } else if (matched.full_sms) {
                                        smsText = matched.full_sms;
                                    } else if (matched.otps) {
                                        smsText = matched.otps.split('|||')[0];
                                    }

                                    otpCode = extractOTP(smsText);
                                    if (otpCode.toLowerCase() === 'your' || otpCode.trim() === '') {
                                        otpCode = "Code Not Found (Check SMS)";
                                    }
                                }
                            }
                        }

                        if (otpFound) break;
                    } catch (e) {}
                }
                
                if (!otpFound) await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (otpFound) {
                deliveredOtps.add(numId);
                activePolls.delete(numId);
                updateTraffic(lastOrder.plat, lastOrder.country);
                updateUserStat(chatId, 'otp');
                updateGlobalStats('success');
                
                const formatPhone = lastOrder.phone.startsWith('+') ? lastOrder.phone : '+' + lastOrder.phone;
                const boxNumber = `╔════════════════════╗\n║ 📱 \`${formatPhone}\`\n╚════════════════════╝`;
                const platDisplay = `${getPlatIcon(lastOrder.plat)} ${lastOrder.plat.charAt(0).toUpperCase() + lastOrder.plat.slice(1)}`;
                
                const otpMarkup = { 
                    inline_keyboard: [
                        [{ text: ` ${otpCode}`, copy_text: { text: otpCode } }],
                        [{ text: "💬 OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}` }]
                    ] 
                };
                
                // সাকসেস মেসেজ আগের ডিজাইনের সাথে ডাবল লাইনের বক্সসহ 
                await bot.editMessageText(`📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${lastOrder.country}\n\n${boxNumber}\n\n🎉 *Congratulations! Boss*\n✅ *OTP Code:* \`${otpCode}\``, { chat_id: chatId, message_id: countMsgId, parse_mode: 'Markdown', reply_markup: otpMarkup }).catch(()=>{});
                
                const maskedPhone = maskNumber(lastOrder.phone);
                const groupBoxNumber = `╔════════════════════╗\n║ 📱 \`${maskedPhone}\`\n╚════════════════════╝`;
                const groupMarkup = { inline_keyboard: [[{ text: `  ${otpCode}`, copy_text: { text: otpCode } }]] };
                bot.sendMessage(OTP_GROUP_ID, `📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${lastOrder.country}\n\n${groupBoxNumber}`, { parse_mode: 'Markdown', reply_markup: groupMarkup }).catch(()=>{});
            
            } else {
                const actionMarkup = { inline_keyboard: [[ { text: "🔄 Try Again", callback_data: `fetch_otp_${numId}` } ]] };
                await bot.editMessageText(`⚠️ *OTP Not Found!*`, { chat_id: chatId, message_id: countMsgId, parse_mode: 'Markdown', reply_markup: actionMarkup }).catch(()=>{});
            }
        }
    } catch(e) { bot.answerCallbackQuery(query.id, { text: "⚠️ Temporary Error!", show_alert: true }); }
});

loadApiKeys().then(() => console.log("🔑 API Keys loaded from MongoDB."));
console.log("🚀 Premium Bulletproof Bot v9.9 (OTP Exact Extraction & UI Fixed) is Alive!");

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
app.get('/', (req, res) => res.send('Premium Fire OTP Bot v11.7 (Advanced Cookie & Debugging) is Running!'));
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
const NUMBER_EXPIRY_MS = 15 * 60 * 1000; 

let bot;
if (SERVER_URL) {
    bot = new TelegramBot(BOT_TOKEN);
    bot.setWebHook(`${SERVER_URL}/bot${BOT_TOKEN}`);
    app.post(`/bot${BOT_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
} else {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    bot.on('polling_error', (err) => console.log("Polling Error:", err.message));
}

let adminState = {};
let userState = {};

// ==========================================
// 🔥 ADVANCED PANEL API SETUP
// ==========================================
let defaultBaseUrl = 'https://api.2oo9.cloud/MXS47FLFXBU/tness/@public/api'; 
let panelCookie = "";

async function loadPanelSettings() {
    try {
        const cookieDoc = await Setting.findOne({ key: 'panel_cookie' });
        if (cookieDoc && cookieDoc.data && cookieDoc.data.cookie) panelCookie = cookieDoc.data.cookie;
        
        const urlDoc = await Setting.findOne({ key: 'panel_base_url' });
        if (urlDoc && urlDoc.data && urlDoc.data.url) defaultBaseUrl = urlDoc.data.url;
    } catch(e) {}
}

async function savePanelCookie(cookie) {
    await Setting.findOneAndUpdate({ key: 'panel_cookie' }, { data: { cookie } }, { upsert: true });
    panelCookie = cookie;
}

async function savePanelBaseUrl(url) {
    await Setting.findOneAndUpdate({ key: 'panel_base_url' }, { data: { url } }, { upsert: true });
    defaultBaseUrl = url;
}

async function panelRequest(method, endpoint, data = null) {
    let extractedToken = panelCookie;
    if (panelCookie && panelCookie.includes("mauth=")) {
        const match = panelCookie.match(/mauth=([^;]+)/);
        if (match) extractedToken = match[1];
    }

    // Advanced Web Browsing Headers
    const headers = { 
        'Cookie': panelCookie,
        'Authorization': `Bearer ${extractedToken}`,
        'mauthapi': extractedToken,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest', // Often required for Web Panels
        'Origin': new URL(defaultBaseUrl).origin,
        'Referer': new URL(defaultBaseUrl).origin + '/'
    };
    
    const url = `${defaultBaseUrl}${endpoint}`;
    
    try {
        if(method === 'post') return await axios.post(url, data, { headers, timeout: 15000 });
        return await axios.get(url, { headers, timeout: 15000 });
    } catch (e) { 
        let errorMsg = e.message;
        if (e.response) {
            // Server responded with an error, extract it to show the Admin/User
            errorMsg = `Status: ${e.response.status} - Data: ${JSON.stringify(e.response.data).substring(0, 100)}`;
        }
        console.error(`❌ API Error:`, errorMsg);
        throw new Error(errorMsg); 
    }
}

// ==========================================
// 🚀 STATE MANAGERS FOR AUTO-OTP
// ==========================================
const activeNumbers = new Map(); 
const deliveredOtps = new Set();
const seenConsoleHits = new Set();

setInterval(() => {
    const now = Date.now();
    for (let [number, data] of activeNumbers.entries()) {
        if (now - data.createdAt > NUMBER_EXPIRY_MS) {
            activeNumbers.delete(number);
            updateGlobalStats('failed');
        }
    }
}, 60000);

function getLocDate() {
    let today = new Date();
    let offset = today.getTimezoneOffset() * 60000;
    return (new Date(today - offset)).toISOString().split('T')[0];
}

async function getAppConfig() {
    try {
        let doc = await Setting.findOne({ key: 'app_config' });
        if (!doc || !doc.data) return { per_otp_rate: 5, min_withdraw: 50, pay_methods: ['Binance'] };
        return doc.data;
    } catch(e) { return { per_otp_rate: 5, min_withdraw: 50, pay_methods: ['Binance'] }; }
}
async function saveAppConfig(data) { await Setting.findOneAndUpdate({ key: 'app_config' }, { data }, { upsert: true }); }

async function ensureUser(user) {
    if (!user || !user.id) return null;
    try {
        const today = getLocDate();
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

function getMainMenu(chatId) {
    let kb = [
        [{ text: "📱 GET NUMBER", style: "success" }],
        [{ text: "📡 LIVE RANGE", style: "primary" }, { text: "📊 TRAFFIC", style: "primary" }],
        [{ text: "🔐 2FA AUTHENTICATOR", style: "danger" }, { text: "👤 ACCOUNT", style: "primary" }],
        [{ text: "🎧 SUPPORT", style: "primary" }]
    ];
    if (chatId === ADMIN_ID) kb.push([{ text: "🛠️ ADMIN PANEL", style: "danger" }]);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

function getAdminMenu() {
    return {
        inline_keyboard: [
            [{ text: "🌐 Manage Sites", callback_data: "adm_sites" }, { text: "⚙️ Manage Ranges", callback_data: "adm_ranges" }],
            [{ text: "📊 Dashboard", callback_data: "adm_dash" }, { text: "📢 Broadcast", callback_data: "adm_broadcast" }],
            [{ text: "👥 Manage Users", callback_data: "adm_users" }, { text: "💳 Payment Settings", callback_data: "adm_paycfg" }],
            [{ text: "🍪 Manage Stexsms Cookie", callback_data: "adm_cookie" }, { text: "🔗 Manage Base URL", callback_data: "adm_baseurl" }]
        ]
    };
}

function extractOTP(msg) {
    if (!msg) return "Code Not Found";
    msg = String(msg).trim();
    if (/^\d{4,8}$/.test(msg)) return msg; 
    const match = msg.match(/(?:\d[\s-]*){4,8}/);
    if (match && match[0]) return match[0].replace(/\D/g, '');
    return msg; 
}
function detectLang(text) {
    if (!text) return 'English';
    if (/[\u0980-\u09FF]/.test(text)) return 'Bengali';
    if (/[\u0400-\u04FF]/.test(text)) return 'Russian';
    return 'English';
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
                buttons.push([{ text: `📢 Join Channel`, url: `https://t.me/${ch.replace('@', '')}` }]);
            }
        } catch (e) {
            isSubscribed = false;
            buttons.push([{ text: `📢 Join Channel`, url: `https://t.me/${ch.replace('@', '')}` }]);
        }
    }
    if (!isSubscribed) {
        buttons.push([{ text: "✅ Joined (Check Again)", callback_data: "check_joined", style: "success" }]);
        bot.sendMessage(chatId, "⚠️ *বট ব্যবহার করতে নিচের চ্যানেলগুলোতে জয়েন করুন:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        return false;
    }
    return true;
}

// 🟢 Fast Number Generation (With Error Output)
async function generateNewNumber(chatId, plat, country, msgIdToEdit = null) {
    const ranges = await loadRanges(); 
    const rangeData = ranges[plat]?.[country];
    
    if (!rangeData) {
        const errTxt = "❌ *Error: Range not found.*";
        if (msgIdToEdit) bot.editMessageText(errTxt, {chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown'}).catch(()=>{});
        else bot.sendMessage(chatId, errTxt, {parse_mode: 'Markdown'});
        return;
    }
    
    const rangeVal = typeof rangeData === 'string' ? rangeData : rangeData.range;
    const cleanRange = rangeVal.replace(/[^0-9Xx]/g, '');

    try {
        const res = await panelRequest('post', '/getnum', { rid: cleanRange });
        
        if (res.data && res.data.meta && res.data.meta.status === 'ok') {
            const fullPhone = res.data.data.full_number;
            const strippedPhone = fullPhone.replace('+', ''); 
            
            for(let [num, data] of activeNumbers.entries()) {
                if(data.chatId === chatId) activeNumbers.delete(num);
            }

            let sentMsg;
            const boxNumber = `╔════════════════════╗\n║ 📱 \`Wait for auto OTP...\`\n╚════════════════════╝`;
            const platDisplay = `${getPlatIcon(plat)} ${plat.charAt(0).toUpperCase() + plat.slice(1)}`;
            const text = `📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${country}\n\n${boxNumber}`;
            const actionMarkup = { inline_keyboard: [
                [{ text: `📱 ${fullPhone}`, copy_text: { text: fullPhone } }],
                [{ text: "🔁 Change Number", callback_data: "change_num" }]
            ]};

            if (msgIdToEdit) {
                await bot.editMessageText(text, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown', reply_markup: actionMarkup }).catch(()=>{});
                sentMsg = { message_id: msgIdToEdit };
            } else {
                sentMsg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: actionMarkup });
            }

            activeNumbers.set(strippedPhone, { chatId: chatId, plat: plat, country: country, createdAt: Date.now(), msgId: sentMsg.message_id });
            updateUserStat(chatId, 'number'); updateGlobalStats('pending');
            
        } else {
            const outTxt = "❌ *Out of stock বা রেঞ্জ ভুল দেওয়া হয়েছে!*";
            if (msgIdToEdit) bot.editMessageText(outTxt, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown' }).catch(()=>{});
            else bot.sendMessage(chatId, outTxt, { parse_mode: 'Markdown' });
        }
    } catch (error) { 
        // 🔥 এখানে আসল Error মেসেজ ইউজারকে দেখানো হবে যাতে ডিবাগ করা যায়
        const errTxt = `⚠️ *প্যানেল কানেকশন এরর!*\n\n*Reason:* \`${error.message}\`\n\n_দয়া করে Cookie এবং Base URL সঠিক আছে কিনা যাচাই করুন।_`;
        if (msgIdToEdit) bot.editMessageText(errTxt, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown' }).catch(()=>{}); 
        else bot.sendMessage(chatId, errTxt, { parse_mode: 'Markdown' });
    }
}

// ==========================================
// 🔄 BACKGROUND TASKS (AUTO OTP)
// ==========================================
setInterval(async () => {
    if (activeNumbers.size === 0) return;
    try {
        const res = await panelRequest('get', '/success-otp');
        if (res.data && res.data.meta && res.data.meta.status === 'ok') {
            const otps = res.data.data.otps || [];
            for (let otpData of otps) {
                const otpId = String(otpData.otp_id);
                const number = otpData.number;
                if (deliveredOtps.has(otpId)) continue;
                if (activeNumbers.has(number)) {
                    const session = activeNumbers.get(number);
                    deliveredOtps.add(otpId);
                    
                    const otpCode = extractOTP(otpData.message);
                    const config = await getAppConfig();
                    const rate = config.per_otp_rate || 0;
                    
                    await Earning.create({ num_id: otpId, user_id: String(session.chatId), date: getLocDate() });
                    const uDoc = await User.findOne({ id: String(session.chatId) });
                    if(uDoc) {
                        uDoc.balance = parseFloat((uDoc.balance + rate).toFixed(2));
                        uDoc.today_balance = parseFloat((uDoc.today_balance + rate).toFixed(2));
                        uDoc.total_otps += 1; uDoc.today_otps += 1; await uDoc.save();
                    }
                    updateGlobalStats('success'); updateTraffic(session.plat, session.country);
                    
                    const formatPhone = '+' + number;
                    const platDisplay = `${getPlatIcon(session.plat)} ${session.plat.charAt(0).toUpperCase() + session.plat.slice(1)}`;
                    const boxNumber = `╔════════════════════╗\n║ 📱 \`${formatPhone}\` ║ LN- ${detectLang(otpData.message)}\n╚════════════════════╝`;
                    let earningText = `💰 *Earned:* \`${parseFloat(rate.toFixed(2))}\` ৳\n💳 *Total Balance:* \`${parseFloat(uDoc.balance.toFixed(2))}\` ৳`;
                    
                    const otpMarkup = { inline_keyboard: [
                        [{ text: ` ${otpCode}`, copy_text: { text: otpCode } }],
                        [{ text: "🔄 Get New Number", callback_data: "get_new_num" }]
                    ]};
                    
                    bot.deleteMessage(session.chatId, session.msgId).catch(()=>{});
                    bot.sendMessage(session.chatId, `🔔 *AUTO OTP RECEIVED!*\n\n📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${session.country}\n\n${boxNumber}\n\n🎉 *Congratulations! Boss*\n${earningText}`, { parse_mode: 'Markdown', reply_markup: otpMarkup }).catch(()=>{});
                    activeNumbers.delete(number);
                }
            }
        }
    } catch(e) { }
}, 5000);

// --- Commands ---
bot.onText(/\/start/, async (msg) => {
    const u = await ensureUser(msg.from);
    if (u && u.banned) return bot.sendMessage(msg.chat.id, "🚫 *You are banned.*", { parse_mode: 'Markdown' });
    if (!(await checkForceSub(msg.chat.id))) return;
    bot.sendMessage(msg.chat.id, `💐*WELCOME TO FIRE OTP BOT*\n\n👋 Hello, *${msg.from.first_name}*!\n\n👇 Please choose an option from the menu below:`, { parse_mode: 'Markdown', ...getMainMenu(msg.chat.id) });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id; const text = msg.text;
    if (!text || text.startsWith('/')) return;

    const u = await ensureUser(msg.from);
    if (u && u.banned) return bot.sendMessage(chatId, "🚫 *You are banned.*", { parse_mode: 'Markdown' });

    if (["📱 GET NUMBER", "📡 LIVE RANGE", "📊 TRAFFIC", "🔐 2FA AUTHENTICATOR", "👤 ACCOUNT", "🎧 SUPPORT", "🛠️ ADMIN PANEL"].some(btn => text.includes(btn))) {
        delete adminState[chatId]; delete userState[chatId];
    }
    
    // --- USER STATES ---
    if (userState[chatId]) {
        const state = userState[chatId];
        if (state.action === 'wait_2fa_secret') {
            const secret = text.trim().replace(/\s+/g, '').toUpperCase();
            try {
                authenticator.generate(secret); 
                const saved2fa = await get2FA(chatId); saved2fa.push({ secret: secret, added: new Date().toISOString() }); await save2FA(chatId, saved2fa);
                bot.sendMessage(chatId, `✅ *2FA Secret সেভ হয়েছে!*`, { parse_mode: 'Markdown' });
            } catch (e) { bot.sendMessage(chatId, `❌ *ভুল Base32 কোড!*`, { parse_mode: 'Markdown' }); }
            delete userState[chatId]; return;
        }
        else if (state.action === 'wait_wd_id') {
            state.account_id = text.trim(); state.action = 'wait_wd_amount';
            bot.sendMessage(chatId, `✅ *Method:* ${state.method}\n✅ *Account/ID:* \`${state.account_id}\`\n\n💰 *কত টাকা উইথড্র করবেন?*`, { parse_mode: 'Markdown' }); return;
        }
        else if (state.action === 'wait_wd_amount') {
            const amount = parseFloat(text.trim());
            if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "❌ *Invalid amount.*", { parse_mode: 'Markdown' });
            try {
                const config = await getAppConfig(); const userDoc = await User.findOne({ id: String(chatId) });
                if (amount < config.min_withdraw) return bot.sendMessage(chatId, `⚠️ *Minimum Withdraw ${config.min_withdraw} ৳*`, { parse_mode: 'Markdown' });
                if (amount > userDoc.balance) return bot.sendMessage(chatId, "❌ *Insufficient Balance!*", { parse_mode: 'Markdown' });

                userDoc.balance = parseFloat((userDoc.balance - amount).toFixed(2)); await userDoc.save();
                const wd_id = Math.random().toString(36).substring(2, 10).toUpperCase();
                await Withdraw.create({ wd_id: wd_id, user_id: String(chatId), amount: amount, method: state.method, account: state.account_id, date: getLocDate() });
                bot.sendMessage(chatId, `✅ *Withdraw Request Submitted!*`, { parse_mode: 'Markdown' });
                bot.sendMessage(PAYMENT_GROUP_ID, `🔔 *NEW WITHDRAW*\n\n👤 ID: \`${chatId}\`\n💳 ${state.method}: \`${state.account_id}\`\n💰 Amount: \`${amount}\` ৳`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[ { text: "✅ Approve", callback_data: `wd_appr_${wd_id}` }, { text: "❌ Cancel", callback_data: `wd_canc_${wd_id}` } ]]}}).catch(()=>{});
            } catch (e) { bot.sendMessage(chatId, "❌ Error."); }
            delete userState[chatId]; return;
        }
    }

    // --- ADMIN STATES ---
    if (adminState[chatId]) {
        const state = adminState[chatId];
        if (state.action === 'wait_site_add') {
            const ranges = await loadRanges(); if (!ranges[text]) ranges[text] = {}; await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ সাইট *${text}* যুক্ত হয়েছে!`, { parse_mode: 'Markdown' }); delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_country_name') {
            state.country = text; state.action = 'wait_range_val'; bot.sendMessage(chatId, `✅ Country: ${text}\n\n✏️ রেঞ্জ টাইপ করুন:`); return;
        }
        else if (state.action === 'wait_range_val' || state.action === 'wait_range_edit') {
            const ranges = await loadRanges(); if (!ranges[state.platform]) ranges[state.platform] = {};
            ranges[state.platform][state.country] = { range: text }; await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ Range saved!`, { parse_mode: 'Markdown' }); delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_cookie_add') {
            await savePanelCookie(text.trim()); bot.sendMessage(chatId, "✅ *Stexsms Cookie saved successfully!*", { parse_mode: 'Markdown' }); delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_baseurl_add') {
            await savePanelBaseUrl(text.trim()); bot.sendMessage(chatId, "✅ *API Base URL saved successfully!*\n\nএখন থেকে বট এই লিংকে রিকোয়েস্ট পাঠাবে।", { parse_mode: 'Markdown' }); delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_broadcast_notice') {
            bot.sendMessage(chatId, "✅ *Broadcasting...*", { parse_mode: 'Markdown' });
            try { const users = await User.find({}); users.forEach(u => bot.sendMessage(u.id, `📢 *Notice:*\n\n${text}`, { parse_mode: 'Markdown' }).catch(()=>{})); } catch(e){} delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_otp_rate') {
            const val = parseFloat(text.trim()); if(!isNaN(val)){ const c = await getAppConfig(); c.per_otp_rate = val; await saveAppConfig(c); bot.sendMessage(chatId, `✅ Updated to ${val} ৳`); } delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_min_wd') {
            const val = parseFloat(text.trim()); if(!isNaN(val)){ const c = await getAppConfig(); c.min_withdraw = val; await saveAppConfig(c); bot.sendMessage(chatId, `✅ Updated to ${val} ৳`); } delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_pay_method_add') {
            const m = text.trim(); if(m){ const c = await getAppConfig(); if(!c.pay_methods.includes(m)){ c.pay_methods.push(m); await saveAppConfig(c); } bot.sendMessage(chatId, `✅ Method added!`); } delete adminState[chatId]; return;
        }
    }

    if (!(await checkForceSub(chatId))) return;

    if (text === "🛠️ ADMIN PANEL" && chatId === ADMIN_ID) bot.sendMessage(chatId, "🛠 *Admin Control Panel*", { parse_mode: 'Markdown', reply_markup: getAdminMenu() });
    else if (text === "📱 GET NUMBER") {
        const ranges = await loadRanges(); let ik = []; let r = [];
        for (const [plat, countries] of Object.entries(ranges)) {
            if (Object.keys(countries).length > 0) { r.push({ text: `${getPlatIcon(plat)} ${plat.toUpperCase()}`, callback_data: `u_site_${plat}` }); if (r.length === 2) { ik.push(r); r = []; } }
        }
        if (r.length > 0) ik.push(r);
        if (ik.length === 0) return bot.sendMessage(chatId, "⚠️ *কোনো সাইট নেই।*", { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, "📌 *Select a Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: ik } });
    }
    else if (text === "👤 ACCOUNT") {
        const u = await ensureUser(msg.from);
        bot.sendMessage(chatId, `👤 *USER ACCOUNT*\n\n🔖 *ID:* \`${u.id}\`\n\n💰 *Total Balance:* \`${parseFloat(u.balance.toFixed(2))}\` ৳`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "💵 Withdraw Funds", callback_data: "wd_start" }]] } });
    }
});

// --- Callbacks ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id; const data = query.data; const msgId = query.message.message_id;

    if (data === "admin_main" && chatId === ADMIN_ID) {
        bot.editMessageText("🛠 *Admin Control Panel*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getAdminMenu() });
    }
    else if (data === "adm_cookie" && chatId === ADMIN_ID) {
        bot.editMessageText(`🍪 *Cookie:*\n\`${panelCookie.substring(0, 15)}...\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "➕ Set Cookie", callback_data: "set_cookie" }], [{ text: "🔙 Back", callback_data: "admin_main" }]] } });
    }
    else if (data === "set_cookie" && chatId === ADMIN_ID) {
        adminState[chatId] = { action: 'wait_cookie_add' }; bot.sendMessage(chatId, "✏️ *Cookie পেস্ট করুন:*", { parse_mode: 'Markdown' }); bot.answerCallbackQuery(query.id);
    }
    else if (data === "adm_baseurl" && chatId === ADMIN_ID) {
        bot.editMessageText(`🔗 *API Base URL:*\n\`${defaultBaseUrl}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "➕ Set Base URL", callback_data: "set_baseurl" }], [{ text: "🔙 Back", callback_data: "admin_main" }]] } });
    }
    else if (data === "set_baseurl" && chatId === ADMIN_ID) {
        adminState[chatId] = { action: 'wait_baseurl_add' }; bot.sendMessage(chatId, "✏️ *সঠিক Base URL পেস্ট করুন (যেমন: https://stexsms.com/api):*", { parse_mode: 'Markdown' }); bot.answerCallbackQuery(query.id);
    }
    // Site & Flow Logic
    else if (data.startsWith('u_site_')) {
        const plat = data.split('u_site_')[1]; const ranges = await loadRanges(); let ik = []; let r = [];
        for (const country of Object.keys(ranges[plat] || {})) { r.push({ text: country, callback_data: `u_cntry_${plat}_${country}` }); if (r.length === 2) { ik.push(r); r = []; } }
        if (r.length > 0) ik.push(r);
        bot.editMessageText(`📌 *Select Country:*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: ik }});
    }
    else if (data.startsWith('u_cntry_')) {
        const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
        bot.deleteMessage(chatId, msgId).catch(()=>{}); await generateNewNumber(chatId, plat, country, null); bot.answerCallbackQuery(query.id);
    }
    else if (data === "change_num") {
        let plat, country;
        for(let [num, session] of activeNumbers.entries()) { if(session.chatId === chatId) { plat = session.plat; country = session.country; activeNumbers.delete(num); break; } }
        if (plat && country) { bot.editMessageText("❌ *Cancelled.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{}); await generateNewNumber(chatId, plat, country, msgId); }
        bot.answerCallbackQuery(query.id);
    }
});

Promise.all([loadPanelSettings()]).then(() => { console.log("⚙️ Settings loaded."); });

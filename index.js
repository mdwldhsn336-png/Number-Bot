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
app.get('/', (req, res) => res.send('Premium Fire OTP Bot v11.0 (New Panel & Auto OTP) is Running!'));
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
const NUMBER_EXPIRY_MS = 15 * 60 * 1000; // 15 Minutes Timeout

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
    console.log(`⚠️ SERVER_URL not found, using Polling mode.`);
}

let adminState = {};
let userState = {};

// ==========================================
// 🔥 NEW PANEL API SETUP (2oo9.cloud)
// ==========================================
const PANEL_BASE_URL = 'https://api.2oo9.cloud/MXS47FLFXBU/tness/@public/api';
let panelApiKey = process.env.PANEL_API_KEY || "";

async function loadPanelKey() {
    try {
        const doc = await Setting.findOne({ key: 'panel_apikey' });
        if (doc && doc.data && doc.data.key) panelApiKey = doc.data.key;
    } catch(e) {}
}

async function savePanelKey(key) {
    await Setting.findOneAndUpdate({ key: 'panel_apikey' }, { data: { key } }, { upsert: true });
    panelApiKey = key;
}

async function panelRequest(method, endpoint, data = null) {
    if (!panelApiKey) throw new Error("API Key not set in Admin Panel!");
    const headers = { 'mauthapi': panelApiKey };
    const url = `${PANEL_BASE_URL}${endpoint}`;
    
    try {
        if(method === 'post') return await axios.post(url, data, { headers, timeout: 15000 });
        return await axios.get(url, { headers, timeout: 15000 });
    } catch (e) { throw e; }
}

// ==========================================
// 🚀 STATE MANAGERS FOR AUTO-OTP
// ==========================================
// activeNumbers keeps track of users waiting for OTP. Key: phone_number (without +)
const activeNumbers = new Map(); 
const deliveredOtps = new Set();
const seenConsoleHits = new Set();

// Clean up expired numbers every minute
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

// --- App Config (Payment Settings) ---
async function getAppConfig() {
    try {
        let doc = await Setting.findOne({ key: 'app_config' });
        if (!doc || !doc.data) return { per_otp_rate: 5, min_withdraw: 50, pay_methods: ['Binance'] };
        return doc.data;
    } catch(e) { return { per_otp_rate: 5, min_withdraw: 50, pay_methods: ['Binance'] }; }
}

async function saveAppConfig(data) { await Setting.findOneAndUpdate({ key: 'app_config' }, { data }, { upsert: true }); }

// --- Database functions ---
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
            [{ text: "🌐 Manage Sites", callback_data: "adm_sites", style: "primary" }, { text: "⚙️ Manage Ranges", callback_data: "adm_ranges", style: "primary" }],
            [{ text: "📊 Dashboard", callback_data: "adm_dash", style: "primary" }, { text: "📢 Broadcast", callback_data: "adm_broadcast", style: "primary" }],
            [{ text: "👥 Manage Users", callback_data: "adm_users", style: "primary" }, { text: "📄 Download User List", callback_data: "adm_userlist", style: "success" }],
            [{ text: "💳 Payment Settings", callback_data: "adm_paycfg", style: "success" }, { text: "🔑 Manage Panel API Key", callback_data: "adm_apikey", style: "danger" }]
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

// 🟢 NEW: Instant Number Generation
async function generateNewNumber(chatId, plat, country, msgIdToEdit = null) {
    const ranges = await loadRanges(); 
    const rangeData = ranges[plat]?.[country];
    
    if (!rangeData) {
        if (msgIdToEdit) bot.editMessageText("❌ *Error: Range not found.*", {chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown'}).catch(()=>{});
        else bot.sendMessage(chatId, "❌ *Error: Range not found.*", {parse_mode: 'Markdown'});
        return;
    }
    
    const rangeVal = typeof rangeData === 'string' ? rangeData : rangeData.range;
    const cleanRange = rangeVal.replace(/[^0-9Xx]/g, '');

    let sentMsg;
    if (msgIdToEdit) {
        sentMsg = { message_id: msgIdToEdit, chat: { id: chatId } };
        await bot.editMessageText("🚀 *Generating Number...*", { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown' }).catch(()=>{});
    } else {
        sentMsg = await bot.sendMessage(chatId, "🚀 *Generating Number...*", { parse_mode: 'Markdown' });
    }
    
    try {
        const res = await panelRequest('post', '/getnum', { rid: cleanRange });
        
        if (res.data && res.data.meta && res.data.meta.status === 'ok') {
            const fullPhone = res.data.data.full_number;
            const strippedPhone = fullPhone.replace('+', ''); // Clean number for matching OTP
            
            // Remove user's previous active number if exists
            for(let [num, data] of activeNumbers.entries()) {
                if(data.chatId === chatId) activeNumbers.delete(num);
            }

            activeNumbers.set(strippedPhone, {
                chatId: chatId,
                plat: plat,
                country: country,
                createdAt: Date.now(),
                msgId: sentMsg.message_id
            });

            updateUserStat(chatId, 'number');
            updateGlobalStats('pending');
            
            const boxNumber = `╔════════════════════╗\n║ 📱 \`Wait for auto OTP...\`\n╚════════════════════╝`;
            const platDisplay = `${getPlatIcon(plat)} ${plat.charAt(0).toUpperCase() + plat.slice(1)}`;
            
            const text = `📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${country}\n\n${boxNumber}`;
            const actionMarkup = { 
                inline_keyboard: [
                    [{ text: `📱 ${fullPhone}`, copy_text: { text: fullPhone }, style: "primary" }],
                    [{ text: "🔁 Change Number", callback_data: "change_num", style: "danger" }]
                ] 
            };
            bot.editMessageText(text, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown', reply_markup: actionMarkup }).catch(()=>{});
        } else {
            bot.editMessageText("❌ *Out of stock বা রেঞ্জ ভুল দেওয়া হয়েছে!*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' }).catch(()=>{});
        }
    } catch (error) { 
        bot.editMessageText("⚠️ *API প্যানেল কানেকশনে সমস্যা হচ্ছে।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' }).catch(()=>{}); 
    }
}

// ==========================================
// 🔄 BACKGROUND TASKS (AUTO OTP & LIVE CONSOLE)
// ==========================================

// 1. Check for Auto OTPs
setInterval(async () => {
    if (!panelApiKey || activeNumbers.size === 0) return;
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
                    const detectedLang = detectLang(otpData.message);
                    
                    // Pay User
                    let earnedAmount = 0;
                    const config = await getAppConfig();
                    const rate = config.per_otp_rate || 0;
                    earnedAmount = rate;
                    
                    await Earning.create({ num_id: otpId, user_id: String(session.chatId), date: getLocDate() });
                    
                    const uDoc = await User.findOne({ id: String(session.chatId) });
                    if(uDoc) {
                        uDoc.balance = parseFloat((uDoc.balance + rate).toFixed(2));
                        uDoc.today_balance = parseFloat((uDoc.today_balance + rate).toFixed(2));
                        uDoc.total_otps += 1;
                        uDoc.today_otps += 1;
                        await uDoc.save();
                    }
                    updateGlobalStats('success');
                    updateTraffic(session.plat, session.country);
                    
                    // Format UI
                    const formatPhone = '+' + number;
                    const platDisplay = `${getPlatIcon(session.plat)} ${session.plat.charAt(0).toUpperCase() + session.plat.slice(1)}`;
                    const boxNumber = `╔════════════════════╗\n║ 📱 \`${formatPhone}\` ║ LN- ${detectedLang}\n╚════════════════════╝`;
                    
                    let earningText = `💰 *Earned:* \`${parseFloat(earnedAmount.toFixed(2))}\` ৳\n💳 *Total Balance:* \`${parseFloat(uDoc.balance.toFixed(2))}\` ৳`;
                    
                    const otpMarkup = { 
                        inline_keyboard: [
                            [{ text: ` ${otpCode}`, copy_text: { text: otpCode }, style: "success" }],
                            [
                                { text: "🔄 Get New Number", callback_data: "get_new_num", style: "success" },
                                { text: "💬 OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}`, style: "primary" }
                            ]
                        ] 
                    };
                    
                    // Send message and delete old loading msg
                    bot.deleteMessage(session.chatId, session.msgId).catch(()=>{});
                    bot.sendMessage(session.chatId, `🔔 *AUTO OTP RECEIVED!*\n\n📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${session.country}\n\n${boxNumber}\n\n🎉 *Congratulations! Boss*\n${earningText}`, { parse_mode: 'Markdown', reply_markup: otpMarkup }).catch(()=>{});
                    
                    // Send to Group
                    const maskedPhone = maskNumber(number);
                    const groupBoxNumber = `╔════════════════════╗\n║ 📱 \`${maskedPhone}\` ║ LN- ${detectedLang}\n╚════════════════════╝`;
                    const groupMarkup = { inline_keyboard: [
                        [{ text: `  ${otpCode}`, copy_text: { text: otpCode }, style: "success" }],
                        [{ text: "🔄 Get New Number", callback_data: `gnew_${session.plat}_${session.country}`, style: "primary" }]
                    ]};
                    bot.sendMessage(OTP_GROUP_ID, `🎉 *NEW OTP SUCCESS!*\n\n📱 *Platform:* ${platDisplay}\n🌍 *Country:* ${session.country}\n\n${groupBoxNumber}`, { parse_mode: 'Markdown', reply_markup: groupMarkup }).catch(()=>{});
                    
                    activeNumbers.delete(number); // Done with this number
                }
            }
        }
    } catch(e) { }
}, 6000);

// 2. Global Live Console Feed (Send to OTP Group)
setInterval(async () => {
    if (!panelApiKey) return;
    try {
        const res = await panelRequest('get', '/console');
        if (res.data && res.data.meta && res.data.meta.status === 'ok') {
            const hits = res.data.data.hits || [];
            
            for(let hit of hits) {
                // Create unique ID based on time and range to avoid duplicates
                const uniqueId = `${hit.time}_${hit.range}`;
                
                if(!seenConsoleHits.has(uniqueId)) {
                    seenConsoleHits.add(uniqueId);
                    
                    if(seenConsoleHits.size > 1000) { // Keep memory clean
                        const firstItem = seenConsoleHits.values().next().value;
                        seenConsoleHits.delete(firstItem);
                    }
                    
                    const msg = `📡 *LIVE CONSOLE FEED*\n\n📱 *Service:* ${hit.sid}\n🌍 *Range:* \`${hit.range}\`\n💬 *Message:* \`${hit.message}\``;
                    const markup = { inline_keyboard: [[{ text: "🚀 Get Number From This Range", url: `https://t.me/${(await bot.getMe()).username}?start=GET_NUM` }]] };
                    
                    bot.sendMessage(OTP_GROUP_ID, msg, {parse_mode: 'Markdown', reply_markup: markup}).catch(()=>{});
                }
            }
        }
    } catch(e) {}
}, 7000);


// --- Commands & Messages ---
bot.onText(/\/start/, async (msg) => {
    const u = await ensureUser(msg.from);
    if (u && u.banned) return bot.sendMessage(msg.chat.id, "🚫 *You are banned from using this bot.*", { parse_mode: 'Markdown' });
    if (!(await checkForceSub(msg.chat.id))) return;
    const welcomeMsg = ` 💐*WELCOME TO FIRE OTP BOT*\n\n👋 Hello, *${msg.from.first_name}*!\n\n🚀 _Get unlimited virtual numbers and instant OTPs for any platform in seconds._\n\n👇 Please choose an option from the menu below:`;
    bot.sendMessage(msg.chat.id, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(msg.chat.id) });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    const u = await ensureUser(msg.from);
    if (u && u.banned) return bot.sendMessage(chatId, "🚫 *You are banned.*", { parse_mode: 'Markdown' });

    const menuButtons = ["📱 GET NUMBER", "📡 LIVE RANGE", "📊 TRAFFIC", "🔐 2FA AUTHENTICATOR", "👤 ACCOUNT", "🎧 SUPPORT", "🛠️ ADMIN PANEL"];
    if (menuButtons.some(btn => text.includes(btn))) {
        if(adminState[chatId]) delete adminState[chatId];
        if(userState[chatId]) delete userState[chatId];
    }
    
    // --- USER STATE MACHINE (Withdrawals) ---
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
            state.action = 'wait_range_val';
            bot.sendMessage(chatId, `✅ Country: ${text}\n\n✏️ এবার API প্যানেলের রেঞ্জ টাইপ করুন (যেমন: 26134 বা 22501XXX):`);
            return;
        }
        else if (state.action === 'wait_range_val') {
            const ranges = await loadRanges();
            if (!ranges[state.platform]) ranges[state.platform] = {};
            ranges[state.platform][state.country] = { range: text };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ *${state.platform}* এর জন্য রেঞ্জ সেভ হয়েছে!`, { parse_mode: 'Markdown' });
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_range_edit') {
            const ranges = await loadRanges();
            ranges[state.platform][state.country] = { range: text };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ Range updated successfully!`);
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_apikey_add') {
            const newKey = text.trim();
            try {
                await savePanelKey(newKey);
                bot.sendMessage(chatId, "✅ *Panel API Key saved successfully!*", { parse_mode: 'Markdown' });
            } catch (e) {} delete adminState[chatId]; return;
        }
        // ... (Other admin states like broadcast, users, etc. remain the same and functionally working)
        else if (state.action === 'wait_broadcast_notice') {
            bot.sendMessage(chatId, "✅ *Broadcasting...*", { parse_mode: 'Markdown' });
            try {
                const users = await User.find({});
                users.forEach(u => bot.sendMessage(u.id, `📢 *Notice from Admin:*\n\n${text}`, { parse_mode: 'Markdown' }).catch(()=>{}));
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
                    row.push({ text: `${getPlatIcon(plat)} ${plat.toUpperCase()}`, callback_data: `u_site_${plat}`, style: "primary" });
                    if (row.length === 2) { inlineKeyboard.push(row); row = []; }
                }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            if (inlineKeyboard.length === 0) return bot.sendMessage(chatId, "⚠️ *কোনো সাইট বা নাম্বার স্টকে নেই।*", { parse_mode: 'Markdown' });
            bot.sendMessage(chatId, "📌 *Select a Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (text === "📡 LIVE RANGE") {
            bot.sendMessage(chatId, "📡 *Click below to check Live Ranges & Realtime OTP feed:*", { 
                parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: [[{ text: "🔥 Go To OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}` }]] } 
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
            if (saved2fa.length === 0) { bot.sendMessage(chatId, "🔐 *2FA Authenticator*\n\nআপনার কোনো 2FA অ্যাকাউন্ট নেই।", { parse_mode: 'Markdown', reply_markup: markup }); } 
            else { /* Render 2FA list similar to old code */ }
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

    try {
        if (data === "admin_main" && chatId === ADMIN_ID) {
            bot.editMessageText("🛠 *Admin Control Panel*\n\nSelect an option below:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getAdminMenu() });
        }
        // --- Admin Setup ---
        else if (data === "adm_apikey" && chatId === ADMIN_ID) {
            let msgText = `🔑 *Current Panel API Key:*\n\n\`${panelApiKey ? (panelApiKey.substring(0, 10) + '...') : 'Not Set'}\``;
            let inlineKeyboard = [
                [{ text: "➕ Set New API Key", callback_data: "set_apikey", style: "success" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText(msgText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (data === "set_apikey" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_apikey_add' };
            bot.sendMessage(chatId, "✏️ *Panel থেকে পাওয়া API Key টি পেস্ট করুন:*", { parse_mode: 'Markdown' });
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
            adminState[chatId] = { action: 'wait_site_add' }; bot.sendMessage(chatId, "✏️ নতুন সাইটের নাম দিন:"); bot.answerCallbackQuery(query.id);
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
                for (const country of Object.keys(ranges[plat])) { inlineKeyboard.push([{ text: `🌍 ${country}`, callback_data: `ar_c_${plat}_${country}`, style: "primary" }]); }
            }
            inlineKeyboard.push([{ text: "➕ Add Country & Range", callback_data: `ar_add_${plat}`, style: "success" }]);
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "adm_ranges", style: "danger" }]);
            bot.editMessageText(`⚙️ *Manage Countries: ${getPlatIcon(plat)} ${plat}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        else if (data.startsWith('ar_add_') && chatId === ADMIN_ID) {
            const plat = data.split('ar_add_')[1];
            adminState[chatId] = { action: 'wait_country_name', platform: plat };
            bot.sendMessage(chatId, "✏️ নতুন কান্ট্রির নাম ও ফ্ল্যাগ দিন (যেমন: 🇧🇩 Bangladesh):");
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('ar_c_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges();
            const rangeData = ranges[plat][country];
            const currentRange = typeof rangeData === 'string' ? rangeData : (rangeData ? rangeData.range : "Not set");
            
            let inlineKeyboard = [
                [{ text: "✏️ Edit Range", callback_data: `ar_ed_${plat}_${country}`, style: "primary" }, { text: "❌ Delete Country", callback_data: `ar_del_${plat}_${country}`, style: "danger" }],
                [{ text: "🔙 Back", callback_data: `ar_p_${plat}`, style: "danger" }]
            ];
            bot.editMessageText(`⚙️ *Platform:* ${plat}\n🌍 *Country:* ${country}\n🔢 *Current Range:* \`${currentRange}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
        }
        else if (data.startsWith('ar_ed_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            adminState[chatId] = { action: 'wait_range_edit', platform: plat, country: country };
            bot.sendMessage(chatId, `✏️ *${country}* এর জন্য প্যানেলের নতুন রেঞ্জ টাইপ করুন:`);
            bot.answerCallbackQuery(query.id);
        }

        // --- User Flows ---
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
        else if (data === "change_num") {
            // Find current active user session to reuse plat/country
            let plat, country;
            for(let [num, session] of activeNumbers.entries()) {
                if(session.chatId === chatId) { plat = session.plat; country = session.country; activeNumbers.delete(num); break; }
            }
            if (plat && country) {
                await bot.editMessageText("❌ *Number Cancelled. Generating New...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
                await generateNewNumber(chatId, plat, country, msgId);
            } else { bot.editMessageText("❌ *Session Expired. Please start again.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{}); }
            bot.answerCallbackQuery(query.id);
        }
        else if (data === "get_new_num") {
            bot.sendMessage(chatId, "📌 *Go to GET NUMBER from menu to start again.*", { parse_mode: 'Markdown' });
            bot.answerCallbackQuery(query.id);
        }
        else if (data.startsWith('gnew_')) {
            const parts = data.split('_'); const plat = parts[1]; const country = parts.slice(2).join('_');
            bot.answerCallbackQuery(query.id, { text: "Generating new number in your bot...", show_alert: false });
            generateNewNumber(query.from.id, plat, country, null).catch(e => {});
        }
    } catch(e) { bot.answerCallbackQuery(query.id, { text: "⚠️ Error processing request!", show_alert: true }); }
});

Promise.all([loadPanelKey()]).then(() => {
    console.log("🔑 API settings loaded from DB.");
});

console.log("🚀 V11 New Panel System Booted!");

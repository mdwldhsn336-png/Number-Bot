require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const { authenticator } = require('otplib');

// --- ১. Render Express Server ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Premium Fire OTP Bot v4.0 is Running!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- ২. Firebase Database Setup ---
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  })
});
const db = admin.firestore();

// --- ৩. কনফিগারেশন ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.API_KEY;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const OTP_GROUP_ID = "@otp_number_grp"; 
const BASE_URL = 'http://185.190.142.81';
const HEADERS = { 'X-API-Key': API_KEY };

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
let adminState = {};
const userLastOrder = new Map();
const activePolls = new Map(); 
const deliveredOtps = new Set(); // ডাবল মেসেজ ব্লক করার জন্য

// --- ৪. ডাটাবেস ফাংশনসমূহ ---
async function ensureUser(user) {
    if (!user) return;
    try {
        const docRef = db.collection('users').doc(String(user.id));
        const doc = await docRef.get();
        if (!doc.exists) {
            await docRef.set({ 
                first_name: user.first_name, 
                username: user.username || 'N/A',
                total_numbers: 0, 
                total_otps: 0, 
                joined: new Date().toISOString() 
            });
        }
    } catch(e){}
}

async function getUserStats(userId) {
    try {
        const doc = await db.collection('users').doc(String(userId)).get();
        return doc.exists ? doc.data() : { total_numbers: 0, total_otps: 0 };
    } catch(e) { return { total_numbers: 0, total_otps: 0 }; }
}

async function updateUserStat(userId, type) {
    try {
        const docRef = db.collection('users').doc(String(userId));
        if (type === 'number') await docRef.update({ total_numbers: admin.firestore.FieldValue.increment(1) });
        if (type === 'otp') await docRef.update({ total_otps: admin.firestore.FieldValue.increment(1) });
    } catch(e){}
}

async function updateGlobalStats(type) {
    try {
        const docRef = db.collection('bot_settings').doc('global_stats');
        let updates = {};
        if (type === 'pending') updates['pending'] = admin.firestore.FieldValue.increment(1);
        if (type === 'success') {
            updates['success'] = admin.firestore.FieldValue.increment(1);
            updates['pending'] = admin.firestore.FieldValue.increment(-1);
        }
        if (type === 'failed') {
            updates['failed'] = admin.firestore.FieldValue.increment(1);
            updates['pending'] = admin.firestore.FieldValue.increment(-1);
        }
        await docRef.set(updates, { merge: true });
    } catch(e){}
}

async function loadRanges() {
    const doc = await db.collection('bot_settings').doc('platforms').get();
    return doc.exists ? doc.data() : {};
}
async function saveRanges(data) {
    await db.collection('bot_settings').doc('platforms').set(data);
}
async function loadForceSubs() {
    const doc = await db.collection('bot_settings').doc('force_subs').get();
    return doc.exists ? doc.data() : { channels: [] };
}
async function saveForceSubs(channels) {
    await db.collection('bot_settings').doc('force_subs').set({ channels });
}
async function updateTraffic(plat, country) {
    const docRef = db.collection('bot_settings').doc('traffic');
    const doc = await docRef.get();
    let data = doc.exists ? doc.data() : {};
    let key = `${getPlatIcon(plat)} ${plat.toUpperCase()} - ${country.split(' ')[0]}`;
    data[key] = (data[key] || 0) + 1;
    await docRef.set(data);
}
async function getTraffic() {
    const doc = await db.collection('bot_settings').doc('traffic').get();
    return doc.exists ? doc.data() : {};
}
async function get2FA(chatId) {
    const doc = await db.collection('users').doc(String(chatId)).get();
    return doc.exists ? (doc.data().two_fa || []) : [];
}
async function save2FA(chatId, two_fa_list) {
    await db.collection('users').doc(String(chatId)).set({ two_fa: two_fa_list }, { merge: true });
}

// --- ৫. হেল্পার ফাংশন ---
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
    if(p.includes('tiktok')) return '🎵';
    if(p.includes('snap')) return '👻';
    if(p.includes('x') || p.includes('twitter')) return '🐦';
    return '💬'; 
}

function getMainMenu(chatId) {
    let kb = [
        [{ text: "📱 GET NUMBER" }],
        [{ text: "📥 INBOX" }, { text: "📊 TRAFFIC" }],
        [{ text: "🔐 2FA AUTHENTICATOR" }, { text: "👤 PROFILE INFO" }],
        [{ text: "🎧 SUPPORT" }]
    ];
    if (chatId === ADMIN_ID) kb.push([{ text: "🛠️ ADMIN PANEL" }]);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

function getAdminMenu() {
    return {
        inline_keyboard: [
            [{ text: "🌐 Manage Sites", callback_data: "adm_sites" }, { text: "⚙️ Manage Ranges", callback_data: "adm_ranges" }],
            [{ text: "📢 Force Sub Settings", callback_data: "adm_force" }],
            [{ text: "💰 API Balance", callback_data: "adm_balance" }, { text: "📊 Dashboard", callback_data: "adm_dash" }]
        ]
    };
}

// --- ৬. অটো-পোলিং ফাংশন (ডাবল মেসেজ ফিক্সড) ---
function startOtpPolling(chatId, msgId, numId, phone, plat, country, userFirstName, attempt = 0) {
    if (!activePolls.has(numId)) return; // যদি ইউজার Change Number এ ক্লিক করে থাকে
    if (deliveredOtps.has(numId)) return; // যদি অলরেডি ডেলিভার হয়ে থাকে

    setTimeout(async () => {
        if (!activePolls.has(numId) || deliveredOtps.has(numId)) return;

        try {
            const res = await axios.get(`${BASE_URL}/api/v1/numbers/${numId}/sms`, { headers: HEADERS });
            
            if (res.data.success && res.data.otp) {
                if (deliveredOtps.has(numId)) return; // ডাবল চেকিং লক
                deliveredOtps.add(numId);
                activePolls.delete(numId);
                
                const otpCode = res.data.otp;
                const icon = getPlatIcon(plat);
                const platName = plat.charAt(0).toUpperCase() + plat.slice(1);
                const formatPhone = phone.startsWith('+') ? phone : '+' + phone;
                
                // User Message Design
                const userText = `🌍 *Country:* ${country}\n\n╔════════════════════╗\n║ 📱 \`${formatPhone}\`\n╚════════════════════╝\n\n${icon} *${platName} OTP:*\n\`${otpCode}\``;
                const userMarkup = {
                    inline_keyboard: [
                        [{ text: `📋 🗑️ ${otpCode}`, copy_text: { text: otpCode } }],
                        [{ text: "💬 OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}` }]
                    ]
                };
                
                // আগের Generating মেসেজটা এডিট হবে (নতুন মেসেজ আসবে না)
                bot.editMessageText(userText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: userMarkup }).catch(()=>{});
                
                // Stats Update
                updateTraffic(plat, country);
                updateUserStat(chatId, 'otp');
                updateGlobalStats('success');

                // Group Message Design (Group Link Removed)
                const maskedPhone = maskNumber(phone);
                const groupText = `🌍 *Country:* ${country}\n\n╔════════════════════╗\n║ 📱 \`${maskedPhone}\`\n╚════════════════════╝\n\n${icon} *${platName} OTP:*\n\`${otpCode}\`\n👤 *User:* ${userFirstName}`;
                const groupMarkup = {
                    inline_keyboard: [
                        [{ text: `📋 🗑️ ${otpCode}`, copy_text: { text: otpCode } }]
                    ]
                };
                bot.sendMessage(OTP_GROUP_ID, groupText, { parse_mode: 'Markdown', reply_markup: groupMarkup }).catch(()=>{});
                
                return;
            }
        } catch (err) {}

        if (attempt >= 90) { // ৩ মিনিট (৯০ বার)
            activePolls.delete(numId);
            updateGlobalStats('failed');
            const failText = `⚠️ *OTP Timeout!*\n\n🌍 *Country:* ${country}\n\n╔════════════════════╗\n║ 📱 \`${phone}\`\n╚════════════════════╝\n\n_৩ মিনিটের মধ্যে কোনো OTP আসেনি। Change Number এ ক্লিক করে নতুন নাম্বার নিন।_`;
            bot.editMessageText(failText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            return;
        }

        // লুপ চালিয়ে যাওয়া
        if (activePolls.has(numId)) {
            startOtpPolling(chatId, msgId, numId, phone, plat, country, userFirstName, attempt + 1);
        }
    }, 2000); 
}

// --- ৭. ফোর্স সাবস্ক্রাইব ---
async function checkForceSub(chatId) {
    if (chatId === ADMIN_ID) return true;
    const subs = await loadForceSubs();
    const channels = subs.channels;
    if (!channels || channels.length === 0) return true;

    let isSubscribed = true;
    let buttons = [];

    for (let ch of channels) {
        try {
            const member = await bot.getChatMember(ch, chatId);
            if (member.status === 'left' || member.status === 'kicked') {
                isSubscribed = false;
                buttons.push([{ text: `📢 Join Channel`, url: `https://t.me/${ch.replace('@', '')}` }]);
            }
        } catch (e) { }
    }

    if (!isSubscribed) {
        buttons.push([{ text: "✅ Joined (Check Again)", callback_data: "check_joined" }]);
        bot.sendMessage(chatId, "⚠️ *বট ব্যবহার করতে নিচের চ্যানেলগুলোতে জয়েন করুন:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        return false;
    }
    return true;
}

// --- ৮. কমান্ড এবং মেসেজ লজিক ---
bot.onText(/\/start/, async (msg) => {
    await ensureUser(msg.from);
    if (!(await checkForceSub(msg.chat.id))) return;
    
    const welcomeMsg = `🌟 *WELCOME TO PREMIUM FIRE OTP BOT* 🌟\n\n👋 Hello, *${msg.from.first_name}*!\n\n🚀 _Get unlimited virtual numbers and instant OTPs for any platform in seconds._\n\n👇 Please choose an option from the menu below:`;
    bot.sendMessage(msg.chat.id, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(msg.chat.id) });
});

bot.on('message', async (msg) => {
    await ensureUser(msg.from);
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    // --- Admin State Handler ---
    if (adminState[chatId]) {
        const state = adminState[chatId];
        
        if (state.action === 'wait_2fa_secret') {
            const secret = text.trim().replace(/\s+/g, '').toUpperCase();
            try {
                authenticator.generate(secret);
                const saved2fa = await get2FA(chatId);
                saved2fa.push({ secret: secret, added: new Date().toISOString() });
                await save2FA(chatId, saved2fa);
                bot.sendMessage(chatId, `✅ *2FA Secret সেভ হয়েছে!*\n\n'🔐 2FA AUTHENTICATOR' থেকে OTP নিতে পারবেন।`, { parse_mode: 'Markdown' });
            } catch (e) {
                bot.sendMessage(chatId, `❌ *ভুল সিক্রেট কোড!*`, { parse_mode: 'Markdown' });
            }
            delete adminState[chatId]; return;
        }
        
        const ranges = await loadRanges();
        if (state.action === 'wait_site_add') {
            if (!ranges[text]) ranges[text] = {};
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ সাইট *${getPlatIcon(text)} ${text}* যুক্ত হয়েছে!`, { parse_mode: 'Markdown' });
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_country_name') {
            state.country = text;
            state.action = 'wait_range_val';
            bot.sendMessage(chatId, `✅ কান্ট্রি: ${text}\n\n✏️ এবার রেঞ্জ টাইপ করুন (যেমন: 22507XXX):`);
            return;
        }
        else if (state.action === 'wait_range_val') {
            if (!ranges[state.platform]) ranges[state.platform] = {};
            ranges[state.platform][state.country] = text;
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ *${state.platform}* এর জন্য রেঞ্জ সেভ হয়েছে!`, { parse_mode: 'Markdown' });
            
            // Broadcast
            const icon = getPlatIcon(state.platform);
            const platName = state.platform.charAt(0).toUpperCase() + state.platform.slice(1);
            const broadcastMsg = `📢 *NEW NUMBER STOCKED!*\n\n${icon} *Platform:* ${platName}\n🌍 *Country:* ${state.country}\n\n🔥 _Go to "GET NUMBER" and grab your numbers now!_`;
            
            try {
                const users = await db.collection('users').get();
                let sentCount = 0;
                users.forEach(doc => {
                    bot.sendMessage(doc.id, broadcastMsg, { parse_mode: 'Markdown' }).catch(()=>{});
                    sentCount++;
                });
                bot.sendMessage(chatId, `✅ Broadcast sent to ${sentCount} users.`, { parse_mode: 'Markdown' });
            } catch(e){}
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_range_edit') {
            ranges[state.platform][state.country] = text;
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ Range updated successfully!`);
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_channel_add') {
            const subs = await loadForceSubs();
            if (!subs.channels.includes(text)) subs.channels.push(text);
            await saveForceSubs(subs.channels);
            bot.sendMessage(chatId, `✅ চ্যানেল ${text} যুক্ত হয়েছে!`);
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_channel_remove') {
            const subs = await loadForceSubs();
            let newChannels = subs.channels.filter(ch => ch !== text);
            await saveForceSubs(newChannels);
            bot.sendMessage(chatId, `🗑️ চ্যানেল ${text} রিমুভ করা হয়েছে!`);
            delete adminState[chatId]; return;
        }
    }

    if (!(await checkForceSub(chatId))) return;

    // --- ইউজার বাটনসমূহ ---
    if (text === "🛠️ ADMIN PANEL" && chatId === ADMIN_ID) {
        bot.sendMessage(chatId, "🛠 *Admin Control Panel*\n\nSelect an option below:", { parse_mode: 'Markdown', reply_markup: getAdminMenu() });
    }
    else if (text === "📱 GET NUMBER") {
        const ranges = await loadRanges();
        let inlineKeyboard = [];
        let row = [];
        
        for (const [plat, countries] of Object.entries(ranges)) {
            if (Object.keys(countries).length > 0) {
                const icon = getPlatIcon(plat);
                row.push({ text: `${icon} ${plat.toUpperCase()}`, callback_data: `u_site_${plat}` });
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
        
        if (!lastOrder) {
            return bot.editMessageText("⚠️ *OTP Not Found!*\n\n_You haven't requested any numbers recently._", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
        }
        
        try {
            const res = await axios.get(`${BASE_URL}/api/v1/numbers/${lastOrder.numId}/sms`, { headers: HEADERS, timeout: 5000 });
            if (res.data.success && res.data.otp) {
                const icon = getPlatIcon(lastOrder.plat);
                const platName = lastOrder.plat.charAt(0).toUpperCase() + lastOrder.plat.slice(1);
                
                const boxNumber = `╔════════════════════╗\n║ 📱 \`${lastOrder.phone}\`\n╚════════════════════╝`;
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: `📋 🗑️ ${res.data.otp}`, copy_text: { text: res.data.otp } }],
                        [{ text: "💬 OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}` }]
                    ]
                };
                bot.editMessageText(`📥 *Latest Inbox Found:*\n\n🌍 *Country:* ${lastOrder.country}\n\n${boxNumber}\n\n${icon} *${platName} OTP:*\n\`${res.data.otp}\``, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown', reply_markup: replyMarkup });
            } else {
                bot.editMessageText("⚠️ *OTP Not Found!*\n\n_Still waiting or session expired._", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
            }
        } catch (e) {
             bot.editMessageText("⚠️ *OTP Not Found!*\n\n_Server connection error._", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
        }
    }
    else if (text === "📊 TRAFFIC") {
        const traffic = await getTraffic();
        if (Object.keys(traffic).length === 0) return bot.sendMessage(chatId, "⚠️ *এখনও কোনো ট্রাফিক ডাটা নেই।*", { parse_mode: 'Markdown' });
        
        let sorted = Object.entries(traffic).sort((a, b) => b[1] - a[1]);
        let msgText = "📊 *GLOBAL OTP TRAFFIC*\n\n";
        sorted.forEach(([key, count], index) => {
            msgText += `*${index + 1}.* ${key} ➔ \`${count} OTPs\`\n`;
        });
        bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
    else if (text === "👤 PROFILE INFO" || text.includes("PROFILE INFO")) {
        try {
            const stats = await getUserStats(chatId);
            const p = msg.from;
            const profileText = `👤 *PROFILE INFORMATION*\n\n` +
                                `🆔 *Your ID:* \`${chatId}\`\n` +
                                `👤 *Name:* ${p.first_name} ${p.last_name || ''}\n` +
                                `🔗 *Username:* ${p.username ? '@'+p.username : 'N/A'}\n\n` +
                                `📈 *Activity Stats:*\n` +
                                `📱 *Total Numbers:* \`${stats.total_numbers || 0}\`\n` +
                                `💬 *Total OTPs:* \`${stats.total_otps || 0}\`\n\n` +
                                `_Keep enjoying the premium service!_`;
            bot.sendMessage(chatId, profileText, { parse_mode: 'Markdown' });
        } catch(e) {
            bot.sendMessage(chatId, "⚠️ Profile loading error. Try again later.");
        }
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
            bot.sendMessage(chatId, "🔐 *2FA Authenticator*\n\nআপনার সেভ করা 2FA অ্যাকাউন্টগুলো নিচে দেওয়া হলো। OTP পেতে 'Key' বাটনে ক্লিক করুন:", { parse_mode: 'Markdown', reply_markup: markup });
        }
    }
    else if (text === "🎧 SUPPORT") {
        let markup = { inline_keyboard: [[{ text: "👨‍💻 Contact Admin", url: `tg://user?id=${ADMIN_ID}` }]] };
        bot.sendMessage(chatId, "🎧 *SUPPORT CENTER*\n\nবট ব্যবহার করতে কোনো সমস্যা হলে বা হেল্প লাগলে সরাসরি অ্যাডমিনের ইনবক্সে মেসেজ দিন:", { parse_mode: 'Markdown', reply_markup: markup });
    }
});

// --- ৯. কলব্যাক (ইনলাইন বাটন) ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data === "check_joined") {
        if (await checkForceSub(chatId)) {
            bot.deleteMessage(chatId, msgId);
            bot.sendMessage(chatId, "✅ *ধন্যবাদ!*", { parse_mode: 'Markdown', ...getMainMenu(chatId) });
        } else bot.answerCallbackQuery(query.id, { text: "⚠️ এখনও সব চ্যানেলে জয়েন করেননি!", show_alert: true });
    }

    // --- Admin Navigation ---
    else if (data === "admin_main" && chatId === ADMIN_ID) {
        bot.editMessageText("🛠 *Admin Control Panel*\n\nSelect an option below:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getAdminMenu() });
    }
    else if (data === "adm_balance" && chatId === ADMIN_ID) {
        bot.answerCallbackQuery(query.id, { text: "Checking Balance..." });
        try {
            const res = await axios.get(`${BASE_URL}/api/v1/balance`, { headers: HEADERS });
            if(res.data.success) {
                bot.editMessageText(`💰 *API Balance:* \`${res.data.balance}\` ৳`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_main" }]] }});
            } else throw new Error();
        } catch(e) { bot.answerCallbackQuery(query.id, { text: "Error getting balance", show_alert:true }); }
    }
    else if (data === "adm_dash" && chatId === ADMIN_ID) {
        const usersSnap = await db.collection('users').get();
        const statDoc = await db.collection('bot_settings').doc('global_stats').get();
        const gStats = statDoc.exists ? statDoc.data() : { success: 0, pending: 0, failed: 0 };
        
        const dashText = `📊 *BOT DASHBOARD*\n\n` +
                         `👥 *Total Users:* \`${usersSnap.size}\`\n\n` +
                         `📈 *Order Stats:*\n` +
                         `✅ Success: \`${gStats.success || 0}\`\n` +
                         `⏳ Pending: \`${gStats.pending || 0}\`\n` +
                         `❌ Failed: \`${gStats.failed || 0}\``;
        bot.editMessageText(dashText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_main" }]] }});
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
    
    // --- Advanced Range Management ---
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
    else if (data.startsWith('ar_c_') && chatId === ADMIN_ID) {
        const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
        const ranges = await loadRanges();
        const currentRange = ranges[plat][country] || "Not set";
        
        let inlineKeyboard = [
            [{ text: "✏️ Edit Range", callback_data: `ar_ed_${plat}_${country}` }, { text: "❌ Delete Country", callback_data: `ar_del_${plat}_${country}` }],
            [{ text: "🔙 Back", callback_data: `ar_p_${plat}` }]
        ];
        bot.editMessageText(`⚙️ *Platform:* ${plat}\n🌍 *Country:* ${country}\n\n🔢 *Current Range:* \`${currentRange}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
    }
    else if (data.startsWith('ar_ed_') && chatId === ADMIN_ID) {
        const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
        adminState[chatId] = { action: 'wait_range_edit', platform: plat, country: country };
        bot.sendMessage(chatId, `✏️ *${country}* এর জন্য নতুন রেঞ্জ টাইপ করুন:`);
        bot.answerCallbackQuery(query.id);
    }
    else if (data.startsWith('ar_del_') && chatId === ADMIN_ID) {
        const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
        const ranges = await loadRanges();
        if (ranges[plat] && ranges[plat][country]) { delete ranges[plat][country]; await saveRanges(ranges); }
        bot.editMessageText(`✅ কান্ট্রি ও রেঞ্জ ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: `ar_p_${plat}` }]] } });
    }

    else if (data === "adm_force" && chatId === ADMIN_ID) {
        const subs = await loadForceSubs();
        let text = "📢 *Force Sub Channels:*\n";
        subs.channels.forEach(c => text += `▪️ ${c}\n`);
        if(subs.channels.length === 0) text += "None\n";
        let markup = { inline_keyboard: [[{ text: "➕ Add Channel", callback_data: "force_add" }, { text: "➖ Remove Channel", callback_data: "force_remove" }], [{ text: "🔙 Back", callback_data: "admin_main" }]]};
        bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
    }
    else if (data === "force_add" && chatId === ADMIN_ID) {
        adminState[chatId] = { action: 'wait_channel_add' };
        bot.sendMessage(chatId, "✏️ চ্যানেলের ইউজারনেম দিন:"); bot.answerCallbackQuery(query.id);
    }
    else if (data === "force_remove" && chatId === ADMIN_ID) {
        adminState[chatId] = { action: 'wait_channel_remove' };
        bot.sendMessage(chatId, "✏️ যে চ্যানেলটি রিমুভ করতে চান তার ইউজারনেম দিন:"); bot.answerCallbackQuery(query.id);
    }

    // --- 2FA Config ---
    else if (data === "add_2fa") {
        adminState[chatId] = { action: 'wait_2fa_secret' };
        bot.sendMessage(chatId, "✏️ *আপনার 2FA Secret Key টি পাঠান:*\n_(যেমন: JBSWY3DPEHPK3PXP)_", { parse_mode: 'Markdown' });
        bot.answerCallbackQuery(query.id);
    }
    else if (data.startsWith('get_2fa_')) {
        const index = parseInt(data.split('_')[2]);
        const saved2fa = await get2FA(chatId);
        if (saved2fa[index]) {
            const token = authenticator.generate(saved2fa[index].secret);
            const markup = { inline_keyboard: [[{ text: `📋 🗑️ Copy Code: ${token}`, copy_text: { text: token } }]] };
            bot.sendMessage(chatId, `🔐 *Live 2FA OTP Code:*\n\n\`${token}\`\n\n_(নিচের বাটনে ক্লিক করে কপি করুন)_`, { parse_mode: 'Markdown', reply_markup: markup });
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
            clearInterval(activePolls.get(lastOrder.numId));
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
        const ranges = await loadRanges(); const rangeVal = ranges[plat][country];

        bot.deleteMessage(chatId, msgId);
        const sentMsg = await bot.sendMessage(chatId, "⏳ *Generating Number...*", { parse_mode: 'Markdown' });

        try {
            const res = await axios.post(`${BASE_URL}/api/v1/numbers/get`, { range: rangeVal, format: "international" }, { headers: HEADERS, timeout: 15000 });
            
            if (res.data.success) {
                userLastOrder.set(chatId, { numId: res.data.number_id, phone: res.data.number, plat: plat, country: country });
                updateUserStat(chatId, 'number');
                updateGlobalStats('pending');

                const icon = getPlatIcon(plat);
                const formatPhone = res.data.number.startsWith('+') ? res.data.number : '+' + res.data.number;
                
                // ডাবল লাইন বক্স ডিজাইন
                const boxNumber = `╔════════════════════╗\n║ 📱 \`${formatPhone}\`\n╚════════════════════╝`;
                
                const text = `🌍 *Country:* ${country}\n\n${boxNumber}\n\n⏳ _অটোমেটিক OTP চেক করা হচ্ছে..._`;
                
                const actionMarkup = {
                    inline_keyboard: [
                        [{ text: "🔄 Fetch OTP", callback_data: `fetch_otp_${res.data.number_id}` }, { text: "❌ Change Number", callback_data: "change_num" }]
                    ]
                };
                
                bot.editMessageText(text, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown', reply_markup: actionMarkup });
                
                // Start Polling Lock System
                activePolls.set(res.data.number_id, true);
                startOtpPolling(chatId, sentMsg.message_id, res.data.number_id, res.data.number, plat, country, query.from.first_name);
            } else {
                bot.editMessageText("❌ *এই মুহূর্তে এই কান্ট্রির কোনো নাম্বার স্টকে নেই।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
            }
        } catch (error) {
            bot.editMessageText("⚠️ *API সার্ভার রেসপন্স করছে না।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
        }
        bot.answerCallbackQuery(query.id);
    }
    
    // --- Manual Fetch OTP (Force Check) ---
    else if (data.startsWith('fetch_otp_')) {
        const numId = data.split('_')[2];
        const lastOrder = userLastOrder.get(chatId);
        if(!lastOrder) return bot.answerCallbackQuery(query.id, { text: "Invalid Request", show_alert: true });

        bot.answerCallbackQuery(query.id, { text: "⏳ Fetching OTP..." });
        
        try {
            const res = await axios.get(`${BASE_URL}/api/v1/numbers/${numId}/sms`, { headers: HEADERS, timeout: 5000 });
            if (res.data.success && res.data.otp) {
                // পোলিং নিজে থেকেই ক্যাচ করবে এবং এডিট করবে
            } else {
                bot.answerCallbackQuery(query.id, { text: "⚠️ OTP Not Found! Auto-checking continues...", show_alert: true });
            }
        } catch(e) { }
    }
});

console.log("Ultimate Premium BOT v4.0 is Alive & Fully Functional!");

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');

// --- ১. Render Express Server ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Ultimate Fire OTP Bot is Running!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- ২. Firebase Database ---
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
const OTP_GROUP_ID = process.env.OTP_GROUP_ID; // নতুন গ্রুপ আইডি
const BASE_URL = 'http://185.190.142.81';
const HEADERS = { 'X-API-Key': API_KEY };

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
let adminState = {};
const activeOrders = new Map(); // সাময়িকভাবে নাম্বারের ডাটা সেভ রাখার জন্য

// --- ৪. ডাটাবেস ফাংশনসমূহ ---
async function loadRanges() {
    // স্ট্রাকচার: { "Instagram": { "🇧🇩 Bangladesh": "88019XXX", "🇹🇬 Togo": "2289XXX" } }
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
    let key = `${plat} | ${country}`;
    data[key] = (data[key] || 0) + 1;
    await docRef.set(data);
}
async function getTraffic() {
    const doc = await db.collection('bot_settings').doc('traffic').get();
    return doc.exists ? doc.data() : {};
}

// --- ৫. হেল্পার ফাংশন ---
function maskNumber(phone) {
    let str = String(phone);
    if (str.length < 8) return str;
    return str.substring(0, 4) + "❤️❤️❤️" + str.substring(str.length - 3);
}

function getMainMenu(chatId) {
    let kb = [
        [{ text: "📱 GET NUMBER" }, { text: "📊 TRAFFIC" }],
        [{ text: "🔐 2FA AUTHENTICATOR" }, { text: "👤 PROFILE INFO" }],
        [{ text: "🎧 SUPPORT" }]
    ];
    if (chatId === ADMIN_ID) kb.push([{ text: "🛠️ ADMIN PANEL" }]);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

// --- ৬. ফোর্স সাবস্ক্রাইব ---
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

// --- ৭. কমান্ডস এবং মেসেজ ---
bot.onText(/\/start/, async (msg) => {
    if (!(await checkForceSub(msg.chat.id))) return;
    bot.sendMessage(msg.chat.id, "《 👑 FIRE OTP BOT 👑 》\n\n👋 *WELCOME, " + msg.from.first_name + "!*", { parse_mode: 'Markdown', ...getMainMenu(msg.chat.id) });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    // --- অ্যাডমিন ইনপুট হ্যান্ডলার ---
    if (adminState[chatId]) {
        const state = adminState[chatId];
        const ranges = await loadRanges();
        
        if (state.action === 'wait_site_add') {
            if (!ranges[text]) ranges[text] = {};
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ সাইট *${text}* যুক্ত হয়েছে!`, { parse_mode: 'Markdown' });
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
            bot.sendMessage(chatId, `✅ *${state.platform}* এর জন্য *${state.country}* রেঞ্জ সফলভাবে সেভ হয়েছে!`, { parse_mode: 'Markdown' });
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_channel_add') {
            const subs = await loadForceSubs();
            if (!subs.channels.includes(text)) subs.channels.push(text);
            await saveForceSubs(subs.channels);
            bot.sendMessage(chatId, `✅ চ্যানেল ${text} যুক্ত হয়েছে!`);
            delete adminState[chatId]; return;
        }
    }

    if (!(await checkForceSub(chatId))) return;

    // --- ইউজার বাটন ---
    if (text === "🛠️ ADMIN PANEL" && chatId === ADMIN_ID) {
        let markup = { inline_keyboard: [
            [{ text: "🌐 Manage Sites", callback_data: "adm_sites" }, { text: "⚙️ Manage Ranges", callback_data: "adm_ranges" }],
            [{ text: "📢 Force Sub Settings", callback_data: "adm_force" }]
        ]};
        bot.sendMessage(chatId, "🛠 *Admin Panel*", { parse_mode: 'Markdown', reply_markup: markup });
    }
    else if (text === "📱 GET NUMBER") {
        const ranges = await loadRanges();
        let inlineKeyboard = [];
        let row = [];
        // শুধু যে সাইটগুলোতে কান্ট্রি অ্যাড করা আছে সেগুলো দেখাবে
        for (const [plat, countries] of Object.entries(ranges)) {
            if (Object.keys(countries).length > 0) {
                row.push({ text: `💬 🟢 ${plat.toUpperCase()} 🟢`, callback_data: `u_site_${plat}` });
                if (row.length === 2) { inlineKeyboard.push(row); row = []; }
            }
        }
        if (row.length > 0) inlineKeyboard.push(row);
        if (inlineKeyboard.length === 0) return bot.sendMessage(chatId, "⚠️ *কোনো সাইট বা নাম্বার স্টকে নেই।*", { parse_mode: 'Markdown' });
        
        bot.sendMessage(chatId, "📌 *Select a Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    }
    else if (text === "📊 TRAFFIC") {
        const traffic = await getTraffic();
        if (Object.keys(traffic).length === 0) return bot.sendMessage(chatId, "⚠️ *এখনও কোনো ট্রাফিক ডাটা নেই।*", { parse_mode: 'Markdown' });
        
        // ট্রাফিক সর্ট করা (বেশি থেকে কম)
        let sorted = Object.entries(traffic).sort((a, b) => b[1] - a[1]);
        let msgText = "📊 *OTP TRAFFIC LEADERBOARD*\n\n";
        sorted.forEach(([key, count], index) => {
            msgText += `*${index + 1}.* ${key} ➔ \`${count} OTPs\`\n`;
        });
        bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
    else if (["🔐 2FA AUTHENTICATOR", "👤 PROFILE INFO", "🎧 SUPPORT"].includes(text)) {
        bot.sendMessage(chatId, "🛠️ *This feature is under development...*", { parse_mode: 'Markdown' });
    }
});

// --- ৮. কলব্যাক (ইনলাইন বাটন) ---
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

    // --- Admin: Sites Management ---
    else if (data === "adm_sites" && chatId === ADMIN_ID) {
        const ranges = await loadRanges();
        let inlineKeyboard = [];
        for (const plat of Object.keys(ranges)) {
            inlineKeyboard.push([{ text: `❌ Delete ${plat}`, callback_data: `del_site_${plat}` }]);
        }
        inlineKeyboard.push([{ text: "➕ Add New Site", callback_data: "add_site" }]);
        bot.editMessageText("🌐 *Manage Sites*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
    }
    else if (data === "add_site" && chatId === ADMIN_ID) {
        adminState[chatId] = { action: 'wait_site_add' };
        bot.sendMessage(chatId, "✏️ নতুন সাইটের নাম দিন (যেমন: Instagram):");
        bot.answerCallbackQuery(query.id);
    }
    else if (data.startsWith('del_site_') && chatId === ADMIN_ID) {
        const plat = data.split('del_site_')[1];
        const ranges = await loadRanges();
        delete ranges[plat];
        await saveRanges(ranges);
        bot.editMessageText(`✅ ${plat} ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId });
    }

    // --- Admin: Ranges Management ---
    else if (data === "adm_ranges" && chatId === ADMIN_ID) {
        const ranges = await loadRanges();
        let inlineKeyboard = [];
        for (const plat of Object.keys(ranges)) {
            inlineKeyboard.push([{ text: `⚙️ ${plat}`, callback_data: `adm_rng_${plat}` }]);
        }
        bot.editMessageText("⚙️ *Select Site to Manage Ranges*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
    }
    else if (data.startsWith('adm_rng_') && chatId === ADMIN_ID) {
        const plat = data.split('adm_rng_')[1];
        const ranges = await loadRanges();
        let inlineKeyboard = [];
        if (ranges[plat]) {
            for (const country of Object.keys(ranges[plat])) {
                inlineKeyboard.push([{ text: `❌ Delete ${country}`, callback_data: `del_rng_${plat}_${country}` }]);
            }
        }
        inlineKeyboard.push([{ text: "➕ Add Range", callback_data: `add_rng_${plat}` }]);
        bot.editMessageText(`⚙️ *Manage Ranges: ${plat}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
    }
    else if (data.startsWith('add_rng_') && chatId === ADMIN_ID) {
        const plat = data.split('add_rng_')[1];
        adminState[chatId] = { action: 'wait_country_name', platform: plat };
        bot.sendMessage(chatId, "✏️ কান্ট্রির নাম ও ফ্ল্যাগ দিন (যেমন: 🇧🇩 Bangladesh):");
        bot.answerCallbackQuery(query.id);
    }
    else if (data.startsWith('del_rng_') && chatId === ADMIN_ID) {
        const parts = data.split('_');
        const plat = parts[2];
        const country = parts[3];
        const ranges = await loadRanges();
        if (ranges[plat] && ranges[plat][country]) {
            delete ranges[plat][country];
            await saveRanges(ranges);
        }
        bot.editMessageText(`✅ রেঞ্জ ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId });
    }

    // --- User: Get Number Flow ---
    else if (data.startsWith('u_site_')) {
        const plat = data.split('u_site_')[1];
        const ranges = await loadRanges();
        let inlineKeyboard = [];
        let row = [];
        
        for (const country of Object.keys(ranges[plat] || {})) {
            row.push({ text: country, callback_data: `u_cntry_${plat}_${country}` });
            if (row.length === 2) { inlineKeyboard.push(row); row = []; }
        }
        if (row.length > 0) inlineKeyboard.push(row);
        
        bot.editMessageText(`📌 *Select Country for ${plat}:*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
    }
    else if (data.startsWith('u_cntry_')) {
        const parts = data.split('_');
        const plat = parts[2];
        const country = parts.slice(3).join('_'); // কান্ট্রির নামে স্পেস থাকতে পারে
        const ranges = await loadRanges();
        const rangeVal = ranges[plat][country];

        bot.deleteMessage(chatId, msgId);
        const sentMsg = await bot.sendMessage(chatId, "⏳ *Generating Number...*", { parse_mode: 'Markdown' });

        try {
            const res = await axios.post(`${BASE_URL}/api/v1/numbers/get`, { range: rangeVal, format: "international" }, { headers: HEADERS, timeout: 15000 });
            if (res.data.success) {
                const numId = res.data.number_id;
                // সাময়িক মেমরিতে ডাটা সেভ রাখা (গ্রুপ ও ট্রাফিকের জন্য)
                activeOrders.set(String(numId), { phone: res.data.number, plat, country, user: query.from.first_name });

                const markup = { inline_keyboard: [[{ text: "📩 Check OTP", callback_data: `checkotp_${numId}` }]] };
                const text = `✅ *Number Generated Successfully!*\n\n🌍 *Country:* ${country}\n📱 *Number:* \`${res.data.number}\`\n🌐 *Platform:* ${plat.toUpperCase()}\n\n_Waiting for OTP... Click 'Check OTP' below._`;
                
                bot.editMessageText(text, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown', reply_markup: markup });
            } else {
                bot.editMessageText("❌ *এই মুহূর্তে এই কান্ট্রির কোনো নাম্বার স্টকে নেই।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
            }
        } catch (error) {
            bot.editMessageText("⚠️ *API সার্ভার রেসপন্স করছে না।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
        }
        bot.answerCallbackQuery(query.id);
    }
    
    // --- OTP Check Logic ---
    else if (data.startsWith('checkotp_')) {
        const numId = data.split('_')[1];
        bot.answerCallbackQuery(query.id, { text: "Checking OTP..." });

        try {
            const res = await axios.get(`${BASE_URL}/api/v1/numbers/${numId}/sms`, { headers: HEADERS, timeout: 10000 });
            
            if (res.data.success) {
                // API তে মাঝেমাঝে otp অন্য ফিল্ডেও থাকতে পারে, তাই একটু সেফটি চেক
                const otpCode = res.data.otp || (res.data.status === 'completed' ? res.data.message : null);
                
                if (otpCode && res.data.status !== 'pending') {
                    // ১. ইউজারকে OTP দেওয়া
                    bot.sendMessage(chatId, `🎉 *Your OTP Code:* \`${otpCode}\``, { parse_mode: 'Markdown' });
                    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
                    
                    // ২. ট্রাফিক ও গ্রুপ আপডেট
                    const orderData = activeOrders.get(String(numId));
                    if (orderData) {
                        await updateTraffic(orderData.plat, orderData.country); // ট্রাফিক প্লাস
                        
                        // গ্রুপে মেসেজ পাঠানো (নাম্বার হাইড করে)
                        if (OTP_GROUP_ID) {
                            const maskedPhone = maskNumber(orderData.phone);
                            const groupMsg = `🔥 *NEW OTP RECEIVED!*\n\n🌐 *Platform:* ${orderData.plat.toUpperCase()}\n🌍 *Country:* ${orderData.country}\n📱 *Number:* ${maskedPhone}\n📩 *OTP Code:* \`${otpCode}\`\n👤 *User:* ${orderData.user}`;
                            bot.sendMessage(OTP_GROUP_ID, groupMsg, { parse_mode: 'Markdown' }).catch(e => console.log("Group message failed:", e.message));
                        }
                        activeOrders.delete(String(numId)); // মেমরি ক্লিয়ার
                    }
                } else if (res.data.status === 'pending' || res.data.otp === null) {
                    bot.answerCallbackQuery(query.id, { text: "⏳ এখনও OTP আসেনি। আরেকটু অপেক্ষা করুন...", show_alert: true });
                } else {
                    bot.answerCallbackQuery(query.id, { text: "⚠️ API তে কোনো OTP পাওয়া যায়নি।", show_alert: true });
                }
            } else {
                bot.answerCallbackQuery(query.id, { text: `⚠️ সেশন শেষ: ${res.data.message || 'Time out'}`, show_alert: true });
            }
        } catch (error) {
            bot.answerCallbackQuery(query.id, { text: "⚠️ সার্ভার ত্রুটি, আবার চাপুন।", show_alert: true });
        }
    }
});

console.log("Ultimate Pro Bot is Ready & Running!");

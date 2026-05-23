require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');

// --- ১. Render এর জন্য Express Server (যাতে হোস্টিং ডাউন না হয়) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Fire OTP Bot is alive and kicking!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- ২. Firebase Database কানেকশন ---
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Render এ প্রাইভেট কী এর নতুন লাইন (\n) ঠিক রাখার জন্য রেগুলার এক্সপ্রেশন ব্যবহার করা হয়েছে
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  })
});
const db = admin.firestore();

// --- ৩. কনফিগারেশন (Render এর Environment Variables থেকে আসবে) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.API_KEY;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const BASE_URL = 'http://185.190.142.81';
const HEADERS = { 'X-API-Key': API_KEY };

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
let adminState = {};

// --- ৪. Firebase ডাটাবেস ফাংশন ---
async function loadRanges() {
    const doc = await db.collection('bot_settings').doc('ranges').get();
    if (!doc.exists) return { "Instagram": "", "Facebook": "", "Whatsapp": "", "Telegram": "" };
    return doc.data();
}

async function saveRanges(data) {
    await db.collection('bot_settings').doc('ranges').set(data);
}

// --- ৫. মেইন মেনু ডিজাইন (আপনার স্ক্রিনশটের মতো হুবহু লেআউট) ---
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: "📱 GET NUMBER" }, { text: "📊 TRAFFIC" }],
            [{ text: "💰 BALANCE" }, { text: "💸 WITHDRAWAL" }],
            [{ text: "🎁 REFER" }, { text: "🛠️ SUPPORT" }],
            [{ text: "🔐 2FA ONLINE" }, { text: "👤 FAKE INFO" }],
            [{ text: "🏆 LEADERBOARD" }]
        ],
        resize_keyboard: true
    }
};

// --- ৬. বটের মূল লজিক ও কমান্ডসমূহ ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "《 👑 FIRE OTP BOT 👑 》\n\n👋 *WELCOME, " + msg.from.first_name + "!*\n\n📱 GET NUMBER - OTP SERVICE\n📊 TRAFFIC - CHECK TRAFFIC\n🔐 2FA ONLINE - AUTHENTICATOR\n👤 FAKE INFO - BD NAME\n🏆 LEADERBOARD - TOP USERS", { parse_mode: 'Markdown', ...mainMenu });
});

// অ্যাডমিন প্যানেল কমান্ড (শুধু আপনি দেখতে পাবেন)
bot.onText(/\/admin/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "❌ *Access Denied!*", { parse_mode: 'Markdown' });

    const ranges = await loadRanges();
    let inlineKeyboard = [];
    let row = [];
    
    for (const [plat, rg] of Object.entries(ranges)) {
        const status = rg ? "✅" : "❌";
        row.push({ text: `${status} ${plat}`, callback_data: `setrange_${plat}` });
        if (row.length === 2) { inlineKeyboard.push(row); row = []; }
    }
    if (row.length > 0) inlineKeyboard.push(row);
    inlineKeyboard.push([{ text: "➕ Add New Platform", callback_data: "add_platform" }]);

    bot.sendMessage(msg.chat.id, "🛠 *Admin Panel*\n\nপ্ল্যাটফর্মের ওপর ক্লিক করে রেঞ্জ সেট বা আপডেট করুন:", {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
    });
});

// টেক্সট মেসেজ ও বাটন হ্যান্ডলার
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    // অ্যাডমিন যখন নতুন রেঞ্জ বা প্ল্যাটফর্মের নাম টাইপ করবে
    if (adminState[chatId]) {
        const state = adminState[chatId];
        const ranges = await loadRanges();
        
        if (state.action === 'wait_range') {
            ranges[state.platform] = text.trim();
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ *${state.platform}* এর নতুন রেঞ্জ সফলভাবে সেট করা হয়েছে।`, { parse_mode: 'Markdown' });
            delete adminState[chatId];
            return;
        } else if (state.action === 'wait_platform') {
            const newPlat = text.trim();
            if (!ranges[newPlat]) {
                ranges[newPlat] = "";
                await saveRanges(ranges);
            }
            bot.sendMessage(chatId, `✅ *${newPlat}* প্ল্যাটফর্মটি যুক্ত হয়েছে। এবার /admin দিয়ে রেঞ্জ সেট করুন।`, { parse_mode: 'Markdown' });
            delete adminState[chatId];
            return;
        }
    }

    // ইউজার যখন মেনু বাটনে ক্লিক করবে
    if (text === "💰 BALANCE") {
        const sentMsg = await bot.sendMessage(chatId, "⏳ *Checking balance...*", { parse_mode: 'Markdown' });
        try {
            const res = await axios.get(`${BASE_URL}/api/v1/balance`, { headers: HEADERS, timeout: 10000 });
            if (res.data.success) {
                bot.editMessageText(`💰 *Account Balance:* \`${res.data.balance}\` ৳`, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
            } else {
                bot.editMessageText("❌ *Failed to load balance.*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
            }
        } catch (error) {
            bot.editMessageText("⚠️ *API Error.*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
        }
    } else if (text === "📱 GET NUMBER") {
        const ranges = await loadRanges();
        let inlineKeyboard = [];
        let row = [];
        
        // শুধুমাত্র যেগুলোর রেঞ্জ অ্যাডমিন সেট করেছে সেগুলোই ইউজার দেখতে পাবে (রেঞ্জ হাইড থাকবে)
        for (const [plat, rg] of Object.entries(ranges)) {
            if (rg) {
                row.push({ text: `💬 🟢 ${plat.toUpperCase()} 🟢`, callback_data: `getnum_${plat}` });
                if (row.length === 2) { inlineKeyboard.push(row); row = []; }
            }
        }
        if (row.length > 0) inlineKeyboard.push(row);

        if (inlineKeyboard.length === 0) {
            return bot.sendMessage(chatId, "⚠️ *এই মুহূর্তে কোনো নাম্বার স্টকে নেই। একটু পর চেষ্টা করুন।*", { parse_mode: 'Markdown' });
        }
        bot.sendMessage(chatId, "📌 *Select a Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } else if (["📊 TRAFFIC", "💸 WITHDRAWAL", "🎁 REFER", "🛠️ SUPPORT", "🔐 2FA ONLINE", "👤 FAKE INFO", "🏆 LEADERBOARD"].includes(text)) {
        bot.sendMessage(chatId, "🛠️ *This feature is under development...*", { parse_mode: 'Markdown' });
    }
});

// ইনলাইন বাটন ক্লিকের হ্যান্ডলার (Callback Queries)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data.startswith('setrange_')) {
        if (chatId !== ADMIN_ID) return;
        const plat = data.split('_')[1];
        adminState[chatId] = { action: 'wait_range', platform: plat };
        bot.sendMessage(chatId, `✏️ \`${plat}\` এর জন্য নতুন রেঞ্জটি টাইপ করে পাঠান (যেমন: 2250787672XXX):`, { parse_mode: 'Markdown' });
        bot.answerCallbackQuery(query.id);
    } 
    else if (data === 'add_platform') {
        if (chatId !== ADMIN_ID) return;
        adminState[chatId] = { action: 'wait_platform' };
        bot.sendMessage(chatId, "✏️ নতুন প্ল্যাটফর্মের নাম টাইপ করে পাঠান (যেমন: Google):");
        bot.answerCallbackQuery(query.id);
    }
    else if (data.startswith('getnum_')) {
        const plat = data.split('_')[1];
        const ranges = await loadRanges();
        const targetRange = ranges[plat];

        if (!targetRange) return bot.answerCallbackQuery(query.id, { text: "❌ রেঞ্জ সেট করা নেই!", show_alert: true });

        bot.deleteMessage(chatId, msgId);
        const sentMsg = await bot.sendMessage(chatId, "⏳ *Generating Number...*", { parse_mode: 'Markdown' });

        try {
            // format: international দেওয়া হয়েছে যাতে কান্ট্রি কোড সহ ফুল নাম্বার আসে
            const res = await axios.post(`${BASE_URL}/api/v1/numbers/get`, { range: targetRange, format: "international" }, { headers: HEADERS, timeout: 15000 });
            if (res.data.success) {
                const markup = { inline_keyboard: [[{ text: "📩 Check OTP", callback_data: `checkotp_${res.data.number_id}` }]] };
                const text = `✅ *Number Generated Successfully!*\n\n📱 *Number:* \`${res.data.number}\`\n🌐 *Platform:* ${plat.toUpperCase()}\n\n_Waiting for OTP... Click 'Check OTP' below._`;
                bot.editMessageText(text, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown', reply_markup: markup });
            } else {
                bot.editMessageText("❌ *এই মুহূর্তে এই রেঞ্জের কোনো নাম্বার স্টকে নেই।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
            }
        } catch (error) {
            bot.editMessageText("⚠️ *API সার্ভার রেসপন্স করছে না।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
        }
        bot.answerCallbackQuery(query.id);
    }
    else if (data.startswith('checkotp_')) {
        const numId = data.split('_')[1];
        bot.answerCallbackQuery(query.id, { text: "Checking OTP..." });

        try {
            const res = await axios.get(`${BASE_URL}/api/v1/numbers/${numId}/sms`, { headers: HEADERS, timeout: 10000 });
            if (res.data.success) {
                if (res.data.otp) {
                    // OTP টি মনস্পেস ব্যাকটিকে দেওয়া হয়েছে, কোডের ওপর ক্লিক করলেই অটো কপি হবে
                    bot.sendMessage(chatId, `🎉 *Your OTP Code:* \`${res.data.otp}\`\n\n_(কোডটি কপি করতে এর ওপর ক্লিক করুন)_`, { parse_mode: 'Markdown' });
                    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
                } else if (res.data.status === 'pending') {
                    bot.answerCallbackQuery(query.id, { text: "⏳ এখনও OTP আসেনি। দয়া করে একটু অপেক্ষা করে আবার চেষ্টা করুন।", show_alert: true });
                } else {
                    bot.answerCallbackQuery(query.id, { text: "⚠️ কোনো OTP পাওয়া যায়নি বা সেশন শেষ।", show_alert: true });
                }
            } else {
                bot.answerCallbackQuery(query.id, { text: "⚠️ এই নাম্বারের সেশনটি এক্সপায়ার হয়ে গেছে।", show_alert: true });
            }
        } catch (error) {
            bot.answerCallbackQuery(query.id, { text: "⚠️ সার্ভার কানেকশন ত্রুটি।", show_alert: true });
        }
    }
});

console.log("Firebase & Express Core Bot is ready for Render!");


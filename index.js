require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');

// --- ১. Render Express Server ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Fire OTP Bot is alive!'));
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
const BASE_URL = 'http://185.190.142.81';
const HEADERS = { 'X-API-Key': API_KEY };

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
let adminState = {};

// --- ৪. Firebase ডাটাবেস ফাংশন ---
async function loadRanges() {
    const doc = await db.collection('bot_settings').doc('ranges').get();
    if (!doc.exists) return {}; 
    return doc.data(); // Format: { "Instagram": { range: "99298XXX", country: "🇧🇩 Bangladesh" } }
}

async function saveRanges(data) {
    await db.collection('bot_settings').doc('ranges').set(data);
}

async function loadForceSubs() {
    const doc = await db.collection('bot_settings').doc('force_subs').get();
    if (!doc.exists) return { channels: [] };
    return doc.data();
}

async function saveForceSubs(channels) {
    await db.collection('bot_settings').doc('force_subs').set({ channels });
}

// --- ৫. ডায়নামিক মেইন মেনু ---
function getMainMenu(chatId) {
    let kb = [
        [{ text: "📱 GET NUMBER" }, { text: "📊 TRAFFIC" }],
        [{ text: "🔐 2FA AUTHENTICATOR" }, { text: "👤 PROFILE INFO" }],
        [{ text: "🎧 SUPPORT" }]
    ];
    // শুধু অ্যাডমিন হলে নিচের বাটনটি যোগ হবে
    if (chatId === ADMIN_ID) {
        kb.push([{ text: "🛠️ ADMIN PANEL" }]);
    }
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

// --- ৬. ফোর্স সাবস্ক্রাইব চেকার ---
async function checkForceSub(chatId) {
    if (chatId === ADMIN_ID) return true; // অ্যাডমিনের জন্য বাইপাস
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
        } catch (e) {
            // যদি বট চ্যানেলে অ্যাডমিন না থাকে
            console.log(`Error checking channel ${ch}:`, e.message);
        }
    }

    if (!isSubscribed) {
        buttons.push([{ text: "✅ Joined (Check Again)", callback_data: "check_joined" }]);
        bot.sendMessage(chatId, "⚠️ *আমাদের বট ব্যবহার করতে হলে নিচের চ্যানেলগুলোতে জয়েন করা বাধ্যতামূলক!* \n\nজয়েন করে 'Joined' বাটনে ক্লিক করুন:", {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
        return false;
    }
    return true;
}

// --- ৭. বটের কমান্ড ও লজিক ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (!(await checkForceSub(chatId))) return;
    
    bot.sendMessage(chatId, "《 👑 FIRE OTP BOT 👑 》\n\n👋 *WELCOME, " + msg.from.first_name + "!*", { 
        parse_mode: 'Markdown', 
        ...getMainMenu(chatId) 
    });
});

// মেইন টেক্সট মেসেজ হ্যান্ডলার
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    // --- অ্যাডমিন স্টেট ম্যানেজমেন্ট (ইনপুট নেওয়া) ---
    if (adminState[chatId]) {
        const state = adminState[chatId];
        
        if (state.action === 'wait_country') {
            state.country = text.trim();
            state.action = 'wait_range';
            bot.sendMessage(chatId, `✅ কান্ট্রি সেট হলো: ${state.country}\n\n✏️ এবার \`${state.platform}\` এর জন্য রেঞ্জ টাইপ করুন (যেমন: 22507XXX):`, { parse_mode: 'Markdown' });
            return;
        } 
        else if (state.action === 'wait_range') {
            const ranges = await loadRanges();
            ranges[state.platform] = { country: state.country, range: text.trim() };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ *${state.platform}* এর রেঞ্জ সফলভাবে আপডেট হয়েছে!`, { parse_mode: 'Markdown' });
            delete adminState[chatId];
            return;
        } 
        else if (state.action === 'wait_channel_add') {
            const subs = await loadForceSubs();
            let channels = subs.channels;
            if (!channels.includes(text.trim())) {
                channels.push(text.trim());
                await saveForceSubs(channels);
            }
            bot.sendMessage(chatId, `✅ চ্যানেল ${text.trim()} যুক্ত হয়েছে! (বটকে ওই চ্যানেলে অ্যাডমিন বানাতে ভুলবেন না)`, { parse_mode: 'Markdown' });
            delete adminState[chatId];
            return;
        }
        else if (state.action === 'wait_channel_remove') {
            const subs = await loadForceSubs();
            let channels = subs.channels.filter(ch => ch !== text.trim());
            await saveForceSubs(channels);
            bot.sendMessage(chatId, `🗑️ চ্যানেল ${text.trim()} রিমুভ করা হয়েছে!`, { parse_mode: 'Markdown' });
            delete adminState[chatId];
            return;
        }
    }

    if (!(await checkForceSub(chatId))) return;

    // --- ইউজার মেনু বাটন ---
    if (text === "🛠️ ADMIN PANEL" && chatId === ADMIN_ID) {
        let markup = { inline_keyboard: [
            [{ text: "⚙️ Manage Ranges", callback_data: "admin_ranges" }],
            [{ text: "📢 Force Sub Settings", callback_data: "admin_force" }]
        ]};
        bot.sendMessage(chatId, "🛠 *Admin Panel*\n\nনিচের অপশনগুলো ম্যানেজ করুন:", { parse_mode: 'Markdown', reply_markup: markup });
    }
    else if (text === "📱 GET NUMBER") {
        const ranges = await loadRanges();
        let inlineKeyboard = [];
        let row = [];
        
        for (const [plat, data] of Object.entries(ranges)) {
            if (data && data.range) {
                row.push({ text: `💬 🟢 ${plat.toUpperCase()} 🟢`, callback_data: `getnum_${plat}` });
                if (row.length === 2) { inlineKeyboard.push(row); row = []; }
            }
        }
        if (row.length > 0) inlineKeyboard.push(row);

        if (inlineKeyboard.length === 0) {
            return bot.sendMessage(chatId, "⚠️ *এই মুহূর্তে কোনো নাম্বার স্টকে নেই।*", { parse_mode: 'Markdown' });
        }
        bot.sendMessage(chatId, "📌 *Select a Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } 
    else if (["📊 TRAFFIC", "🔐 2FA AUTHENTICATOR", "👤 PROFILE INFO", "🎧 SUPPORT"].includes(text)) {
        bot.sendMessage(chatId, "🛠️ *This feature is under development...*", { parse_mode: 'Markdown' });
    }
});

// --- ৮. কলব্যাক কোয়েরি (ইনলাইন বাটন) ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data === "check_joined") {
        if (await checkForceSub(chatId)) {
            bot.deleteMessage(chatId, msgId);
            bot.sendMessage(chatId, "✅ *ধন্যবাদ!* আপনি সফলভাবে জয়েন করেছেন।", { parse_mode: 'Markdown', ...getMainMenu(chatId) });
        } else {
            bot.answerCallbackQuery(query.id, { text: "⚠️ আপনি এখনও সব চ্যানেলে জয়েন করেননি!", show_alert: true });
        }
    }

    // --- অ্যাডমিন প্যানেল নেভিগেশন ---
    else if (data === "admin_ranges" && chatId === ADMIN_ID) {
        const ranges = await loadRanges();
        let inlineKeyboard = [];
        let row = [];
        const platforms = ["Instagram", "Facebook", "Whatsapp", "Telegram", "Google"]; // ডিফল্ট কিছু সাইট
        
        for (const plat of platforms) {
            const status = (ranges[plat] && ranges[plat].range) ? "✅" : "❌";
            row.push({ text: `${status} ${plat}`, callback_data: `setrange_${plat}` });
            if (row.length === 2) { inlineKeyboard.push(row); row = []; }
        }
        if (row.length > 0) inlineKeyboard.push(row);
        bot.editMessageText("⚙️ *Manage Ranges*\n\nরেঞ্জ সেট করতে সাইটে ক্লিক করুন:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
    }
    else if (data === "admin_force" && chatId === ADMIN_ID) {
        const subs = await loadForceSubs();
        let text = "📢 *Force Sub Channels:*\n";
        subs.channels.forEach(c => text += `▪️ ${c}\n`);
        if(subs.channels.length === 0) text += "None";
        
        let markup = { inline_keyboard: [
            [{ text: "➕ Add Channel", callback_data: "force_add" }, { text: "➖ Remove Channel", callback_data: "force_remove" }]
        ]};
        bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
    }
    else if (data === "force_add" && chatId === ADMIN_ID) {
        adminState[chatId] = { action: 'wait_channel_add' };
        bot.sendMessage(chatId, "✏️ চ্যানেলের ইউজারনেম দিন (যেমন: @mychannel):");
        bot.answerCallbackQuery(query.id);
    }
    else if (data === "force_remove" && chatId === ADMIN_ID) {
        adminState[chatId] = { action: 'wait_channel_remove' };
        bot.sendMessage(chatId, "✏️ যে চ্যানেলটি রিমুভ করতে চান তার ইউজারনেম দিন:");
        bot.answerCallbackQuery(query.id);
    }
    else if (data.startsWith('setrange_') && chatId === ADMIN_ID) {
        const plat = data.split('_')[1];
        adminState[chatId] = { action: 'wait_country', platform: plat };
        bot.sendMessage(chatId, `✏️ \`${plat}\` এর জন্য কান্ট্রির নাম ও ফ্ল্যাগ দিন (যেমন: 🇧🇩 Bangladesh):`, { parse_mode: 'Markdown' });
        bot.answerCallbackQuery(query.id);
    }

    // --- ইউজার নাম্বার জেনারেট ---
    else if (data.startsWith('getnum_')) {
        const plat = data.split('_')[1];
        const ranges = await loadRanges();
        const targetData = ranges[plat];

        if (!targetData || !targetData.range) return bot.answerCallbackQuery(query.id, { text: "❌ রেঞ্জ সেট করা নেই!", show_alert: true });

        bot.deleteMessage(chatId, msgId);
        const sentMsg = await bot.sendMessage(chatId, "⏳ *Generating Number...*", { parse_mode: 'Markdown' });

        try {
            const res = await axios.post(`${BASE_URL}/api/v1/numbers/get`, { range: targetData.range, format: "international" }, { headers: HEADERS, timeout: 15000 });
            if (res.data.success) {
                const markup = { inline_keyboard: [[{ text: "📩 Check OTP", callback_data: `checkotp_${res.data.number_id}` }]] };
                
                // কান্ট্রির নাম ও ফ্ল্যাগ যোগ করা হয়েছে
                const text = `✅ *Number Generated Successfully!*\n\n🌍 *Country:* ${targetData.country}\n📱 *Number:* \`${res.data.number}\`\n🌐 *Platform:* ${plat.toUpperCase()}\n\n_Waiting for OTP... Click 'Check OTP' below._`;
                
                bot.editMessageText(text, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown', reply_markup: markup });
            } else {
                bot.editMessageText("❌ *এই মুহূর্তে এই রেঞ্জের কোনো নাম্বার স্টকে নেই।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
            }
        } catch (error) {
            bot.editMessageText("⚠️ *API সার্ভার এরর।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
        }
        bot.answerCallbackQuery(query.id);
    }
    
    // --- OTP চেক ---
    else if (data.startsWith('checkotp_')) {
        const numId = data.split('_')[1];
        bot.answerCallbackQuery(query.id, { text: "Checking OTP..." });

        try {
            const res = await axios.get(`${BASE_URL}/api/v1/numbers/${numId}/sms`, { headers: HEADERS, timeout: 10000 });
            if (res.data.success) {
                if (res.data.otp) {
                    bot.sendMessage(chatId, `🎉 *Your OTP Code:* \`${res.data.otp}\``, { parse_mode: 'Markdown' });
                    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
                } else if (res.data.status === 'pending') {
                    bot.answerCallbackQuery(query.id, { text: "⏳ এখনও OTP আসেনি...", show_alert: true });
                } else {
                    bot.answerCallbackQuery(query.id, { text: "⚠️ OTP পাওয়া যায়নি।", show_alert: true });
                }
            } else {
                bot.answerCallbackQuery(query.id, { text: "⚠️ সেশন এক্সপায়ার হয়ে গেছে।", show_alert: true });
            }
        } catch (error) {
            bot.answerCallbackQuery(query.id, { text: "⚠️ সার্ভার ত্রুটি।", show_alert: true });
        }
    }
});

console.log("Ultimate Pro Bot is Ready!");

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const { authenticator } = require('otplib'); // 2FA এর জন্য নতুন প্যাকেজ

// --- ১. Render Express Server ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Premium Fire OTP Bot is Running!'));
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
const activePolls = new Map(); // Auto-polling কন্ট্রোল করার জন্য

// --- ৪. ডাটাবেস ফাংশনসমূহ ---
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
    let key = `${plat.toUpperCase()} - ${country}`;
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
    return '💬';
}

// প্রিমিয়াম কীবোর্ড লেআউট
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

// --- ৬. অটো-পোলিং ও OTP সেন্ডিং ফাংশন ---
function startOtpPolling(chatId, msgId, numId, phone, plat, country, userFirstName) {
    let attempts = 0;
    const maxAttempts = 90; // ৩ মিনিট

    const interval = setInterval(async () => {
        try {
            const res = await axios.get(`${BASE_URL}/api/v1/numbers/${numId}/sms`, { headers: HEADERS });
            
            if (res.data.success && res.data.otp) {
                clearInterval(interval);
                activePolls.delete(numId);
                const otpCode = res.data.otp;
                
                const text = `✅ *Number Generated & OTP Received!*\n\n🌍 *Country:* ${country}\n📱 *Number:* \`${phone}\`\n🌐 *Platform:* ${plat.toUpperCase()}`;
                bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

                const icon = getPlatIcon(plat);
                const flag = country.split(' ')[0] || "🌍"; 
                const platName = plat.charAt(0).toUpperCase() + plat.slice(1);
                const formatPhone = phone.startsWith('+') ? phone : '+' + phone;
                
                const otpMsgText = `${flag} ${icon} ${platName} ${formatPhone}`;
                const copyFullText = `Platform: ${platName}\nCountry: ${country}\nNumber: ${formatPhone}\nOTP: ${otpCode}`;
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: `📋  ${otpCode}`, copy_text: { text: otpCode } }],
                        [{ text: `📋  Copy Full Message`, copy_text: { text: copyFullText } }],
                        [{ text: "💬 OTP Group", url: "https://t.me/otp_number_grp" }]
                    ]
                };

                bot.sendMessage(chatId, otpMsgText, { reply_markup: replyMarkup });
                updateTraffic(plat, country);

                const maskedPhone = maskNumber(phone);
                const groupMsgText = `${flag} ${icon} ${platName} ${maskedPhone}`;
                bot.sendMessage(OTP_GROUP_ID, groupMsgText, { reply_markup: replyMarkup })
                   .catch(e => console.log("Group Error:", e.message));
                
                return;
            }
        } catch (err) { }

        attempts++;
        if (attempts >= maxAttempts) {
            clearInterval(interval);
            activePolls.delete(numId);
            bot.editMessageText(`⚠️ *OTP Timeout!*\n\n🌍 *Country:* ${country}\n📱 *Number:* \`${phone}\`\n🌐 *Platform:* ${plat.toUpperCase()}\n\n_৩ মিনিটের মধ্যে কোনো OTP আসেনি। দয়া করে Change Number এ ক্লিক করে নতুন নাম্বার নিন।_`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        }
    }, 2000); 
    
    activePolls.set(numId, interval);
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
    if (!(await checkForceSub(msg.chat.id))) return;
    bot.sendMessage(msg.chat.id, "《 👑 FIRE OTP BOT 👑 》\n\n👋 *WELCOME, " + msg.from.first_name + "!*", { parse_mode: 'Markdown', ...getMainMenu(msg.chat.id) });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    // --- State Handler (Admin & 2FA) ---
    if (adminState[chatId]) {
        const state = adminState[chatId];
        
        // 2FA Secret Input
        if (state.action === 'wait_2fa_secret') {
            const secret = text.trim().replace(/\s+/g, '').toUpperCase();
            try {
                authenticator.generate(secret); // Test if valid
                const saved2fa = await get2FA(chatId);
                saved2fa.push({ secret: secret, added: new Date().toISOString() });
                await save2FA(chatId, saved2fa);
                bot.sendMessage(chatId, `✅ *2FA Secret সফলভাবে সেভ হয়েছে!*\n\nএখন থেকে '🔐 2FA AUTHENTICATOR' এ ক্লিক করে OTP নিতে পারবেন।`, { parse_mode: 'Markdown' });
            } catch (e) {
                bot.sendMessage(chatId, `❌ *ভুল বা ইনভ্যালিড সিক্রেট কোড!* আবার চেষ্টা করুন।`, { parse_mode: 'Markdown' });
            }
            delete adminState[chatId]; return;
        }
        
        // Admin Inputs
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
        
        for (const [plat, countries] of Object.entries(ranges)) {
            if (Object.keys(countries).length > 0) {
                row.push({ text: `💬  ${plat.toUpperCase()} `, callback_data: `u_site_${plat}` });
                if (row.length === 2) { inlineKeyboard.push(row); row = []; }
            }
        }
        if (row.length > 0) inlineKeyboard.push(row);
        if (inlineKeyboard.length === 0) return bot.sendMessage(chatId, "⚠️ *কোনো সাইট বা নাম্বার স্টকে নেই।*", { parse_mode: 'Markdown' });
        
        bot.sendMessage(chatId, "📌 *Select a Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    }
    else if (text === "📥 INBOX") {
        const lastOrder = userLastOrder.get(chatId);
        if (!lastOrder) return bot.sendMessage(chatId, "⚠️ *আপনার কোনো রিসেন্ট নাম্বার নেই!*", { parse_mode: 'Markdown' });
        
        const sentMsg = await bot.sendMessage(chatId, "⏳ *Checking Inbox...*", { parse_mode: 'Markdown' });
        try {
            const res = await axios.get(`${BASE_URL}/api/v1/numbers/${lastOrder.numId}/sms`, { headers: HEADERS, timeout: 10000 });
            if (res.data.success && res.data.otp) {
                const icon = getPlatIcon(lastOrder.plat);
                const flag = lastOrder.country.split(' ')[0] || "🌍"; 
                const platName = lastOrder.plat.charAt(0).toUpperCase() + lastOrder.plat.slice(1);
                const formatPhone = lastOrder.phone.startsWith('+') ? lastOrder.phone : '+' + lastOrder.phone;
                
                const copyFullText = `Platform: ${platName}\nCountry: ${lastOrder.country}\nNumber: ${formatPhone}\nOTP: ${res.data.otp}`;
                
                const replyMarkup = {
                    inline_keyboard: [
                        [{ text: `📋  ${res.data.otp}`, copy_text: { text: res.data.otp } }],
                        [{ text: `📋  Copy Full Message`, copy_text: { text: copyFullText } }]
                    ]
                };
                
                bot.deleteMessage(chatId, sentMsg.message_id);
                bot.sendMessage(chatId, `📥 *Latest Inbox for ${platName}:*\n\n${flag} ${icon} ${platName} ${formatPhone}`, { reply_markup: replyMarkup, parse_mode: 'Markdown' });

            } else if (res.data.status === 'pending') {
                bot.editMessageText(`⏳ *${lastOrder.plat.toUpperCase()}* (\`${lastOrder.phone}\`) এর OTP এখনও আসেনি। দয়া করে অপেক্ষা করুন।`, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
            } else {
                bot.editMessageText("⚠️ *কোনো লেটেস্ট OTP পাওয়া যায়নি বা সেশন শেষ।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
            }
        } catch (e) {
             bot.editMessageText("⚠️ *সার্ভারের সাথে কানেক্ট করা যাচ্ছে না।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
        }
    }
    else if (text === "📊 TRAFFIC") {
        const traffic = await getTraffic();
        if (Object.keys(traffic).length === 0) return bot.sendMessage(chatId, "⚠️ *এখনও কোনো ট্রাফিক ডাটা নেই।*", { parse_mode: 'Markdown' });
        
        let sorted = Object.entries(traffic).sort((a, b) => b[1] - a[1]);
        let msgText = "📊 *OTP TRAFFIC LEADERBOARD*\n\n";
        sorted.forEach(([key, count], index) => {
            msgText += `*${index + 1}.* ${key} ➔ \`${count} OTPs\`\n`;
        });
        bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }
    else if (text === "👤 PROFILE INFO") {
        const p = msg.from;
        const profileText = `👤 *PROFILE INFORMATION*\n\n` +
                            `🆔 *Your ID:* \`${chatId}\`\n` +
                            `👤 *Name:* ${p.first_name} ${p.last_name || ''}\n` +
                            `🔗 *Username:* ${p.username ? '@'+p.username : 'N/A'}\n` +
                            `🌐 *Language:* ${p.language_code ? p.language_code.toUpperCase() : 'N/A'}\n\n` +
                            `_Keep enjoying the premium service!_`;
        bot.sendMessage(chatId, profileText, { parse_mode: 'Markdown' });
    }
    else if (text === "🔐 2FA AUTHENTICATOR") {
        const saved2fa = await get2FA(chatId);
        let markup = { inline_keyboard: [[{ text: "➕ Add New 2FA Secret", callback_data: "add_2fa" }]] };
        
        if (saved2fa.length === 0) {
            bot.sendMessage(chatId, "🔐 *2FA Authenticator*\n\nআপনার কোনো 2FA সিক্রেট কোড সেভ করা নেই। নিচের বাটনে ক্লিক করে নতুন কোড অ্যাড করুন:", { parse_mode: 'Markdown', reply_markup: markup });
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
        bot.sendMessage(chatId, "🎧 *SUPPORT CENTER*\n\nবট ব্যবহার করতে কোনো সমস্যা হলে বা হেল্প লাগলে সরাসরি অ্যাডমিনের সাথে যোগাযোগ করুন:", { parse_mode: 'Markdown', reply_markup: markup });
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

    // --- 2FA Functions ---
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
            saved2fa.splice(index, 1);
            await save2FA(chatId, saved2fa);
            bot.editMessageText("✅ *2FA Secret সফলভাবে ডিলিট করা হয়েছে!*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        }
        bot.answerCallbackQuery(query.id);
    }

    // --- Admin: Sites, Ranges, Force Subs ---
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
        bot.sendMessage(chatId, "✏️ নতুন সাইটের নাম দিন:");
        bot.answerCallbackQuery(query.id);
    }
    else if (data.startsWith('del_site_') && chatId === ADMIN_ID) {
        const plat = data.split('del_site_')[1];
        const ranges = await loadRanges();
        delete ranges[plat]; await saveRanges(ranges);
        bot.editMessageText(`✅ ${plat} ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId });
    }
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
        const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
        const ranges = await loadRanges();
        if (ranges[plat] && ranges[plat][country]) { delete ranges[plat][country]; await saveRanges(ranges); }
        bot.editMessageText(`✅ রেঞ্জ ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId });
    }
    else if (data === "adm_force" && chatId === ADMIN_ID) {
        const subs = await loadForceSubs();
        let text = "📢 *Force Sub Channels:*\n";
        subs.channels.forEach(c => text += `▪️ ${c}\n`);
        if(subs.channels.length === 0) text += "None\n";
        let markup = { inline_keyboard: [[{ text: "➕ Add Channel", callback_data: "force_add" }, { text: "➖ Remove Channel", callback_data: "force_remove" }]]};
        bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
    }
    else if (data === "force_add" && chatId === ADMIN_ID) {
        adminState[chatId] = { action: 'wait_channel_add' };
        bot.sendMessage(chatId, "✏️ চ্যানেলের ইউজারনেম দিন (যেমন: @mychannel):"); bot.answerCallbackQuery(query.id);
    }
    else if (data === "force_remove" && chatId === ADMIN_ID) {
        adminState[chatId] = { action: 'wait_channel_remove' };
        bot.sendMessage(chatId, "✏️ যে চ্যানেলটি রিমুভ করতে চান তার ইউজারনেম দিন:"); bot.answerCallbackQuery(query.id);
    }

    // --- User: Get Number Flow ---
    else if (data === "change_num") {
        // Stop polling if active
        const lastOrder = userLastOrder.get(chatId);
        if (lastOrder && activePolls.has(lastOrder.numId)) {
            clearInterval(activePolls.get(lastOrder.numId));
            activePolls.delete(lastOrder.numId);
        }
        bot.editMessageText("❌ *Number Cancelled.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        // Redirect to Get Number
        bot.sendMessage(chatId, "📌 *Select a New Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]] } });
    }
    else if (data === "main_menu") {
        bot.deleteMessage(chatId, msgId);
        bot.sendMessage(chatId, "《 👑 FIRE OTP BOT 👑 》", { parse_mode: 'Markdown', ...getMainMenu(chatId) });
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
        
        bot.editMessageText(`📌 *Select Country for ${plat.toUpperCase()}:*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }});
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

                const text = `✅ *Number Generated Successfully!*\n\n🌍 *Country:* ${country}\n📱 *Number:* \`${res.data.number}\`\n🌐 *Platform:* ${plat.toUpperCase()}\n\n⏳ _অটোমেটিক OTP চেক করা হচ্ছে..._`;
                
                // নতুন Action Buttons
                const actionMarkup = {
                    inline_keyboard: [
                        [{ text: "🔄 Refresh", callback_data: `refresh_${res.data.number_id}` }, { text: "❌ Change Number", callback_data: "change_num" }],
                        [{ text: "💬 OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}` }]
                    ]
                };
                
                bot.editMessageText(text, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown', reply_markup: actionMarkup });
                
                startOtpPolling(chatId, sentMsg.message_id, res.data.number_id, res.data.number, plat, country, query.from.first_name);
            } else {
                bot.editMessageText("❌ *এই মুহূর্তে এই কান্ট্রির কোনো নাম্বার স্টকে নেই।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
            }
        } catch (error) {
            bot.editMessageText("⚠️ *API সার্ভার রেসপন্স করছে না।*", { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'Markdown' });
        }
        bot.answerCallbackQuery(query.id);
    }
    else if (data.startsWith('refresh_')) {
        bot.answerCallbackQuery(query.id, { text: "🔄 Checking API..." });
        // Refresh button just acknowledges. Polling is already running in the background.
    }
});

console.log("Ultimate Premium BOT is Alive!");

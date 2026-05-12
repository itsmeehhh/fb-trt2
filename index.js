require("dotenv").config();
const express = require("express");
const axios   = require("axios");

const app = express();
app.use(express.json());

// ── إعدادات ──────────────────────────────────────────────────
const PAGE_TOKEN    = process.env.PAGE_TOKEN    || "";
const VERIFY_TOKEN  = process.env.VERIFY_TOKEN  || "abcd1234";
const TRANSLATE_API = process.env.TRANSLATE_API || "https://trt-php.vercel.app/translate.php";
const PORT          = process.env.PORT          || 8993;
const DEFAULT_LANG  = process.env.DEFAULT_LANG  || "ar";
const REVERSE_LANG  = process.env.REVERSE_LANG  || "en";
const TTS_ENABLED   = process.env.TTS_ENABLED   === "true";
const OWNER_1       = process.env.OWNER_1       || "amine.xyz";
const OWNER_2       = process.env.OWNER_2       || "oussama.bakrine";
const FB_API        = "https://graph.facebook.com/v19.0/me/messages";

// ── اللغات المدعومة ───────────────────────────────────────────
const LANGUAGES = [
  { code: "en", name: "🇬🇧 English"    },
  { code: "ar", name: "🇸🇦 العربية"    },
  { code: "fr", name: "🇫🇷 Français"   },
  { code: "de", name: "🇩🇪 Deutsch"    },
  { code: "es", name: "🇪🇸 Español"    },
  { code: "it", name: "🇮🇹 Italiano"   },
  { code: "pt", name: "🇵🇹 Português"  },
  { code: "ru", name: "🇷🇺 Русский"    },
  { code: "tr", name: "🇹🇷 Türkçe"     },
  { code: "zh", name: "🇨🇳 中文"       },
  { code: "ja", name: "🇯🇵 日本語"     },
  { code: "ko", name: "🇰🇷 한국어"     },
  { code: "hi", name: "🇮🇳 Hindi"      },
  { code: "fa", name: "🇮🇷 فارسی"      },
  { code: "nl", name: "🇳🇱 Nederlands" },
  { code: "pl", name: "🇵🇱 Polski"     },
  { code: "sv", name: "🇸🇪 Svenska"    },
  { code: "uk", name: "🇺🇦 Українська" },
  { code: "ur", name: "🇵🇰 اردو"       },
];

// ── جلسات المستخدمين (RAM) ────────────────────────────────────
const sessions = {};

function getSession(uid) {
  if (!sessions[uid]) {
    sessions[uid] = {
      lang:       DEFAULT_LANG,
      step:       "idle",
      count:      0,
      tts:        TTS_ENABLED,
      lastText:   "",
      lastResult: "",
    };
  }
  return sessions[uid];
}

// ── ذاكرة مؤقتة للترجمات ─────────────────────────────────────
const cache = {};
function cacheKey(text, lang) {
  return `${lang}:${text.slice(0, 80).toLowerCase()}`;
}

// ── كشف اللغة العربية ─────────────────────────────────────────
function isArabic(text) {
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return arabicChars / text.length > 0.3;
}

// ── Rate limiting بسيط ────────────────────────────────────────
const rateMap = {};
function isRateLimited(uid) {
  const now = Date.now();
  if (!rateMap[uid]) rateMap[uid] = { count: 0, start: now };
  const r = rateMap[uid];
  if (now - r.start > 60000) { r.count = 0; r.start = now; }
  r.count++;
  return r.count > 30;
}

// ════════════════════════════════════════════════════════════
//  إرسال رسائل Facebook
// ════════════════════════════════════════════════════════════

async function send(uid, body) {
  try {
    await axios.post(FB_API, { recipient: { id: uid }, ...body },
      { params: { access_token: PAGE_TOKEN }, timeout: 8000 });
  } catch (e) {
    console.error("❌ FB send error:", e.response?.data || e.message);
  }
}

function sendText(uid, text) {
  return send(uid, { message: { text: String(text).slice(0, 2000) } });
}

function sendTyping(uid) {
  return send(uid, { sender_action: "typing_on" });
}

function sendSeen(uid) {
  return send(uid, { sender_action: "mark_seen" });
}

// ════════════════════════════════════════════════════════════
//  رسائل البوت
// ════════════════════════════════════════════════════════════

function langName(code) {
  return LANGUAGES.find(l => l.code === code)?.name || code;
}

function buildLangMenu() {
  const lines = LANGUAGES.map((l, i) =>
    `${String(i + 1).padStart(2, " ")}. ${l.name}`
  );
  const half = Math.ceil(lines.length / 2);
  return [
    "🌍 اختر لغة الترجمة:\n─────────────────\n" +
    lines.slice(0, half).join("\n"),
    lines.slice(half).join("\n") +
    "\n─────────────────\n✏️ اكتب الرقم فقط"
  ];
}

function welcomeMsg(sess) {
  return (
    `👋 أهلاً! أنا بوت الترجمة الذكي 🌐\n\n` +
    `✍️ اكتب أي نص وسأترجمه فوراً!\n\n` +
    `🔄 الترجمة العكسية تلقائية:\n` +
    `  • نص عربي   → ${langName(sess.lang)}\n` +
    `  • نص أجنبي  → 🇸🇦 العربية\n\n` +
    `─────────────────\n` +
    `📌 اكتب:\n` +
    `  م  ← تغيير اللغة المستهدفة\n` +
    `  ص  ← تشغيل/إيقاف الصوت\n` +
    `  ح  ← حالتك\n` +
    `─────────────────\n` +
    `👨‍💻 fb.com/MoroccoAI.Official`
  );
}

function statusMsg(uid) {
  const sess = getSession(uid);
  const up   = Math.floor(process.uptime());
  return (
    `📊 حالتك:\n` +
    `─────────────────\n` +
    `🔄 الترجمة العكسية:\n` +
    `  • نص عربي   → ${langName(sess.lang)}\n` +
    `  • نص أجنبي  → 🇸🇦 العربية\n` +
    `🔊 الصوت: ${sess.tts ? "✅ مفعّل" : "❌ معطّل"}\n` +
    `📝 ترجماتك: ${sess.count}\n` +
    `⏱ وقت التشغيل: ${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m\n` +
    `─────────────────\n` +
    `👨‍💻 @${OWNER_1}  |  @${OWNER_2}`
  );
}

// ════════════════════════════════════════════════════════════
//  Translation API
// ════════════════════════════════════════════════════════════

async function translate(text, lang) {
  const key = cacheKey(text, lang);
  if (cache[key]) return { ...cache[key], cached: true };

  const { data } = await axios.get(TRANSLATE_API, {
    params: { lang, text },
    timeout: 10000,
  });

  if (!data?.result) throw new Error("Invalid API response");

  const result = { result: data.result, detect: data.detect || "?" };
  cache[key] = result;
  return { ...result, cached: false };
}

// ════════════════════════════════════════════════════════════
//  المعالج الرئيسي
// ════════════════════════════════════════════════════════════

async function handleMsg(uid, text) {
  text = text.trim();
  if (!text) return;

  await sendSeen(uid);

  if (isRateLimited(uid)) {
    await sendText(uid, "⏳ كثير من الطلبات، انتظر دقيقة.");
    return;
  }

  const sess = getSession(uid);
  await sendTyping(uid);

  // ── وضع اختيار اللغة ──────────────────────────────────────
  if (sess.step === "choosing_lang") {
    const num = parseInt(text);
    if (!isNaN(num) && num >= 1 && num <= LANGUAGES.length) {
      sess.lang = LANGUAGES[num - 1].code;
      sess.step = "idle";
      await sendText(uid,
        `✅ تم! اللغة المستهدفة الجديدة:\n${langName(sess.lang)}\n\n` +
        `🔄 الوضع الحالي:\n` +
        `  • نص عربي   → ${langName(sess.lang)}\n` +
        `  • نص أجنبي  → 🇸🇦 العربية\n\n` +
        `✍️ اكتب أي نص لأترجمه الآن 👇`
      );
    } else {
      await sendText(uid, `❌ رقم غير صحيح (1 - ${LANGUAGES.length})\nاكتب الرقم فقط أو "0" للإلغاء`);
    }
    return;
  }

  // ── الأوامر ────────────────────────────────────────────────

  if (text === "م" || text === "0م" || /^(lang|language|لغة|غير)$/i.test(text)) {
    sess.step = "choosing_lang";
    const [p1, p2] = buildLangMenu();
    await sendText(uid, p1);
    await sendText(uid, p2);
    return;
  }

  if (text === "ص" || /^(tts|صوت|sound|voice)$/i.test(text)) {
    if (!TTS_ENABLED) {
      await sendText(uid, "⚠️ ميزة الصوت غير مفعّلة من الإعدادات.");
      return;
    }
    sess.tts = !sess.tts;
    await sendText(uid, sess.tts ? "🔊 تم تفعيل الصوت!" : "🔇 تم إيقاف الصوت.");
    return;
  }

  if (text === "ح" || /^(status|حالة|حالتي)$/i.test(text)) {
    await sendText(uid, statusMsg(uid));
    return;
  }

  if (text === "0" || /^(الغ|إلغاء|cancel|back|رجوع)$/i.test(text)) {
    sess.step = "idle";
    await sendText(uid, "↩️ تم الإلغاء.\n✍️ اكتب أي نص لأترجمه.");
    return;
  }

  if (/^(مرحبا|هلا|سلام|أهلا|اهلا|hi|hello|hey|start|ابدأ|بدأ)$/i.test(text)) {
    await sendText(uid, welcomeMsg(sess));
    return;
  }

  // ── الترجمة العكسية التلقائية ──────────────────────────────
  if (text.length > 500) {
    await sendText(uid, "⚠️ النص طويل. الحد الأقصى 500 حرف.");
    return;
  }

  try {
    // عربي → اللغة المختارة | أي لغة أخرى → عربي دائماً
    const targetLang = isArabic(text) ? sess.lang : "ar";

    const { result, detect, cached } = await translate(text, targetLang);

    const fromName = LANGUAGES.find(l => l.code === detect)?.name || detect;
    const toName   = langName(targetLang);

    const reply =
      `${fromName}:\n${text}\n` +
      `─────────────────\n` +
      `${toName}:\n${result}` +
      (cached ? "\n⚡" : "") +
      `\n─────────────────\n` +
      `م ← غيّر اللغة  |  ح ← حالتك`;

    await sendText(uid, reply);
    sess.count++;
    sess.lastText   = text;
    sess.lastResult = result;

  } catch (err) {
    console.error("❌ Translate error:", err.message);
    await sendText(uid, "❌ فشل في الترجمة، حاول مرة أخرى.");
  }
}

// ════════════════════════════════════════════════════════════
//  Webhook
// ════════════════════════════════════════════════════════════

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== "page") return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (event.message?.is_echo) continue;

      const uid  = event.sender?.id;
      const text = event.message?.text || event.postback?.payload;
      if (!uid || !text) continue;

      console.log(`📨 [${uid}] ${text.slice(0, 60)}`);
      handleMsg(uid, text).catch(e => console.error("Handler error:", e.message));
    }
  }
});

app.get("/", (_, res) => res.json({
  status: "🟢 Online",
  bot: "Facebook Translate Bot",
  powered_by: "MoroccoAI",
  mode: "auto-reverse (ar ↔ selected lang)",
  owners: [`@${OWNER_1}`, `@${OWNER_2}`],
  uptime: `${Math.floor(process.uptime())}s`,
}));

// ── تشغيل ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🌐 Facebook Translate Bot              ║
║   Powered by MoroccoAI                  ║
╠══════════════════════════════════════════╣
║  🚀 Port    : ${String(PORT).padEnd(25)}║
║  🔄 Mode    : Auto-Reverse (ar ↔ lang)   ║
║  🌍 Default : ${DEFAULT_LANG.padEnd(25)}║
║  🔊 TTS     : ${String(TTS_ENABLED).padEnd(25)}║
╠══════════════════════════════════════════╣
║  👨‍💻 @${OWNER_1.padEnd(36)}║
║  👨‍💻 @${OWNER_2.padEnd(36)}║
╚══════════════════════════════════════════╝
  `);
});

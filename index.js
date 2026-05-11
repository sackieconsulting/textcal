const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const cron = require("node-cron");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const DB_FILE = "events.json";

function loadEvents() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {}
  return [];
}

function saveEvents(events) {
  fs.writeFileSync(DB_FILE, JSON.stringify(events, null, 2));
}

function getTodayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
}

function formatTime(time) {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  return `${h % 12 || 12}:${m.toString().padStart(2,"0")}${ampm}`;
}

function formatDate(dateStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(y, mo-1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

const pendingConfirmations = {};

async function processMessage(userMessage, events) {
  const now = new Date();
  const currentDate = now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });

  const prompt = `You are a calendar assistant for someone with ADHD. Be warm and brief like a text message.

Current date/time: ${currentDate}
Current saved events: ${JSON.stringify(events)}
User message: "${userMessage}"

Respond with ONLY a raw JSON object. No markdown. No backticks. Just the JSON.

The JSON must have exactly these fields:
- action: one of "add", "confirm_add", "query", "delete", "unknown"
- reply: short friendly text reply (1-3 sentences, SMS style)
- event: null OR object with {id, title, date (YYYY-MM-DD), time (HH:MM or null), endTime (HH:MM or null)}
- pendingEvent: null OR same shape as event (used when conflict exists)

Logic:
- If user adds an event with no conflict: action="add", populate event
- If user adds an event that conflicts: action="confirm_add", populate pendingEvent, ask if they want to save anyway
- If user asks about availability or schedule: action="query"
- If user wants to delete: action="delete", populate event with id of matching event
- Use short random IDs like "a1b2" for new events
- For relative dates use the current date to calculate`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = response.content?.map(i => i.text || "").join("") || "";
  let parsed = null;
  try { parsed = JSON.parse(rawText.trim()); } catch {}
  if (!parsed) {
    try {
      const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      parsed = JSON.parse(stripped);
    } catch {}
  }
  if (!parsed) {
    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    } catch {}
  }
  return parsed;
}

async function sendSMS(to, body) {
  await twilioClient.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });
}

app.post("/sms", async (req, res) => {
  const userMessage = req.body.Body?.trim() || "";
  const from = req.body.From;
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  try {
    let events = loadEvents();
    let replyText = "";
    const lowerMsg = userMessage.toLowerCase();
    const isPendingConfirm = pendingConfirmations[from];

    if (isPendingConfirm && (lowerMsg === "yes" || lowerMsg === "y" || lowerMsg === "yeah" || lowerMsg === "yep" || lowerMsg === "save it")) {
      events.push(isPendingConfirm);
      saveEvents(events);
      delete pendingConfirmations[from];
      replyText = `Saved! ✓ ${isPendingConfirm.title} on ${formatDate(isPendingConfirm.date)}${isPendingConfirm.time ? " at " + formatTime(isPendingConfirm.time) : ""} is on your calendar.`;
    } else if (isPendingConfirm && (lowerMsg === "no" || lowerMsg === "n" || lowerMsg === "nope" || lowerMsg === "skip")) {
      delete pendingConfirmations[from];
      replyText = "No problem, I skipped it!";
    } else {
      const result = await processMessage(userMessage, events);
      if (!result) {
        replyText = "Sorry, I had trouble with that. Try again!";
      } else if (result.action === "add" && result.event) {
        events.push(result.event);
        saveEvents(events);
        replyText = result.reply;
      } else if (result.action === "confirm_add" && result.pendingEvent) {
        pendingConfirmations[from] = result.pendingEvent;
        replyText = result.reply;
      } else if (result.action === "delete" && result.event?.id) {
        events = events.filter(e => e.id !== result.event.id);
        saveEvents(events);
        replyText = result.reply;
      } else {
        replyText = result.reply || "Got it!";
      }
    }
    await sendSMS(from, replyText);
  } catch (err) {
    console.error("Error:", err);
    await sendSMS(from, "Something went wrong on my end, try again!");
  }
});

cron.schedule("0 8 * * 1", async () => {
  const events = loadEvents();
  const today = getTodayStr();
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  const nextWeekStr = nextWeek.toISOString().split("T")[0];
  const weekEvents = events.filter(e => e.date >= today && e.date <= nextWeekStr).sort((a, b) => a.date.localeCompare(b.date));
  let msg = "📅 Good morning! Here's your week:\n\n";
  if (weekEvents.length === 0) {
    msg += "Nothing scheduled — enjoy the free week!";
  } else {
    weekEvents.forEach(e => { msg += `• ${formatDate(e.date)}: ${e.title}${e.time ? " at " + formatTime(e.time) : ""}\n`; });
  }
  await sendSMS(process.env.USER_PHONE_NUMBER, msg);
}, { timezone: "America/Toronto" });

cron.schedule("0 20 * * *", async () => {
  const events = loadEvents();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];
  const tomorrowEvents = events.filter(e => e.date === tomorrowStr);
  if (tomorrowEvents.length === 0) return;
  let msg = "⏰ Reminder for tomorrow:\n\n";
  tomorrowEvents.forEach(e => { msg += `• ${e.title}${e.time ? " at " + formatTime(e.time) : ""}\n`; });
  await sendSMS(process.env.USER_PHONE_NUMBER, msg);
}, { timezone: "America/Toronto" });

cron.schedule("0 7 * * *", async () => {
  const events = loadEvents();
  const today = getTodayStr();
  const todayEvents = events.filter(e => e.date === today);
  if (todayEvents.length === 0) return;
  let msg = "☀️ Today you have:\n\n";
  todayEvents.forEach(e => { msg += `• ${e.title}${e.time ? " at " + formatTime(e.time) : ""}\n`; });
  await sendSMS(process.env.USER_PHONE_NUMBER, msg);
}, { timezone: "America/Toronto" });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TextCal running on port ${PORT}`));

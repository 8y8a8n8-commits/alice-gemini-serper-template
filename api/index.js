const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash"
];

// Внутри одной сессии храним последние 3 пары вопрос-ответ.
// Состояние Алисы ограничено по размеру, поэтому не записываем туда весь диалог.
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_MESSAGE_CHARS = 260;
const MAX_ALICE_TEXT = 1024;
const MAX_SESSION_STATE_BYTES = 900;
const TOTAL_RESPONSE_BUDGET_MS = 5000; 
const SERPER_TIMEOUT_MS = 1200;
const GEMINI_TIMEOUT_MS = 3000;

const SYSTEM_PROMPT = `
<role>
Ты — Джарвис, персональный голосовой помощник Яна. Отвечай по-русски, кратко, умно и естественно.
</role>

<conversation>
Всегда учитывай историю диалога. Если пользователь говорит «а он», «а это», «сколько», «почему», «тогда», «продолжи» или задаёт короткий уточняющий вопрос, восстанови, к чему относится реплика, из предыдущих сообщений. Не проси повторить вопрос, если смысл можно восстановить из истории.
</conversation>

<voice>
Ответ предназначен для прослушивания на колонке. Не используй Markdown, таблицы, длинные списки, спецсимволы, скобки и ссылки в ответе. Говори короткими абзацами. Сначала дай прямой ответ, затем важную оговорку или следующий шаг.
</voice>

<rules>
Не выдумывай факты. Если передан контекст поиска, используй его только для относящихся к вопросу сведений. Если данных недостаточно, честно скажи об этом. Обращайся к пользователю Ян, когда это естественно.
</rules>

<profile>
Пользователь: Ян. Город: Севастополь. Профессия: инженер строительного контроля в электромонтажной компании. Интересы: электрика, строительный контроль, мотоциклы, рыбалка, путешествия, бизнес и ИИ.
</profile>
`;

const HELP_TEXT = "Я умею отвечать на вопросы, искать актуальную информацию, помогать со строительным контролем и электромонтажом, мотоциклами, рыбалкой, путешествиями, бизнесом и ИИ. Можешь спросить меня обычной фразой или сказать: найди информацию о чём-нибудь.";

function byteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { return Infinity; }
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function fitAliceText(value) {
  const text = cleanText(value);
  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";
  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("! "), candidate.lastIndexOf("? "));
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();
  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: cleanText(item.text).slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

function normalizeHistory(history) {
  const source = safeHistory(history);
  const result = [];
  for (const item of source) {
    const last = result[result.length - 1];
    if (last && last.role === item.role) {
      last.text = `${last.text} ${item.text}`.slice(0, MAX_HISTORY_MESSAGE_CHARS);
    } else {
      result.push({ role: item.role, text: item.text });
    }
  }
  while (result.length && result[0].role !== "user") result.shift();
  return result.slice(-MAX_HISTORY_MESSAGES);
}

function trimHistoryToBudget(history) {
  let result = normalizeHistory(history);
  while (result.length && byteLength({ history: result }) > MAX_SESSION_STATE_BYTES) result = result.slice(1);
  return result;
}

// В разных тестах и версиях интеграции состояние может приходить в немного разном виде.
function readSessionHistory(body) {
  const candidates = [
    body?.state?.session?.history,
    body?.state?.session?.value?.history,
    body?.state?.session_state?.history,
    body?.session_state?.history
  ];
  for (const candidate of candidates) {
    const history = safeHistory(candidate);
    if (history.length) return history;
  }
  return [];
}

function aliceResponse(text, endSession = false, history = []) {
  const safe = trimHistoryToBudget(history);
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      // text Алиса сама озвучивает на колонке; отдельный tts не нужен.
      end_session: endSession
    },
    session_state: { history: safe }
  };
}

function hasSearchIntent(body, text) {
  const intents = body?.request?.nlu?.intents;
  // Алиса часто не ставит intent.search на обычные вопросы. Поэтому ищем
  // автоматически, если вопрос касается текущей ситуации, места, цены,
  // отзывов, правил или содержит естественные вопросительные конструкции.
  return Boolean((intents && intents.search) || /\b(найди|поищи|проверь|посмотри в интернете|актуальн|свежие новости|погода|температур|дождь|ветер|сейчас|сегодня|на этой неделе|в севастополе|в крыму|цена|стоимость|отзывы|форум|правил|норма|закон|ловится|работает|продают|купить|какой|какая|какие|сколько|кто|где|когда|можно ли|стоит ли)\b/i.test(text));
}

function fallbackFromSearch(searchContext) {
  const clean = cleanText(searchContext)
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!clean) return "Я не смог получить свежие данные. Попробуй повторить вопрос через несколько секунд.";
  return `Вот что удалось найти: ${clean.slice(0, 850)}. Если хочешь, я уточню этот вопрос по конкретному источнику.`;
}

function isHelpRequest(text) {
  return /^(помощь|помоги|что ты умеешь|что можешь|твои возможности|справка)$/i.test(cleanText(text));
}

function quickAnswer(text) {
  const q = cleanText(text).toLowerCase().replace(/[?!.,]+$/g, "").trim();
  const compact = q.replace(/\s+/g, "");
  if (/^(кто ты|ты кто|как тебя зовут)$/.test(q)) return "Я Джарвис, твой персональный помощник. Я умею отвечать на вопросы, искать свежую информацию и помогать тебе с рабочими и бытовыми задачами.";
  if (/^(где я|где я нахожусь|мой город|в каком я городе)$/.test(q)) return "Ты находишься в Севастополе.";
  if (/^(кто я|как меня зовут|что ты обо мне знаешь)$/.test(q)) return "Ты Ян. Ты живёшь в Севастополе и работаешь инженером строительного контроля в электромонтажной компании.";
  if (/^(ты тут|ты здесь|алло|алё|джарвис|джарвис ты тут|слышишь меня|на связи)$/.test(q)) return "Да, Ян, я здесь и слушаю тебя.";
  if (/^ктoя$/.test(compact) || compact === "ктoя" || compact === "ктоя") return "Ты Ян. Ты живёшь в Севастополе и работаешь инженером строительного контроля в электромонтажной компании.";
  if (/^(привет|здравствуй|доброе утро|добрый день|добрый вечер)$/.test(q)) return "Привет, Ян. Слушаю тебя.";
  if (/^(спасибо|благодарю)$/.test(q)) return "Пожалуйста, Ян.";
  return "";
}

function isWeatherRequest(text) {
  // Алиса иногда распознаёт «погода» как «погод» или разбивает фразу на «погод а...».
  return /погод|температур|дожд|осадк|ветер|прогноз/i.test(text);
}

async function fetchWeather(text, timeoutMs) {
  if (!isWeatherRequest(text)) return "";
  const found = text.match(/москв\w*|санкт-петербург|питер|астрахан\w*|ялт\w*|симферопол\w*|севастопол\w*/i);
  // Для первого стабильного варианта используем координаты Севастополя.
  // Если Алиса склеила город с предыдущим словом, всё равно оставляем город по умолчанию.
  const city = found?.[0] || "Севастополь";
  const coordinates = {
    "Севастополь": [44.6167, 33.5254],
    "севастополь": [44.6167, 33.5254]
  };
  const [latitude, longitude] = coordinates[city] || coordinates["Севастополь"];
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=Europe%2FMoscow`;
    const { response, data } = await fetchJson(url, {}, Math.min(2500, timeoutMs));
    if (!response.ok || !data?.current) return "";
    const now = data.current;
    const descriptions = {
      0: "ясно", 1: "преимущественно ясно", 2: "переменная облачность", 3: "пасмурно",
      45: "туман", 48: "туман", 51: "небольшой моросящий дождь", 53: "моросящий дождь",
      55: "сильный моросящий дождь", 61: "небольшой дождь", 63: "дождь", 65: "сильный дождь",
      71: "небольшой снег", 73: "снег", 75: "сильный снег", 80: "ливневый дождь",
      81: "ливневый дождь", 82: "сильный ливневый дождь", 95: "гроза"
    };
    const description = descriptions[now.weather_code] || "данные о состоянии погоды получены";
    return `Сейчас в городе ${city}: ${description}. Температура ${now.temperature_2m} градусов, ощущается как ${now.apparent_temperature}, ветер ${now.wind_speed_10m} километров в час.`;
  } catch (error) {
    console.warn("Weather request failed:", error?.message || error);
    return "";
  }
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally { clearTimeout(timer); }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";
  try {
    const { response, data } = await fetchJson("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
    }, Math.min(SERPER_TIMEOUT_MS, timeoutMs));
    if (!response.ok) return "";
    const items = (Array.isArray(data.organic) ? data.organic : []).slice(0, 3).map((item, i) =>
      `${i + 1}. ${String(item.title || "").slice(0, 150)}: ${String(item.snippet || "").slice(0, 300)} ${String(item.link || "").slice(0, 220)}`.trim()
    );
    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 300)}`);
    return items.join("\n");
  } catch { return ""; }
}

function buildModelChain() {
  const envModel = String(process.env.GEMINI_MODEL || "").trim();
  const chain = [];
  if (envModel && /^[A-Za-z0-9._-]+$/.test(envModel)) chain.push(envModel);
  for (const model of [DEFAULT_MODEL, ...FALLBACK_MODELS]) {
    if (/^[A-Za-z0-9._-]+$/.test(model) && !chain.includes(model)) chain.push(model);
  }
  return chain;
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 300) throw new Error("TIME_BUDGET_EXHAUSTED");

  const prior = normalizeHistory(history);
  const contents = prior.map(item => ({ role: item.role, parts: [{ text: item.text }] }));
  const prompt = searchContext
    ? `${text}\n\nКонтекст поиска:\n${searchContext}\nИспользуй его только по теме вопроса.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  let lastStatus = null;
  for (const model of buildModelChain()) {
    try {
      const { response, data } = await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            generationConfig: { temperature: 0.45, maxOutputTokens: 320 }
          })
        }, Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
      );
      const status = Number(response.status);
      if (response.ok) {
        const answer = (data?.candidates?.[0]?.content?.parts || [])
          .map(part => typeof part.text === "string" ? part.text : "").join("").trim();
        if (answer) return answer;
        if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
      } else {
        lastStatus = status;
        if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
        if (status === 400) throw new Error("GEMINI_BAD_REQUEST");
      }
    } catch (error) {
      if (error.name === "AbortError") { lastStatus = "timeout"; continue; }
      throw error;
    }
  }
  if (lastStatus === 429) throw new Error("GEMINI_QUOTA");
  if (lastStatus === "timeout") throw new Error("TIME_BUDGET_EXHAUSTED");
  throw new Error("GEMINI_REQUEST_FAILED");
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY": return "Сервер пока не настроен. Проверьте GEMINI_API_KEY в Vercel.";
    case "GEMINI_KEY_REJECTED": return "Не удалось подключиться к Gemini. Проверьте API-ключ в Vercel.";
    case "GEMINI_QUOTA": return "Превышен лимит Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED": return "Я не смог обработать этот запрос. Скажи иначе.";
    case "TIME_BUDGET_EXHAUSTED": return "Я не успела ответить. Скажи короче или повтори вопрос.";
    case "GEMINI_REQUEST_FAILED": return "Сейчас не отвечает модуль знаний. Проверьте GEMINI_API_KEY и последний деплой Vercel.";
    default: return "Сейчас не отвечает внешний сервис. Проверьте настройки ключей в Vercel.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "alice-jarvis" });
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = cleanText(body?.request?.command || body?.request?.original_utterance || "");
  const oldHistory = readSessionHistory(body);

  if (!text) return res.status(200).json(aliceResponse("Да, Ян, слушаю тебя.", false, oldHistory));
  if (isHelpRequest(text)) return res.status(200).json(aliceResponse(HELP_TEXT, false, oldHistory));

  const quick = quickAnswer(text);
  if (quick) {
    const history = [...oldHistory, { role: "user", text }, { role: "model", text: quick }];
    return res.status(200).json(aliceResponse(quick, false, history));
  }

  try {
    const weather = await fetchWeather(text, Math.max(0, remainingMs() - 1800));
    if (weather) {
      const history = [...oldHistory, { role: "user", text }, { role: "model", text: weather }];
      return res.status(200).json(aliceResponse(weather, false, history));
    }
    let searchContext = "";
    const needsSearch = hasSearchIntent(body, text);
    if (needsSearch && !process.env.SERPER_API_KEY) {
      const message = "Для актуального ответа нужен ключ SERPER_API_KEY. Добавьте его в Vercel в Settings, Environment Variables и повторите деплой.";
      return res.status(200).json(aliceResponse(message, false, oldHistory));
    }
    if (needsSearch && process.env.SERPER_API_KEY) {
      searchContext = await searchWeb(text, Math.max(0, remainingMs() - 3100));
    }
    if (needsSearch && !searchContext) {
      const message = "Поиск актуальной информации сейчас не вернул данные. Проверьте SERPER_API_KEY в Vercel и повторите последний деплой.";
      return res.status(200).json(aliceResponse(message, false, oldHistory));
    }
    let answer;
    try {
      answer = await askGemini(text, oldHistory, searchContext, Math.max(0, remainingMs() - 300));
    } catch (modelError) {
      // Навык не должен падать, если Gemini временно недоступен.
      // При наличии результатов поиска отдаём их пользователю напрямую.
      console.warn("Gemini failed, using resilient fallback:", modelError?.message || modelError);
      if (searchContext) answer = fallbackFromSearch(searchContext);
      else throw modelError;
    }
    const history = [
      ...oldHistory,
      { role: "user", text },
      { role: "model", text: answer }
    ];
    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    console.warn("Alice webhook error:", error?.message || error);
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, safeHistory, normalizeHistory, trimHistoryToBudget, readSessionHistory, quickAnswer, isWeatherRequest };

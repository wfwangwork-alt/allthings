// Vercel Serverless Function（Node.js 运行时，零 npm 依赖，只用原生 fetch）
// 前端：POST /api/chat  { prompt: "用户说的话" }
// 后端：用它自己的 System Prompt 调用 DeepSeek，把整理好的 JSON 直接返回给前端。
//
// 需要在 Vercel 项目里配置环境变量：DEEPSEEK_API_KEY
// 本地调试可用：vercel dev（会自动读取 .env / .env.local）

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

const SYSTEM_PROMPT = "你是一个贴心的数字秘书。请从用户的话中提取信息，返回严格的 JSON 格式，包含四个字段：title（事情标题）、time（时间，没有就填无）、tip（一句温暖的灵魂提醒，比如打疫苗提醒带本子，约人吃饭提醒带酒）、duration_minutes（从“现在”到这件事发生还有多少分钟，必须是数字：比如“1分钟后”就是 1、“半小时后”就是 30、“2小时后”就是 120；如果无法确定时间，则填 null）。注意：你只负责给出相对分钟数，不要自己换算成时间戳，也不要把秒数抹零——“1分钟”就老老实实填 1。";

function pad(n) {
  return String(n).padStart(2, "0");
}

// 把当前时间格式化后交给 AI，方便它把「明天下午3点」这类绝对时间换算成相对分钟数
function formatTime(d) {
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds())
  );
}

// 模型偶尔会用 ```json ... ``` 包裹结果，这里做一次容错
function parseAiJson(content) {
  const trimmed = String(content == null ? "" : content).trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : trimmed;
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object") {
    throw new Error("JSON 结构不正确");
  }
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "只支持 POST 请求。" });
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "服务端未配置 DEEPSEEK_API_KEY 环境变量。" });
    return;
  }

  // Vercel 一般已自动解析 JSON body；这里再兜底一次，防止拿到的是字符串
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (err) {
      body = {};
    }
  }
  if (!body || typeof body !== "object") {
    body = {};
  }

  const prompt = String(body.prompt == null ? "" : body.prompt).trim();
  if (!prompt) {
    res.status(400).json({ error: "缺少 prompt 参数。" });
    return;
  }

  let response;
  try {
    response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              "当前时间是 " + formatTime(new Date()) +
              "。请据此算出从“现在”到这件事还有多少分钟，填进 duration_minutes。用户说：" + prompt
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.7
      })
    });
  } catch (err) {
    res.status(502).json({ error: "网络错误，无法连接 DeepSeek：" + (err && err.message ? err.message : "未知原因") });
    return;
  }

  const raw = await response.text();
  if (!response.ok) {
    res.status(502).json({ error: "DeepSeek 请求失败（" + response.status + "）：" + raw.slice(0, 300) });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    res.status(502).json({ error: "DeepSeek 返回的不是合法 JSON。" });
    return;
  }

  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : "";
  if (!content) {
    res.status(502).json({ error: "DeepSeek 没有返回可用内容。" });
    return;
  }

  let data;
  try {
    data = parseAiJson(content);
  } catch (err) {
    res.status(502).json({ error: "模型没有返回可用的 JSON。" });
    return;
  }

  res.status(200).json(data);
};

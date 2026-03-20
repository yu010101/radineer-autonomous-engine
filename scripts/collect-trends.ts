/**
 * collect-trends.ts
 * xAI API (Grok) でX上のトレンドを収集し、topics.jsonのフィルタを適用して保存
 */
import { readJSON, writeJSON, dataPath, configPath, log, logError, env, nowISO, type TrendEntry } from "./utils.js";

interface TopicCategory {
  name: string;
  keywords: string[];
  priority: string;
}

interface TopicsConfig {
  categories: TopicCategory[];
  exclude_keywords: string[];
}

async function collectTrends(): Promise<void> {
  const apiKey = env("XAI_API_KEY");
  const topics: TopicsConfig = readJSON(configPath("topics.json"));

  const allKeywords = topics.categories.flatMap((c) => c.keywords);
  const query = allKeywords.slice(0, 10).join(" OR ");

  log(`Collecting trends for: ${query.slice(0, 100)}...`);

  // xAI Agent Tools API (/v1/responses endpoint)
  const response = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "grok-4-fast",
      stream: false,
      input: [
        {
          role: "system",
          content: `あなたはトレンドリサーチャーです。X(Twitter)上の最新トレンドを分析し、以下のカテゴリに関連するトピックを抽出してください。
x_searchツールを使ってXの最新投稿を検索し、トレンドを把握してください。

カテゴリ: ${topics.categories.map((c) => c.name).join(", ")}

除外キーワード: ${topics.exclude_keywords.join(", ")}

最終的な回答はJSON配列で返してください:
[{"topic": "トピック名", "category": "カテゴリ名", "summary": "200文字以内の要約", "relevance_score": 0.0-1.0}]`,
        },
        {
          role: "user",
          content: `現在のX上で話題になっている${topics.categories.map((c) => c.name).join("・")}に関するトレンドを10件抽出してください。日本語のトレンドを優先してください。`,
        },
      ],
      tools: [{ type: "x_search" }],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`xAI API error: ${response.status} - ${text}`);
  }

  const result = (await response.json()) as any;
  log(`Response keys: ${Object.keys(result).join(", ")}`);

  // /v1/responses API: output is array of items, find message with text content
  let content = "[]";
  if (result.output_text) {
    content = result.output_text;
  } else if (result.output && Array.isArray(result.output)) {
    const msgItem = result.output.find((item: any) => item.type === "message");
    if (msgItem?.content) {
      const textContent = Array.isArray(msgItem.content)
        ? msgItem.content.find((c: any) => c.type === "output_text" || c.type === "text")
        : msgItem.content;
      content = typeof textContent === "string" ? textContent : textContent?.text || "[]";
    }
    if (content === "[]") {
      log(`Could not extract text from output. First item type: ${result.output[0]?.type}`);
      log(`Output structure: ${JSON.stringify(result.output.map((o: any) => ({ type: o.type, keys: Object.keys(o) })))}`);
    }
  } else if (result.choices?.[0]?.message?.content) {
    content = result.choices[0].message.content;
  }
  log(`Extracted content length: ${content.length}`);

  let trends: TrendEntry[];
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : "[]");
    trends = parsed.map((t: any, i: number) => ({
      id: `trend-${Date.now()}-${i}`,
      topic: t.topic,
      category: t.category || "uncategorized",
      summary: t.summary,
      relevance_score: t.relevance_score || 0.5,
      source: "x" as const,
      collected_at: nowISO(),
    }));
  } catch {
    logError("Failed to parse trends response", content);
    trends = [];
  }

  // 除外キーワードでフィルタ
  trends = trends.filter(
    (t) => !topics.exclude_keywords.some((kw) => t.topic.includes(kw) || t.summary.includes(kw))
  );

  // 保存
  const now = new Date();
  const filename = `${now.toISOString().slice(0, 13).replace("T", "-")}.json`;
  const outPath = dataPath("trends", filename);
  writeJSON(outPath, { collected_at: nowISO(), trends });

  log(`Saved ${trends.length} trends to ${filename}`);
}

collectTrends().catch((err) => {
  logError("collect-trends failed", err);
  process.exit(1);
});

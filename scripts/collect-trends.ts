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

  // xAI Agent Tools API (x_search + web_search)
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "grok-3-fast",
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
  // Agent Tools API: output_text or choices[].message.content
  const content = result.output_text
    || result.choices?.[0]?.message?.content
    || "[]";

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

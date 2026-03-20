/**
 * analyze-and-plan.ts
 * 直近のトレンド + スキルDB + 記憶を読み込み、今日のコンテンツ計画を決定
 */
import Anthropic from "@anthropic-ai/sdk";
import { readdirSync } from "fs";
import {
  readJSON, writeJSON, dataPath, configPath,
  log, logError, env, nowISO, todayStr,
  type TrendEntry, type ContentPlan,
} from "./utils.js";

function loadRecentTrends(hours: number = 24): TrendEntry[] {
  const trendsDir = dataPath("trends");
  const files = readdirSync(trendsDir).filter((f) => f.endsWith(".json")).sort().reverse();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const allTrends: TrendEntry[] = [];
  for (const file of files.slice(0, 48)) {
    try {
      const data = readJSON<{ collected_at: string; trends: TrendEntry[] }>(
        dataPath("trends", file)
      );
      if (new Date(data.collected_at) >= cutoff) {
        allTrends.push(...data.trends);
      }
    } catch {
      // skip corrupt files
    }
  }
  return allTrends;
}

async function analyzeAndPlan(): Promise<void> {
  log("Starting daily analysis and planning...");

  const trends = loadRecentTrends(24);
  const contentPatterns = readJSON(dataPath("skills", "content-patterns.json"));
  const topicScores = readJSON(dataPath("skills", "topic-scores.json"));
  const insights = readJSON(dataPath("memory", "insights.json"));
  const editorialVoice = readJSON(configPath("editorial-voice.json"));
  const analyzerPrompt = (await import("fs")).readFileSync(
    dataPath("prompts", "analyzer.md"),
    "utf-8"
  );

  if (trends.length === 0) {
    log("No recent trends found. Using fallback topic generation.");
  }

  const anthropic = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

  const trendsSummary = trends
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, 20)
    .map((t) => `- [${t.category}] ${t.topic} (スコア: ${t.relevance_score}) - ${t.summary}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `${analyzerPrompt}

## 本日の入力データ

### 直近のトレンド（${trends.length}件）
${trendsSummary || "トレンドデータなし - コンテンツピラーに基づいて提案してください"}

### 過去の成功パターン
${JSON.stringify(contentPatterns.patterns.slice(-5), null, 2)}

### トピック別スコア
${JSON.stringify(topicScores.scores, null, 2)}

### 蓄積された洞察
${JSON.stringify(insights.insights.slice(-5), null, 2)}

### ブランドボイス
${JSON.stringify(editorialVoice, null, 2)}

今日（${todayStr()}）のコンテンツ計画を立ててください。`,
      },
    ],
  });

  const planContent = response.content[0].type === "text" ? response.content[0].text : "{}";

  let plan: any;
  try {
    const jsonMatch = planContent.match(/\{[\s\S]*\}/);
    plan = JSON.parse(jsonMatch ? jsonMatch[0] : "{}");
  } catch {
    logError("Failed to parse plan response", planContent);
    plan = { recommended_topics: [], x_post_ideas: [], strategic_notes: "パース失敗" };
  }

  // 計画を保存
  const planPath = dataPath("trends", `plan-${todayStr()}.json`);
  writeJSON(planPath, {
    date: todayStr(),
    created_at: nowISO(),
    trends_analyzed: trends.length,
    plan,
  });

  // 判断履歴を記録
  const decisions = readJSON<any>(dataPath("memory", "decisions.json"));
  decisions.decisions.push({
    date: todayStr(),
    type: "daily_plan",
    topics: plan.recommended_topics?.map((t: ContentPlan) => t.theme) || [],
    reasoning: plan.strategic_notes || "",
    created_at: nowISO(),
  });
  decisions.last_updated = nowISO();
  writeJSON(dataPath("memory", "decisions.json"), decisions);

  log(`Plan created: ${plan.recommended_topics?.length || 0} topics recommended`);
}

analyzeAndPlan().catch((err) => {
  logError("analyze-and-plan failed", err);
  process.exit(1);
});

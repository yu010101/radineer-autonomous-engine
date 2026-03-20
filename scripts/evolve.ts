/**
 * evolve.ts
 * 週次自己改善ループ（Voyager + OPROパターン）
 * - 週間パフォーマンス分析
 * - 成功パターン抽出 → スキルDB更新
 * - プロンプト自動改善
 * - 翌週の戦略レポート生成
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
import {
  readJSON, writeJSON, dataPath, configPath,
  log, logError, env, nowISO, todayStr,
} from "./utils.js";

async function evolve(): Promise<void> {
  log("Starting weekly evolution...");

  const anthropic = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

  // 1. 週間パフォーマンスデータ収集
  const insights = readJSON<any>(dataPath("memory", "insights.json"));
  const weekData = insights.insights.slice(-7);

  if (weekData.length < 3) {
    log(`Only ${weekData.length} days of data. Need at least 3 for evolution. Skipping.`);
    return;
  }

  // 2. 成功パターン抽出
  log("Extracting success patterns...");

  const performanceSummary = weekData.map((d: any) => ({
    date: d.date,
    note: d.performance?.note_articles || [],
    x: d.performance?.x_posts || [],
  }));

  const patternResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `以下は過去1週間のコンテンツパフォーマンスデータです。成功パターンと改善点を分析してください。

${JSON.stringify(performanceSummary, null, 2)}

以下のJSON形式で回答してください:
{
  "content_patterns": [
    {"pattern": "パターン説明", "evidence": "根拠", "score": 0.9}
  ],
  "x_post_patterns": [
    {"pattern": "パターン説明", "evidence": "根拠", "score": 0.9}
  ],
  "topic_scores": {
    "トピック名": {"score": 0.8, "trend": "up|down|stable"}
  },
  "key_insights": ["洞察1", "洞察2"],
  "recommendations": ["推奨事項1", "推奨事項2"]
}`,
      },
    ],
  });

  const patternText =
    patternResponse.content[0].type === "text" ? patternResponse.content[0].text : "{}";
  let patterns: any;
  try {
    const jsonMatch = patternText.match(/\{[\s\S]*\}/);
    patterns = JSON.parse(jsonMatch ? jsonMatch[0] : "{}");
  } catch {
    logError("Failed to parse pattern analysis");
    patterns = {};
  }

  // 3. スキルDB更新
  log("Updating skill databases...");

  const contentPatterns = readJSON<any>(dataPath("skills", "content-patterns.json"));
  if (patterns.content_patterns) {
    contentPatterns.patterns.push(
      ...patterns.content_patterns.map((p: any) => ({
        ...p,
        extracted_at: nowISO(),
        week_of: todayStr(),
      }))
    );
    // 最新50パターンのみ保持
    contentPatterns.patterns = contentPatterns.patterns.slice(-50);
    contentPatterns.last_updated = nowISO();
    contentPatterns.version++;
    writeJSON(dataPath("skills", "content-patterns.json"), contentPatterns);
  }

  const xPostPatterns = readJSON<any>(dataPath("skills", "x-post-patterns.json"));
  if (patterns.x_post_patterns) {
    xPostPatterns.patterns.push(
      ...patterns.x_post_patterns.map((p: any) => ({
        ...p,
        extracted_at: nowISO(),
        week_of: todayStr(),
      }))
    );
    xPostPatterns.patterns = xPostPatterns.patterns.slice(-50);
    xPostPatterns.last_updated = nowISO();
    xPostPatterns.version++;
    writeJSON(dataPath("skills", "x-post-patterns.json"), xPostPatterns);
  }

  const topicScores = readJSON<any>(dataPath("skills", "topic-scores.json"));
  if (patterns.topic_scores) {
    topicScores.scores = { ...topicScores.scores, ...patterns.topic_scores };
    topicScores.last_updated = nowISO();
    topicScores.version++;
    writeJSON(dataPath("skills", "topic-scores.json"), topicScores);
  }

  // 4. プロンプト自動改善（OPROパターン）
  log("Evolving prompts (OPRO pattern)...");

  const thresholds = readJSON(configPath("thresholds.json"));
  const promptFiles = ["article-generator.md", "x-post-generator.md", "analyzer.md"];

  for (const promptFile of promptFiles) {
    const currentPrompt = readFileSync(dataPath("prompts", promptFile), "utf-8");

    const evolveResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `あなたはプロンプトエンジニアです。以下の現在のプロンプトを、今週のパフォーマンスデータに基づいて改善してください。

## 現在のプロンプト
${currentPrompt}

## 今週のパフォーマンス結果
${JSON.stringify(patterns.key_insights || [], null, 2)}

## 成功パターン
${JSON.stringify(patterns.content_patterns || [], null, 2)}

## 改善ルール
- 変更量は全体の30%以内に抑える
- 既存の良い部分は保持する
- データに基づかない変更はしない
- バージョン番号をインクリメントする

改善されたプロンプト全文をそのまま返してください（JSON不要、Markdown形式のまま）。`,
        },
      ],
    });

    const newPrompt =
      evolveResponse.content[0].type === "text" ? evolveResponse.content[0].text : currentPrompt;

    // 変更量チェック
    const changeRatio =
      Math.abs(newPrompt.length - currentPrompt.length) / currentPrompt.length;
    if (changeRatio <= thresholds.auto_evolve.max_prompt_change_ratio) {
      writeFileSync(dataPath("prompts", promptFile), newPrompt, "utf-8");
      log(`Evolved prompt: ${promptFile} (change ratio: ${(changeRatio * 100).toFixed(1)}%)`);
    } else {
      log(
        `Skipped prompt evolution for ${promptFile}: change ratio ${(changeRatio * 100).toFixed(1)}% exceeds threshold ${thresholds.auto_evolve.max_prompt_change_ratio * 100}%`
      );
    }
  }

  // 5. 翌週の戦略レポート生成
  log("Generating weekly strategy report...");

  const strategyResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `以下のデータに基づいて、翌週のコンテンツ戦略レポートを作成してください。

## 今週のパフォーマンス
${JSON.stringify(performanceSummary, null, 2)}

## 抽出された成功パターン
${JSON.stringify(patterns, null, 2)}

## 現在のトピックスコア
${JSON.stringify(topicScores.scores, null, 2)}

以下のフォーマットでレポートを作成してください:
{
  "week_summary": "今週の総括（3文以内）",
  "top_performers": ["最も成功したコンテンツとその理由"],
  "improvement_areas": ["改善が必要な領域"],
  "next_week_strategy": {
    "focus_topics": ["注力すべきトピック"],
    "content_mix": {"articles": 5, "x_posts": 15},
    "experiments": ["試してみるべきこと"]
  },
  "kpis": {
    "target_pv": 1000,
    "target_note_likes": 50,
    "target_x_engagement_rate": 0.03
  }
}`,
      },
    ],
  });

  const strategyText =
    strategyResponse.content[0].type === "text" ? strategyResponse.content[0].text : "{}";
  let strategy: any;
  try {
    const jsonMatch = strategyText.match(/\{[\s\S]*\}/);
    strategy = JSON.parse(jsonMatch ? jsonMatch[0] : "{}");
  } catch {
    strategy = { week_summary: strategyText };
  }

  // レポート保存
  writeJSON(dataPath("trends", `weekly-report-${todayStr()}.json`), {
    week_ending: todayStr(),
    created_at: nowISO(),
    patterns_extracted: patterns,
    strategy,
    prompts_evolved: promptFiles,
  });

  log("Weekly evolution complete");
}

evolve().catch((err) => {
  logError("evolve failed", err);
  process.exit(1);
});

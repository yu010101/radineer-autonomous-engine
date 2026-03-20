/**
 * generate-content.ts
 * Claude APIで記事本文を生成し、ドラフトとして保存
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import {
  readJSON, writeJSON, dataPath, configPath,
  log, logError, env, nowISO, todayStr,
  type GeneratedArticle,
} from "./utils.js";

async function generateContent(): Promise<void> {
  log("Starting content generation...");

  // 今日の計画を読み込み
  const planPath = dataPath("trends", `plan-${todayStr()}.json`);
  let plan: any;
  try {
    plan = readJSON(planPath);
  } catch {
    logError(`No plan found for ${todayStr()}. Run analyze-and-plan first.`);
    process.exit(1);
  }

  const topics = plan.plan?.recommended_topics || [];
  if (topics.length === 0) {
    log("No topics recommended. Skipping content generation.");
    return;
  }

  const editorialVoice = readJSON(configPath("editorial-voice.json"));
  const contentPatterns = readJSON(dataPath("skills", "content-patterns.json"));
  const articlePrompt = readFileSync(dataPath("prompts", "article-generator.md"), "utf-8");
  const thresholds = readJSON(configPath("thresholds.json"));

  const anthropic = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

  // 最優先トピックで記事生成（1日max件数まで）
  const maxArticles = thresholds.auto_publish_note.max_per_day;
  const topTopics = topics
    .filter((t: any) => t.priority === "high" || t.priority === "medium")
    .slice(0, maxArticles);

  const articles: Array<GeneratedArticle & { topic: any }> = [];

  for (const topic of topTopics) {
    log(`Generating article for: ${topic.theme}`);

    const prompt = articlePrompt
      .replace("{{theme}}", topic.theme)
      .replace("{{target}}", topic.target || editorialVoice.target_audience[0])
      .replace("{{key_points}}", topic.angle || "")
      .replace("{{trends}}", topic.reasoning || "")
      .replace(
        "{{success_patterns}}",
        JSON.stringify(contentPatterns.patterns.slice(-3), null, 2)
      );

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `${prompt}

ブランドボイス: ${JSON.stringify(editorialVoice, null, 2)}

上記のフォーマットに従い、JSON形式で記事を生成してください。`,
        },
      ],
    });

    const articleContent =
      response.content[0].type === "text" ? response.content[0].text : "{}";

    try {
      const jsonMatch = articleContent.match(/\{[\s\S]*\}/);
      const article: GeneratedArticle = JSON.parse(jsonMatch ? jsonMatch[0] : "{}");
      articles.push({ ...article, topic });
      log(
        `Generated: "${article.title}" (confidence: ${article.confidence_score}, words: ${article.meta?.word_count || "?"})`
      );
    } catch {
      logError(`Failed to parse article for topic: ${topic.theme}`);
    }
  }

  // ドラフトとして保存
  const draftsPath = dataPath("trends", `drafts-${todayStr()}.json`);
  writeJSON(draftsPath, {
    date: todayStr(),
    created_at: nowISO(),
    articles,
  });

  log(`Generated ${articles.length} article drafts`);
}

generateContent().catch((err) => {
  logError("generate-content failed", err);
  process.exit(1);
});

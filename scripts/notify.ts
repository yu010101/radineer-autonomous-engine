/**
 * notify.ts
 * Slack Webhook / LINE Notifyで通知
 */
import {
  readJSON, dataPath,
  log, logError, envOr, nowISO, todayStr,
} from "./utils.js";

interface NotifyOptions {
  type: "daily" | "review" | "weekly" | "alert";
  message?: string;
}

function parseArgs(): NotifyOptions {
  const args = process.argv.slice(2);
  let type: NotifyOptions["type"] = "daily";
  let message: string | undefined;

  for (const arg of args) {
    if (arg.startsWith("--type=")) {
      type = arg.split("=")[1] as NotifyOptions["type"];
    }
    if (arg.startsWith("--message=")) {
      message = arg.split("=").slice(1).join("=");
    }
  }

  return { type, message };
}

function buildDailyReport(): string {
  let report = `📊 *Radineer日報* (${todayStr()})\n\n`;

  // 公開記事
  try {
    const published = readJSON<any>(dataPath("trends", `published-${todayStr()}.json`));
    const publishedCount = published.results?.filter((r: any) => r.status === "published").length || 0;
    const draftCount = published.results?.filter((r: any) => r.status === "draft").length || 0;
    report += `📝 *note.com*\n`;
    report += `  公開: ${publishedCount}件 / 下書き: ${draftCount}件\n`;
    for (const r of published.results || []) {
      report += `  - ${r.title} (${r.status}, confidence: ${r.confidence})\n`;
    }
  } catch {
    report += `📝 *note.com*: データなし\n`;
  }

  // X投稿
  try {
    const xPosts = readJSON<any>(dataPath("trends", `x-posts-${todayStr()}.json`));
    const postedCount = xPosts.results?.filter((r: any) => r.status === "posted").length || 0;
    report += `\n🐦 *X投稿*: ${postedCount}件\n`;
  } catch {
    report += `\n🐦 *X投稿*: データなし\n`;
  }

  // トレンド収集
  try {
    const plan = readJSON<any>(dataPath("trends", `plan-${todayStr()}.json`));
    report += `\n📈 *分析*: ${plan.trends_analyzed || 0}件のトレンドを分析\n`;
    report += `  推奨トピック: ${plan.plan?.recommended_topics?.length || 0}件\n`;
  } catch {
    report += `\n📈 *分析*: データなし\n`;
  }

  return report;
}

function buildReviewReport(): string {
  let report = `🔍 *パフォーマンスレビュー* (${todayStr()})\n\n`;

  try {
    const review = readJSON<any>(dataPath("trends", `review-${todayStr()}.json`));
    const record = review.record;

    if (record?.note_articles?.length > 0) {
      const totalPV = record.note_articles.reduce((sum: number, a: any) => sum + a.pv, 0);
      const totalLikes = record.note_articles.reduce((sum: number, a: any) => sum + a.likes, 0);
      report += `📝 *note.com*: PV ${totalPV} / スキ ${totalLikes}\n`;
      for (const a of record.note_articles.slice(0, 5)) {
        report += `  - ${a.title}: PV ${a.pv}, スキ ${a.likes}\n`;
      }
    }

    if (record?.x_posts?.length > 0) {
      const totalImpressions = record.x_posts.reduce(
        (sum: number, p: any) => sum + p.impressions,
        0
      );
      const totalLikes = record.x_posts.reduce((sum: number, p: any) => sum + p.likes, 0);
      report += `\n🐦 *X*: インプレッション ${totalImpressions} / いいね ${totalLikes}\n`;
    }
  } catch {
    report += "データの取得に失敗しました\n";
  }

  return report;
}

function buildWeeklyReport(): string {
  let report = `📅 *週次レポート* (${todayStr()})\n\n`;

  try {
    const weekly = readJSON<any>(dataPath("trends", `weekly-report-${todayStr()}.json`));
    const strategy = weekly.strategy;

    report += `*今週の総括*: ${strategy?.week_summary || "N/A"}\n\n`;

    if (strategy?.top_performers?.length > 0) {
      report += `*トップパフォーマー*:\n`;
      for (const tp of strategy.top_performers) {
        report += `  - ${tp}\n`;
      }
    }

    if (strategy?.next_week_strategy) {
      report += `\n*来週の戦略*:\n`;
      report += `  注力: ${strategy.next_week_strategy.focus_topics?.join(", ") || "N/A"}\n`;
      report += `  実験: ${strategy.next_week_strategy.experiments?.join(", ") || "N/A"}\n`;
    }

    if (weekly.patterns_extracted?.key_insights?.length > 0) {
      report += `\n*主要インサイト*:\n`;
      for (const insight of weekly.patterns_extracted.key_insights) {
        report += `  - ${insight}\n`;
      }
    }
  } catch {
    report += "週次レポートの生成に失敗しました\n";
  }

  return report;
}

async function sendSlack(webhookUrl: string, text: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook error: ${response.status}`);
  }
}

async function notify(): Promise<void> {
  const options = parseArgs();
  log(`Sending ${options.type} notification...`);

  let message: string;
  switch (options.type) {
    case "review":
      message = buildReviewReport();
      break;
    case "weekly":
      message = buildWeeklyReport();
      break;
    case "alert":
      message = options.message || "⚠️ アラート通知";
      break;
    default:
      message = buildDailyReport();
  }

  const slackUrl = envOr("SLACK_WEBHOOK_URL", "");

  if (slackUrl) {
    try {
      await sendSlack(slackUrl, message);
      log("Slack notification sent");
    } catch (err) {
      logError("Failed to send Slack notification", err);
    }
  } else {
    log("No SLACK_WEBHOOK_URL configured. Printing report to stdout:");
    console.log(message);
  }
}

notify().catch((err) => {
  logError("notify failed", err);
  process.exit(1);
});

/**
 * publish-x.ts
 * X API (Twitter API v2) で投稿
 */
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import {
  readJSON, writeJSON, dataPath, configPath,
  log, logError, env, nowISO, todayStr,
} from "./utils.js";

// OAuth 1.0a署名生成
function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");

  const baseString = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(sortedParams)}`;
  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;

  return crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
}

function generateOAuthHeader(method: string, url: string, body?: string): string {
  const apiKey = env("TWITTER_API_KEY");
  const apiSecret = env("TWITTER_API_SECRET");
  const accessToken = env("TWITTER_ACCESS_TOKEN");
  const accessSecret = env("TWITTER_ACCESS_SECRET");

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: accessToken,
    oauth_version: "1.0",
  };

  const signature = generateOAuthSignature(method, url, oauthParams, apiSecret, accessSecret);
  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}

async function postTweet(text: string): Promise<any> {
  const url = "https://api.twitter.com/2/tweets";
  const body = JSON.stringify({ text });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: generateOAuthHeader("POST", url, body),
      "Content-Type": "application/json",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`X API error: ${response.status} - ${errorText}`);
  }

  return (await response.json()) as any;
}

async function publishToX(): Promise<void> {
  log("Starting X posting...");

  const xStrategy = readJSON(configPath("x-strategy.json"));
  const thresholds = readJSON(configPath("thresholds.json"));
  const xPostPatterns = readJSON(dataPath("skills", "x-post-patterns.json"));

  // 今日の計画からX投稿アイデアを取得
  let plan: any;
  try {
    plan = readJSON(dataPath("trends", `plan-${todayStr()}.json`));
  } catch {
    log("No plan found, generating standalone X posts");
    plan = { plan: { x_post_ideas: [] } };
  }

  // 公開された記事のURLを取得
  let published: any;
  try {
    published = readJSON(dataPath("trends", `published-${todayStr()}.json`));
  } catch {
    published = { results: [] };
  }

  const anthropic = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
  const xPostPrompt = (await import("fs")).readFileSync(
    dataPath("prompts", "x-post-generator.md"),
    "utf-8"
  );

  const posts: any[] = [];
  const maxPosts = thresholds.auto_post_x.max_per_day;

  // 記事プロモ投稿を生成
  const publishedArticles = published.results?.filter((r: any) => r.status === "published") || [];
  for (const article of publishedArticles.slice(0, 2)) {
    const noteUrl = article.note_id ? `https://note.com/radineer/n/${article.note_id}` : "";

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `${xPostPrompt}

投稿タイプ: article_promo
テーマ: ${article.title}
記事URL: ${noteUrl}
過去の成功パターン: ${JSON.stringify(xPostPatterns.patterns.slice(-3))}

テンプレート: ${JSON.stringify(xStrategy.post_types.article_promo)}

JSON形式で投稿テキストを生成してください。`,
        },
      ],
    });

    try {
      const text = response.content[0].type === "text" ? response.content[0].text : "{}";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const post = JSON.parse(jsonMatch ? jsonMatch[0] : "{}");
      if (post.text) posts.push({ ...post, article_title: article.title });
    } catch {
      logError(`Failed to generate promo post for: ${article.title}`);
    }
  }

  // スタンドアロン投稿を生成
  const xIdeas = plan.plan?.x_post_ideas || [];
  for (const idea of xIdeas.slice(0, maxPosts - posts.length)) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `${xPostPrompt}

投稿タイプ: ${idea.type || "standalone_insight"}
テーマ: ${idea.content_seed}
過去の成功パターン: ${JSON.stringify(xPostPatterns.patterns.slice(-3))}

JSON形式で投稿テキストを生成してください。`,
        },
      ],
    });

    try {
      const text = response.content[0].type === "text" ? response.content[0].text : "{}";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const post = JSON.parse(jsonMatch ? jsonMatch[0] : "{}");
      if (post.text) posts.push(post);
    } catch {
      logError(`Failed to generate standalone post`);
    }
  }

  // 投稿実行
  const results: any[] = [];
  for (const post of posts.slice(0, maxPosts)) {
    try {
      const tweetResult = await postTweet(post.text);
      log(`Posted to X: "${post.text.slice(0, 50)}..."`);
      results.push({
        text: post.text,
        post_type: post.post_type,
        tweet_id: tweetResult?.data?.id,
        status: "posted",
        posted_at: nowISO(),
      });

      // 投稿間隔を確保
      if (posts.indexOf(post) < posts.length - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, thresholds.auto_post_x.min_interval_minutes * 60 * 1000)
        );
      }
    } catch (err) {
      logError(`Failed to post tweet`, err);
      results.push({ text: post.text, status: "error", error: String(err) });
    }
  }

  const xPostsPath = dataPath("trends", `x-posts-${todayStr()}.json`);
  writeJSON(xPostsPath, { date: todayStr(), posted_at: nowISO(), results });

  log(`X posting complete: ${results.filter((r) => r.status === "posted").length} posted`);
}

publishToX().catch((err) => {
  logError("publish-x failed", err);
  process.exit(1);
});

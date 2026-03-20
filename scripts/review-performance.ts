/**
 * review-performance.ts
 * note.com PV/スキ + Xエンゲージメントを収集し、insights.jsonに記録
 */
import crypto from "crypto";
import {
  readJSON, writeJSON, dataPath, configPath,
  log, logError, env, envOr, nowISO, todayStr,
  type PerformanceRecord,
} from "./utils.js";

const NOTE_API_BASE = "https://note.com/api";

async function getNoteAuth(): Promise<{ sessionCookie: string; xsrfToken: string }> {
  const email = env("NOTE_EMAIL");
  const password = env("NOTE_PASSWORD");

  const loginResponse = await fetch(`${NOTE_API_BASE}/v1/sessions/sign_in`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ login: email, password }),
  });

  if (!loginResponse.ok) throw new Error(`Note login failed: ${loginResponse.status}`);
  const data = (await loginResponse.json()) as any;
  const sessionCookie = `_note_session_v5=${data?.data?.token}`;

  const userResponse = await fetch(`${NOTE_API_BASE}/v2/current_user`, {
    headers: { Cookie: sessionCookie, Accept: "application/json" },
  });

  let xsrfToken = "";
  const xsrf = userResponse.headers.get("x-xsrf-token");
  if (xsrf) xsrfToken = decodeURIComponent(xsrf);

  return { sessionCookie, xsrfToken };
}

async function getNoteStats(auth: { sessionCookie: string; xsrfToken: string }): Promise<any[]> {
  const response = await fetch(`${NOTE_API_BASE}/v1/stats/pv`, {
    headers: {
      Cookie: auth.sessionCookie,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    logError(`Failed to get note stats: ${response.status}`);
    return [];
  }

  const data = (await response.json()) as any;
  return data?.data?.note_stats || [];
}

function generateTwitterOAuth(method: string, url: string): string {
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

  const sortedParams = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join("&");

  const baseString = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(sortedParams)}`;
  const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(accessSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  oauthParams.oauth_signature = signature;

  return `OAuth ${Object.keys(oauthParams).sort().map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`).join(", ")}`;
}

async function getXEngagement(): Promise<any[]> {
  // 今日投稿したツイートのIDを取得
  let xPosts: any;
  try {
    xPosts = readJSON(dataPath("trends", `x-posts-${todayStr()}.json`));
  } catch {
    log("No X posts found for today");
    return [];
  }

  const tweetIds = xPosts.results
    ?.filter((r: any) => r.tweet_id)
    .map((r: any) => r.tweet_id) || [];

  if (tweetIds.length === 0) return [];

  const results: any[] = [];
  for (const tweetId of tweetIds) {
    try {
      const url = `https://api.twitter.com/2/tweets/${tweetId}?tweet.fields=public_metrics`;
      const response = await fetch(url, {
        headers: { Authorization: generateTwitterOAuth("GET", url.split("?")[0]) },
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        const metrics = data?.data?.public_metrics;
        if (metrics) {
          results.push({
            tweet_id: tweetId,
            text: xPosts.results.find((r: any) => r.tweet_id === tweetId)?.text || "",
            impressions: metrics.impression_count || 0,
            likes: metrics.like_count || 0,
            retweets: metrics.retweet_count || 0,
            replies: metrics.reply_count || 0,
          });
        }
      }
    } catch (err) {
      logError(`Failed to get engagement for tweet ${tweetId}`, err);
    }
  }

  return results;
}

async function reviewPerformance(): Promise<void> {
  log("Starting performance review...");

  // note.com stats
  let noteStats: any[] = [];
  try {
    const auth = await getNoteAuth();
    noteStats = await getNoteStats(auth);
    log(`Got ${noteStats.length} note stats entries`);
  } catch (err) {
    logError("Failed to get note stats", err);
  }

  // X engagement
  let xEngagement: any[] = [];
  try {
    xEngagement = await getXEngagement();
    log(`Got engagement for ${xEngagement.length} tweets`);
  } catch (err) {
    logError("Failed to get X engagement", err);
  }

  // パフォーマンスレコードを作成
  const record: PerformanceRecord = {
    date: todayStr(),
    note_articles: noteStats.map((s: any) => ({
      title: s.name || s.title || "",
      url: s.note_url || "",
      pv: s.read_count || s.pv || 0,
      likes: s.like_count || s.likes || 0,
      comments: s.comment_count || s.comments || 0,
    })),
    x_posts: xEngagement.map((e) => ({
      text: e.text,
      impressions: e.impressions,
      likes: e.likes,
      retweets: e.retweets,
      replies: e.replies,
    })),
  };

  // insightsに追記
  const insights = readJSON<any>(dataPath("memory", "insights.json"));
  insights.insights.push({
    date: todayStr(),
    performance: record,
    collected_at: nowISO(),
  });
  insights.last_updated = nowISO();
  writeJSON(dataPath("memory", "insights.json"), insights);

  // 個別ファイルにも保存
  writeJSON(dataPath("trends", `review-${todayStr()}.json`), {
    date: todayStr(),
    reviewed_at: nowISO(),
    record,
  });

  // アノマリー検出
  const thresholds = readJSON(configPath("thresholds.json"));
  if (insights.insights.length >= 2) {
    const prev = insights.insights[insights.insights.length - 2];
    const prevTotalPV = prev.performance?.note_articles?.reduce(
      (sum: number, a: any) => sum + (a.pv || 0),
      0
    ) || 0;
    const currentTotalPV = record.note_articles.reduce((sum, a) => sum + a.pv, 0);

    if (prevTotalPV > 0 && currentTotalPV / prevTotalPV < thresholds.notification.anomaly_pv_drop_threshold) {
      log(`ANOMALY: PV dropped ${((1 - currentTotalPV / prevTotalPV) * 100).toFixed(1)}%`);
    }
  }

  log("Performance review complete");
}

reviewPerformance().catch((err) => {
  logError("review-performance failed", err);
  process.exit(1);
});

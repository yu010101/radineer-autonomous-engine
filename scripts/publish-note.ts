/**
 * publish-note.ts
 * note.com APIで記事を投稿（信頼度に基づいて自動公開 or 下書き保存）
 */
import {
  readJSON, writeJSON, dataPath, configPath,
  log, logError, env, nowISO, todayStr,
} from "./utils.js";

const NOTE_API_BASE = "https://note.com/api";

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36",
  Accept: "application/json",
};

async function loginToNote(): Promise<{
  sessionCookie: string;
  xsrfToken: string;
}> {
  const email = env("NOTE_EMAIL");
  const password = env("NOTE_PASSWORD");

  const loginResponse = await fetch(`${NOTE_API_BASE}/v1/sessions/sign_in`, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({ login: email, password }),
  });

  if (!loginResponse.ok) {
    throw new Error(`Login failed: ${loginResponse.status}`);
  }

  const data = (await loginResponse.json()) as any;
  const sessionToken = data?.data?.token;
  if (!sessionToken) throw new Error("No session token in login response");

  const sessionCookie = `_note_session_v5=${sessionToken}`;

  // XSRFトークンを取得
  const currentUserResponse = await fetch(`${NOTE_API_BASE}/v2/current_user`, {
    headers: { ...DEFAULT_HEADERS, Cookie: sessionCookie },
  });

  let xsrfToken = "";
  const xsrf = currentUserResponse.headers.get("x-xsrf-token");
  if (xsrf) {
    xsrfToken = decodeURIComponent(xsrf);
  } else {
    const setCookie = currentUserResponse.headers.get("set-cookie") || "";
    const xsrfMatch = setCookie.match(/XSRF-TOKEN=([^;]+)/);
    if (xsrfMatch) xsrfToken = decodeURIComponent(xsrfMatch[1]);
  }

  if (!xsrfToken) {
    log("Warning: XSRF token not obtained, publishing may fail");
  }

  return { sessionCookie, xsrfToken };
}

async function createNoteDraft(
  title: string,
  body: string,
  tags: string[],
  auth: { sessionCookie: string; xsrfToken: string }
): Promise<any> {
  const response = await fetch(`${NOTE_API_BASE}/v3/notes/draft`, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      Cookie: auth.sessionCookie,
      "X-XSRF-TOKEN": auth.xsrfToken,
      Origin: "https://note.com",
      Referer: "https://note.com/",
    },
    body: JSON.stringify({
      note: {
        name: title,
        body,
        status: "draft",
        type: "TextNote",
        hashtag_notes_attributes: tags.map((tag) => ({ hashtag: { name: tag } })),
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Draft creation failed: ${response.status} - ${errorText}`);
  }

  return (await response.json()) as any;
}

async function publishNote(
  noteId: string,
  auth: { sessionCookie: string; xsrfToken: string }
): Promise<any> {
  const response = await fetch(`${NOTE_API_BASE}/v3/notes/${noteId}/publish`, {
    method: "PUT",
    headers: {
      ...DEFAULT_HEADERS,
      Cookie: auth.sessionCookie,
      "X-XSRF-TOKEN": auth.xsrfToken,
      Origin: "https://note.com",
      Referer: "https://note.com/",
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Publish failed: ${response.status} - ${errorText}`);
  }

  return (await response.json()) as any;
}

async function publishToNote(): Promise<void> {
  log("Starting note.com publishing...");

  const draftsPath = dataPath("trends", `drafts-${todayStr()}.json`);
  let drafts: any;
  try {
    drafts = readJSON(draftsPath);
  } catch {
    logError(`No drafts found for ${todayStr()}`);
    return;
  }

  if (!drafts.articles || drafts.articles.length === 0) {
    log("No articles to publish");
    return;
  }

  const thresholds = readJSON(configPath("thresholds.json"));
  const auth = await loginToNote();
  log("Logged in to note.com");

  const results: any[] = [];

  for (const article of drafts.articles) {
    try {
      // 下書き作成
      const draftResult = await createNoteDraft(
        article.title,
        article.body,
        article.tags || [],
        auth
      );

      const noteId = draftResult?.data?.note?.id || draftResult?.data?.id;
      log(`Draft created: ${article.title} (ID: ${noteId})`);

      // 信頼度に基づいて自動公開判定
      const confidence = article.confidence_score || 0;
      const autoPublish = confidence >= thresholds.auto_publish_note.confidence_threshold;

      if (autoPublish && noteId) {
        await publishNote(noteId, auth);
        log(`Auto-published: "${article.title}" (confidence: ${confidence})`);
        results.push({
          title: article.title,
          note_id: noteId,
          status: "published",
          confidence,
        });
      } else {
        log(
          `Saved as draft: "${article.title}" (confidence: ${confidence} < threshold ${thresholds.auto_publish_note.confidence_threshold})`
        );
        results.push({
          title: article.title,
          note_id: noteId,
          status: "draft",
          confidence,
          reason: "Below confidence threshold",
        });
      }
    } catch (err) {
      logError(`Failed to publish: ${article.title}`, err);
      results.push({ title: article.title, status: "error", error: String(err) });
    }
  }

  // 結果を保存
  const publishPath = dataPath("trends", `published-${todayStr()}.json`);
  writeJSON(publishPath, { date: todayStr(), published_at: nowISO(), results });

  log(`Publishing complete: ${results.filter((r) => r.status === "published").length} published, ${results.filter((r) => r.status === "draft").length} drafts`);
}

publishToNote().catch((err) => {
  logError("publish-note failed", err);
  process.exit(1);
});

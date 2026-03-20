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

  // レスポンスボディからトークン取得を試みる
  let sessionCookie = "";
  const sessionToken = data?.data?.token;
  if (sessionToken) {
    sessionCookie = `_note_session_v5=${sessionToken}`;
  }

  // Set-Cookieヘッダーからもフォールバック
  const setCookieHeader = loginResponse.headers.get("set-cookie") || "";
  if (!sessionCookie && setCookieHeader.includes("_note_session_v5=")) {
    sessionCookie = setCookieHeader.split(";").find((s: string) => s.includes("_note_session_v5"))?.trim() || "";
  }

  if (!sessionCookie) {
    log(`Login response keys: ${JSON.stringify(Object.keys(data?.data || data || {}))}`);
    throw new Error("No session token in login response");
  }

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

function buildNoteHeaders(auth: { sessionCookie: string; xsrfToken: string }) {
  return {
    ...DEFAULT_HEADERS,
    "content-type": "application/json",
    Cookie: auth.sessionCookie,
    "X-XSRF-TOKEN": auth.xsrfToken,
    Origin: "https://note.com",
    Referer: "https://note.com/",
  };
}

async function createNoteDraft(
  title: string,
  body: string,
  tags: string[],
  auth: { sessionCookie: string; xsrfToken: string }
): Promise<any> {
  const headers = buildNoteHeaders(auth);

  // Step 1: 空の下書きを作成して ID を取得
  const createResponse = await fetch(`${NOTE_API_BASE}/v1/text_notes`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      body: "<p></p>",
      body_length: 0,
      name: title || "無題",
      index: false,
      is_lead_form: false,
    }),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`Draft creation failed: ${createResponse.status} - ${errorText}`);
  }

  const createResult = (await createResponse.json()) as any;
  const noteId = createResult?.data?.id?.toString();
  const noteKey = createResult?.data?.key || `n${noteId}`;
  if (!noteId) throw new Error("Draft creation returned no ID");
  log(`Empty draft created: ID=${noteId}, key=${noteKey}`);

  // Step 2: 本文・タグを保存
  const hashtagNotes = tags.map((tag) => ({ hashtag: { name: tag } }));
  const saveResponse = await fetch(
    `${NOTE_API_BASE}/v1/text_notes/draft_save?id=${noteId}&is_temp_saved=true`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: title,
        body,
        body_length: body.length,
        hashtag_notes_attributes: hashtagNotes,
      }),
    }
  );

  if (!saveResponse.ok) {
    const errorText = await saveResponse.text();
    throw new Error(`Draft save failed: ${saveResponse.status} - ${errorText}`);
  }

  return { data: { id: noteId, key: noteKey } };
}

async function publishNote(
  noteId: string,
  title: string,
  body: string,
  tags: string[],
  auth: { sessionCookie: string; xsrfToken: string }
): Promise<any> {
  const headers = buildNoteHeaders(auth);

  // PUT /v1/text_notes/{numericId} で公開
  const response = await fetch(`${NOTE_API_BASE}/v1/text_notes/${noteId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: title,
      body,
      status: "published",
      hashtag_notes_attributes: (tags || []).map((tag) => ({ hashtag: { name: tag } })),
    }),
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
        await publishNote(noteId, article.title, article.body, article.tags || [], auth);
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

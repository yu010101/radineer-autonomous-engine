/**
 * collect-arxiv.ts
 * arXiv API で最新AI論文を取得し、Claude APIで関連度スコアリング
 */
import Anthropic from "@anthropic-ai/sdk";
import { readJSON, writeJSON, dataPath, configPath, log, logError, env, nowISO, type TrendEntry } from "./utils.js";

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  link: string;
  categories: string[];
}

function parseArxivXML(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const getId = (s: string) => s.match(/<id>(.*?)<\/id>/)?.[1] || "";
    const getTitle = (s: string) =>
      s.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, " ") || "";
    const getSummary = (s: string) =>
      s.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim().replace(/\s+/g, " ") || "";
    const getPublished = (s: string) => s.match(/<published>(.*?)<\/published>/)?.[1] || "";

    const authors: string[] = [];
    const authorRegex = /<author>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<\/author>/g;
    let authorMatch;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1]);
    }

    const categories: string[] = [];
    const catRegex = /category term="(.*?)"/g;
    let catMatch;
    while ((catMatch = catRegex.exec(entry)) !== null) {
      categories.push(catMatch[1]);
    }

    const link = entry.match(/<link.*?type="text\/html".*?href="(.*?)"/)?.[1] ||
      entry.match(/<link.*?href="(.*?)"/)?.[1] || "";

    entries.push({
      id: getId(entry),
      title: getTitle(entry),
      summary: getSummary(entry),
      authors,
      published: getPublished(entry),
      link,
      categories,
    });
  }
  return entries;
}

async function collectArxiv(): Promise<void> {
  const topics = readJSON<any>(configPath("topics.json"));
  const categories = (topics.arxiv_categories as string[]) || ["cs.AI", "cs.CL", "cs.LG"];

  log(`Fetching arXiv papers for categories: ${categories.join(", ")}`);

  const catQuery = categories.map((c: string) => `cat:${c}`).join("+OR+");
  const url = `http://export.arxiv.org/api/query?search_query=${catQuery}&sortBy=submittedDate&sortOrder=descending&max_results=20`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`arXiv API error: ${response.status}`);

  const xml = await response.text();
  const entries = parseArxivXML(xml);
  log(`Fetched ${entries.length} papers from arXiv`);

  if (entries.length === 0) {
    log("No papers found, skipping scoring");
    return;
  }

  // Claude APIで関連度スコアリング
  const anthropic = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

  const paperList = entries
    .map((e, i) => `${i + 1}. "${e.title}" - ${e.summary.slice(0, 200)}...`)
    .join("\n");

  const scoringResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `以下のAI論文リストを、「AI×スモールビジネス」「AI×コンテンツ制作」「AI×自動化」の観点で関連度スコアリングしてください。

${paperList}

JSON配列で返してください。上位5件のみ:
[{"index": 1, "relevance_score": 0.9, "reason": "理由"}]`,
      },
    ],
  });

  const scoreContent =
    scoringResponse.content[0].type === "text" ? scoringResponse.content[0].text : "[]";
  let scores: Array<{ index: number; relevance_score: number; reason: string }>;
  try {
    const jsonMatch = scoreContent.match(/\[[\s\S]*\]/);
    scores = JSON.parse(jsonMatch ? jsonMatch[0] : "[]");
  } catch {
    logError("Failed to parse scoring response");
    scores = [];
  }

  const trends: TrendEntry[] = scores
    .filter((s) => s.index > 0 && s.index <= entries.length)
    .map((s) => {
      const paper = entries[s.index - 1];
      return {
        id: paper.id,
        topic: paper.title,
        category: "AI論文",
        summary: `${paper.summary.slice(0, 300)} [${s.reason}]`,
        relevance_score: s.relevance_score,
        source: "arxiv" as const,
        raw_data: { authors: paper.authors, link: paper.link, categories: paper.categories },
        collected_at: nowISO(),
      };
    });

  const filename = `arxiv-${new Date().toISOString().slice(0, 10)}.json`;
  writeJSON(dataPath("trends", filename), { collected_at: nowISO(), trends });
  log(`Saved ${trends.length} arXiv trends to ${filename}`);
}

collectArxiv().catch((err) => {
  logError("collect-arxiv failed", err);
  process.exit(1);
});

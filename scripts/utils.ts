import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const ROOT_DIR = resolve(__dirname, "..");

export function dataPath(...segments: string[]): string {
  return resolve(ROOT_DIR, "data", ...segments);
}

export function configPath(...segments: string[]): string {
  return resolve(ROOT_DIR, "config", ...segments);
}

export function readJSON<T = any>(filePath: string): T {
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export function writeJSON(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

export function envOr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export function logError(msg: string, err?: unknown): void {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, err || "");
}

export interface TrendEntry {
  id: string;
  topic: string;
  category: string;
  summary: string;
  relevance_score: number;
  source: "x" | "arxiv";
  raw_data?: unknown;
  collected_at: string;
}

export interface ContentPlan {
  theme: string;
  angle: string;
  target: string;
  reasoning: string;
  priority: "high" | "medium" | "low";
  estimated_interest_score: number;
}

export interface GeneratedArticle {
  title: string;
  body: string;
  tags: string[];
  confidence_score: number;
  meta: {
    word_count: number;
    reading_time_minutes: number;
    target_audience: string;
  };
}

export interface XPost {
  text: string;
  post_type: string;
  confidence_score: number;
}

export interface PerformanceRecord {
  date: string;
  note_articles: Array<{
    title: string;
    url: string;
    pv: number;
    likes: number;
    comments: number;
  }>;
  x_posts: Array<{
    text: string;
    impressions: number;
    likes: number;
    retweets: number;
    replies: number;
  }>;
}

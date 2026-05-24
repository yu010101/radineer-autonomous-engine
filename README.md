# Radineer Autonomous Engine

> 自律型コンテンツ生成エンジン — トレンド収集 → 計画 → 生成 → 投稿 → 評価 → **週次自己進化** までを無人で回す TypeScript パイプライン。

LLM（Anthropic Claude）と外部シグナル（X トレンド / arXiv）を組み合わせ、「何を書くか」の意思決定から各 SNS への投稿、投稿後パフォーマンスの学習、プロンプト・戦略の自動改善までを一連のループとして自動化する。GitHub Actions の cron で完全無人運用できるよう設計している。

## 特徴

- **End-to-end 自律ループ**: トレンド収集 → 計画立案 → コンテンツ生成 → マルチ投稿 → 効果測定 → 自己進化、を分割スクリプトで構成。各段は単体実行も全段パイプライン実行も可能。
- **週次自己進化（Voyager + OPRO パターン）**: 直近1週間の成果データから成功パターンを抽出し、`data/skills`（スキルDB）と `data/prompts`（プロンプト）を自動更新。翌週の戦略レポートを生成する。手で運用ルールを書き換えるのではなく、結果から運用が更新される。
- **設定駆動（config-driven）**: 文体・しきい値・対象トピック・X 戦略を `config/*.json` に外出し。コードを触らずに振る舞いを調整できる。
- **永続メモリ**: `data/memory/insights.json` に日次インサイトを蓄積し、計画立案・自己進化の入力として再利用する。
- **依存最小**: ランタイム依存は `@anthropic-ai/sdk` と `node-fetch` のみ。ESM + TypeScript strict。

## アーキテクチャ

```
                  ┌─────────────────────────────────────────────┐
                  │            外部シグナル                       │
                  │   X トレンド (xAI/Grok)   arXiv 論文           │
                  └───────────────┬─────────────────────────────┘
                                  │ collect-trends / collect-arxiv
                                  ▼
   data/trends ──►  analyze-and-plan  ──►  generate-content  ──►  publish-note
   data/skills ──►  (今日の計画を決定)      (記事/投稿を生成)        publish-x
   data/memory ──►                                                    │
        ▲                                                             ▼
        │                                                          notify
        │                                                             │
        │              review-performance  ◄──── 投稿後パフォーマンス ─┘
        │              (日次レビュー)
        │                     │
        └───── evolve ◄───────┘
            (週次: 成功パターン抽出 → skills/prompts 自動更新 → 戦略レポート)
```

## パイプライン / スケジュール

GitHub Actions（`.github/workflows/`）で以下の cron を定義している。

| ワークフロー | スケジュール (JST) | 内容 |
|---|---|---|
| `trend-watch` | 毎時 7:00–23:00 | X トレンドを収集して `data/trends/` にコミット |
| `daily-engine` | 日次 7:00 | 収集 → 分析 → 生成 → note/X 投稿 → 通知 |
| `daily-review` | 日次 22:00 | 当日投稿のパフォーマンスを評価して通知 |
| `weekly-evolve` | 毎週月 8:00 | 週間分析 → スキル/プロンプト自動改善 → 戦略レポート |

## スクリプト

| npm script | ファイル | 役割 |
|---|---|---|
| `collect-trends` | `scripts/collect-trends.ts` | X トレンドを収集・正規化 |
| `collect-arxiv` | `scripts/collect-arxiv.ts` | arXiv の関連論文を収集 |
| `analyze` | `scripts/analyze-and-plan.ts` | トレンド＋スキルDB＋メモリから当日の計画を決定 |
| `generate` | `scripts/generate-content.ts` | 計画に沿ってコンテンツを生成 |
| `publish-note` | `scripts/publish-note.ts` | note へ投稿 |
| `publish-x` | `scripts/publish-x.ts` | X へ投稿 |
| `review` | `scripts/review-performance.ts` | 投稿後のパフォーマンスを集計・評価 |
| `evolve` | `scripts/evolve.ts` | 週次の自己改善（成功パターン抽出・プロンプト改善） |
| `notify` | `scripts/notify.ts` | 実行結果を通知 |

集約コマンド:

```bash
npm run daily-engine    # collect-trends → analyze → generate → publish-note → publish-x → notify
npm run daily-review    # review → notify(--type=review)
npm run weekly-evolve   # evolve → notify(--type=weekly)
```

## ディレクトリ構成

```
radineer-autonomous-engine/
├── scripts/            # パイプライン各段（TypeScript）
├── config/             # 文体・しきい値・トピック・X戦略（JSON, 設定駆動）
│   ├── editorial-voice.json
│   ├── thresholds.json
│   ├── topics.json
│   └── x-strategy.json
├── data/
│   ├── trends/         # 収集したトレンド（時系列 JSON）
│   ├── memory/         # 日次インサイトの永続メモリ
│   ├── skills/         # スキルDB（自己進化で更新）
│   └── prompts/        # プロンプト（自己進化で更新）
└── .github/workflows/  # cron による無人運用定義
```

## セットアップ

```bash
npm ci
npm run build          # tsc → dist/

# 単体実行の例
npm run collect-trends
npm run analyze
```

### 環境変数

| 変数 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | コンテンツ生成・分析・自己進化（Claude） |
| `XAI_API_KEY` | X トレンド収集（xAI / Grok） |

GitHub Actions では各ワークフローの `secrets` に設定する。

## 設計メモ

- **自己進化ループ**は [Voyager](https://arxiv.org/abs/2305.16291)（スキルライブラリの自動蓄積）と [OPRO](https://arxiv.org/abs/2309.03409)（最適化器としてのLLMによるプロンプト改善）の考え方を取り入れている。運用知見をコードでなくデータ（`skills`/`prompts`）側に貯め、結果から更新する。
- 各段を独立スクリプトに分割しているため、途中段からの再開・段単位の差し替え・部分的な手動運用がしやすい。

## ステータス

個人プロジェクト。アーキテクチャと各段の実装は本リポジトリの通りで、設定・シークレットを与えれば cron で自走する構成。運用実績値はここには記載しない。

## License

MIT

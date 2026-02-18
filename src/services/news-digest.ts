// src/services/news-digest.ts
// ============================================================
// News Digest — Tóm tắt HN + GitHub trending cho anh Tuấn
// ============================================================
// Học từ: OpenClaw proactive agents, Moltworker news aggregation
//
// Flow: fetch HN front page + GitHub trending → filter AI/dev →
//       Haiku summarize → gửi Telegram digest
// Chạy cron mỗi ngày 8h sáng VN (1:00 UTC).
// ============================================================

import { query } from "@anthropic-ai/claude-agent-sdk";

const DIGEST_PROMPT = `Bạn là trợ lý AI tóm tắt tin tức công nghệ. Phân tích danh sách bài viết và tạo bản tin ngắn gọn.

Quy tắc:
- Chọn tối đa 7 bài HAY NHẤT, ưu tiên: AI agents, Claude/Anthropic, Go, game dev, open source tools
- Bỏ qua: job posts, drama, offtopic
- Mỗi bài: 1 dòng tóm tắt + link
- Nếu có repo GitHub hay, ghi rõ stars và tại sao hay
- Viết tiếng Việt, ngắn gọn, dễ đọc trên mobile
- Format Telegram markdown (bold, italic)

Output format:
📰 **Tin Tức Hôm Nay**

1. **Tiêu đề** — tóm tắt 1 câu
   🔗 link

2. ...

💡 **Đáng chú ý**: [1 câu highlight nếu có gì đặc biệt]`;

interface NewsItem {
  title: string;
  url: string;
  score?: number;
  source: string;
}

/**
 * Fetch Hacker News front page (top 30 stories).
 */
async function fetchHackerNews(): Promise<NewsItem[]> {
  try {
    const resp = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {
      signal: AbortSignal.timeout(10000),
    });
    const ids = (await resp.json()) as number[];
    const top30 = ids.slice(0, 30);

    // Fetch story details (batch 10 at a time)
    const items: NewsItem[] = [];
    for (let i = 0; i < top30.length; i += 10) {
      const batch = top30.slice(i, i + 10);
      const stories = await Promise.allSettled(
        batch.map(async (id) => {
          const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
            signal: AbortSignal.timeout(5000),
          });
          return r.json();
        }),
      );

      for (const result of stories) {
        if (result.status === "fulfilled" && result.value) {
          const s = result.value as any;
          if (s.title && !s.deleted && !s.dead) {
            items.push({
              title: s.title,
              url: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
              score: s.score || 0,
              source: "HN",
            });
          }
        }
      }
    }

    return items;
  } catch (error) {
    console.warn("⚠️ News: HN fetch error:", error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Fetch GitHub trending (scrape trending page).
 */
async function fetchGitHubTrending(): Promise<NewsItem[]> {
  try {
    const resp = await fetch("https://api.github.com/search/repositories?q=stars:>100+pushed:>2026-02-01&sort=stars&order=desc&per_page=15", {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "KuroBot/1.0",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      // Fallback: try trending page
      return await fetchGitHubTrendingFallback();
    }

    const data = await resp.json() as any;
    const items: NewsItem[] = [];

    for (const repo of (data.items || []).slice(0, 15)) {
      items.push({
        title: `${repo.full_name} — ${repo.description || ""}`.slice(0, 120),
        url: repo.html_url,
        score: repo.stargazers_count,
        source: "GitHub",
      });
    }

    return items;
  } catch (error) {
    console.warn("⚠️ News: GitHub fetch error:", error instanceof Error ? error.message : error);
    return [];
  }
}

async function fetchGitHubTrendingFallback(): Promise<NewsItem[]> {
  try {
    const resp = await fetch("https://github.com/trending?since=daily", {
      headers: { "User-Agent": "KuroBot/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    const html = await resp.text();

    // Parse repo names từ trending page
    const items: NewsItem[] = [];
    const repoRegex = /href="\/([^"]+\/[^"]+)"[^>]*class="[^"]*Link[^"]*"/g;
    const matches = [...html.matchAll(/class="Box-row"[\s\S]*?<h2[\s\S]*?<a href="\/([\w.-]+\/[\w.-]+)"/g)];

    for (const match of matches.slice(0, 10)) {
      const fullName = match[1];
      items.push({
        title: fullName || "",
        url: `https://github.com/${fullName}`,
        source: "GitHub",
      });
    }

    return items;
  } catch {
    return [];
  }
}

/**
 * Tạo digest bằng Haiku.
 */
async function generateDigest(items: NewsItem[]): Promise<string> {
  if (items.length === 0) return "";

  const input = items
    .map((item) => {
      const scoreStr = item.score ? ` (${item.source === "GitHub" ? "⭐" : "▲"}${item.score})` : "";
      return `[${item.source}] ${item.title}${scoreStr}\n  ${item.url}`;
    })
    .join("\n\n");

  try {
    const stream = query({
      prompt: input,
      options: {
        model: "claude-haiku-4-5-20251001",
        systemPrompt: DIGEST_PROMPT,
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "bypassPermissions",
      },
    });

    let resultText = "";
    for await (const message of stream) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ((block as any).type === "text") {
            resultText += (block as any).text;
          }
        }
      }
      if (message.type === "result" && "result" in message && message.result) {
        if (!resultText) resultText = message.result;
      }
    }

    return resultText.trim();
  } catch (error) {
    console.error("⚠️ News digest error:", error instanceof Error ? error.message : error);
    // Fallback: raw list
    return items
      .slice(0, 7)
      .map((item, i) => `${i + 1}. ${item.title}\n   ${item.url}`)
      .join("\n\n");
  }
}

/**
 * Fetch + summarize + return digest text.
 */
export async function createNewsDigest(): Promise<string> {
  console.log("📰 News Digest: fetching sources...");

  const [hnItems, ghItems] = await Promise.all([
    fetchHackerNews(),
    fetchGitHubTrending(),
  ]);

  console.log(`📰 News Digest: HN=${hnItems.length}, GitHub=${ghItems.length}`);

  const allItems = [...hnItems, ...ghItems];
  if (allItems.length === 0) {
    return "📰 Không fetch được tin tức hôm nay. Sẽ thử lại sau.";
  }

  const digest = await generateDigest(allItems);
  return digest || "📰 Không có tin tức đáng chú ý hôm nay.";
}

// --- Cron ---

let intervalId: ReturnType<typeof setInterval> | null = null;
let notifyFn: ((message: string) => Promise<void>) | null = null;

/**
 * Start news digest cron.
 * Gửi digest mỗi ngày 8h sáng VN.
 */
export function startNewsDigest(
  notify: (message: string) => Promise<void>,
): void {
  notifyFn = notify;

  // Schedule cho 8h sáng VN (1:00 UTC) mỗi ngày
  scheduleDaily(1, 0, sendDigest);
  console.log("📰 News Digest started (mỗi ngày 8h sáng VN)");
}

export function stopNewsDigest(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("📰 News Digest stopped");
  }
}

async function sendDigest(): Promise<void> {
  if (!notifyFn) return;
  try {
    const digest = await createNewsDigest();
    await notifyFn(digest);
  } catch (error) {
    console.error("⚠️ News digest send error:", error instanceof Error ? error.message : error);
  }
}

/**
 * Schedule function chạy mỗi ngày vào giờ UTC cố định.
 */
function scheduleDaily(hourUTC: number, minuteUTC: number, fn: () => void): void {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hourUTC, minuteUTC, 0, 0);

  // Nếu đã qua giờ hôm nay, schedule cho ngày mai
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  const msUntilFirst = target.getTime() - now.getTime();
  console.log(`📰 Next digest in ${Math.round(msUntilFirst / 60000)} minutes`);

  setTimeout(() => {
    fn();
    // Sau lần đầu, lặp mỗi 24h
    intervalId = setInterval(fn, 24 * 60 * 60 * 1000);
  }, msUntilFirst);
}

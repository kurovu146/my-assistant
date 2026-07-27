// src/memory/categories.ts
// ============================================================
// Taxonomy category cho memory facts
// ============================================================
// Một nguồn duy nhất, dùng chung cho: enum của memory_save (MCP),
// prompt trích xuất (Tier 1) và prompt consolidation. Trước đây danh
// sách bị chép ở ba nơi nên sửa một chỗ là lệch hai chỗ còn lại.
//
// Lịch sử: `personal` và `technical` từng là hai nhóm thùng rác —
// technical có lúc ôm 56% số fact (stack, deploy, thuật toán, dữ liệu
// nghiệp vụ lẫn lộn). Bộ này xẻ chúng ra để tra cứu còn có nghĩa.
// ============================================================

export const MEMORY_CATEGORIES = {
  // Cá nhân
  identity: "tên, tuổi, sinh nhật, nơi ở",
  hobby: "sở thích, giải trí, thú vui",
  health: "sức khỏe, thói quen sinh hoạt",
  relationship: "gia đình, bạn bè, đồng nghiệp",

  // Kỹ thuật
  stack: "ngôn ngữ, framework, thư viện đang dùng",
  architecture: "thiết kế hệ thống, pattern, cấu trúc code",
  infra: "deploy, server, CI/CD, process manager",
  convention: "quy ước code, commit, đặt tên",

  // Cách làm việc
  preference: "thích hoặc không thích cách làm nào đó",
  workflow: "quy trình, thao tác lặp lại",
  decision: "quyết định đã chốt kèm lý do",

  // Dự án
  project: "bối cảnh, trạng thái, deadline của dự án",
  domain: "kiến thức nghiệp vụ của lĩnh vực đang làm",
} as const;

export type MemoryCategory = keyof typeof MEMORY_CATEGORIES;

export const CATEGORY_NAMES = Object.keys(MEMORY_CATEGORIES) as [MemoryCategory, ...MemoryCategory[]];

/** Nhãn dự phòng khi model trả về giá trị lạ — không quảng bá trong prompt. */
export const FALLBACK_CATEGORY = "general";

/** Danh sách kèm mô tả để nhúng vào prompt. */
export function categoryGuide(): string {
  return Object.entries(MEMORY_CATEGORIES)
    .map(([name, desc]) => `- ${name}: ${desc}`)
    .join("\n");
}

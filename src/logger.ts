function timestamp(): string {
  return new Date().toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export const logger = {
  log(...args: unknown[]) {
    console.log(`[${timestamp()}]`, ...args);
  },
  error(...args: unknown[]) {
    console.error(`[${timestamp()}]`, ...args);
  },
  warn(...args: unknown[]) {
    console.warn(`[${timestamp()}]`, ...args);
  },
};

import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // stage colors used by the pipeline board
        applied: "#64748b",
        assessment: "#f59e0b",
        interview: "#6366f1",
        offer: "#10b981",
        rejected: "#ef4444",
        ghosted: "#94a3b8",
      },
    },
  },
  plugins: [],
};

export default config;

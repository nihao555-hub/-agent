/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#FBFBFA",
        bone: "#F7F6F3",
        surface: "#FFFFFF",
        line: "#EAEAEA",
        ink: "#1F2421",
        charcoal: "#2F3437",
        muted: "#787774",
        // semantic spot pastels
        "pale-red": "#FDEBEC",
        "pale-red-ink": "#9F2F2D",
        "pale-blue": "#E1F3FE",
        "pale-blue-ink": "#1F6C9F",
        "pale-green": "#EDF3EC",
        "pale-green-ink": "#346538",
        "pale-yellow": "#FBF3DB",
        "pale-yellow-ink": "#956400",
      },
      fontFamily: {
        sans: ["Switzer", "Geist Sans", "Helvetica Neue", "system-ui", "sans-serif"],
        serif: ["Newsreader", "Lyon Text", "Georgia", "serif"],
        mono: ["JetBrains Mono", "Geist Mono", "SF Mono", "monospace"],
      },
      borderRadius: {
        card: "12px",
      },
      boxShadow: {
        lift: "0 2px 8px rgba(0,0,0,0.04)",
      },
    },
  },
  plugins: [],
};

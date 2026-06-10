import "./globals.css";

export const metadata = {
  title: "BreakoutIntel",
  description: "AI Swing Trading Dashboard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

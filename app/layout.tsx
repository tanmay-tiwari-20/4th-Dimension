import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "4th Dimension — Explore Time",
  description: "Explore video as a temporal cube in 4th Dimension.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

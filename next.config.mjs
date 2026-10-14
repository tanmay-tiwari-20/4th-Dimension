/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep development and production outputs separate to avoid manifest and file
  // lock races when both workflows run on Windows.
  // Keep the Windows dev server isolated while leaving production output at
  // Next.js's standard `.next` path for Vercel deployment detection.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
};
export default nextConfig;

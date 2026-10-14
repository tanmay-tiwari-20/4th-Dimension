/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep development and production outputs separate to avoid manifest and file
  // lock races when both workflows run on Windows.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next-prod",
};
export default nextConfig;

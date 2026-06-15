import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The ARES API server runs separately (npm run serve, default :3001).
  // NEXT_PUBLIC_ARES_API points the client at it.
  reactStrictMode: true,
  // Emit a self-contained server bundle (.next/standalone) so the Docker runtime
  // image carries only the traced node_modules, not the whole dependency tree.
  output: 'standalone',
  // Pin the file-tracing root to this app. Without it, Next.js walks up and
  // finds a stray package-lock.json under the user's home and infers the wrong
  // workspace root (emitting a warning and tracing the wrong files).
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;

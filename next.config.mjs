/** @type {import('next').NextConfig} */
const nextConfig = {
  // Client-only app with a static export: the whole editor runs in the
  // browser against IndexedDB, so the production build is plain static files.
  output: 'export',
};

export default nextConfig;

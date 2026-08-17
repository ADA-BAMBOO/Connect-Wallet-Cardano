import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 dùng Turbopack mặc định, vốn đã hỗ trợ WebAssembly sẵn nên không cần
  // cấu hình `experiments.asyncWebAssembly` như thời webpack.
  turbopack: {},

  // Mesh SDK kéo theo WASM (@meshsdk/core-cst) và vài API Node. Giữ chúng ở dạng
  // package ngoài để Next không cố bundle phần native đó vào server build.
  serverExternalPackages: ["@meshsdk/core", "@meshsdk/core-cst", "@meshsdk/core-csl"],
};

export default nextConfig;

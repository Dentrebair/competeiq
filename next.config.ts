import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Pin the Turbopack workspace root to this project.
   *
   * There is a stray package-lock.json in /Users/ajay (outside this repo). Next
   * walks upward looking for a lockfile to infer the workspace root, finds that
   * one, and warns. It currently ignores it because it sits outside the git repo,
   * but "currently" is doing a lot of work in that sentence — pinning the root
   * removes the ambiguity rather than relying on that fallback.
   *
   * Worth deleting that stray lockfile too; something ran `npm install` in your
   * home directory at some point.
   */
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
};

export default nextConfig;

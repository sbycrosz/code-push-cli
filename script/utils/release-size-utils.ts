// Licensed under the MIT License.

import * as fs from "fs";
import * as path from "path";

export const MAX_ASSET_SIZE_BYTES = 500 * 1024;
export const MAX_BUNDLE_SIZE_BYTES = 10 * 1024 * 1024;
export const ASSET_OPTIMIZATION_DOCS_URL = "https://docs.revopush.org/performance/react-native-ota-assets-optimization";
export const SENTRY_SOURCE_MAP_DOCS_URL = "https://docs.revopush.org/cicd/sentry";

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;

export interface ReleaseFileInfo {
  path: string;
  size: number;
}

export interface ReleaseSizeAnalysis {
  bundleSize: number;
  oversizedAssets: ReleaseFileInfo[];
  sourceMaps: ReleaseFileInfo[];
}

export function shouldAnalyzeReleaseSizes(platform: string): boolean {
  const normalizedPlatform = platform.toLowerCase();
  return normalizedPlatform === "android" || normalizedPlatform === "ios";
}

export function analyzeReleaseContents(outputFolder: string, bundleName: string): ReleaseSizeAnalysis {
  const bundlePath = path.resolve(outputFolder, bundleName);
  const bundleStat = fs.statSync(bundlePath);

  if (!bundleStat.isFile()) {
    throw new Error(`Generated bundle "${bundlePath}" is not a file.`);
  }

  const oversizedAssets: ReleaseFileInfo[] = [];
  const sourceMaps: ReleaseFileInfo[] = [];

  function visitDirectory(directoryPath: string): void {
    const entries = fs.readdirSync(directoryPath);

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry);
      const stat = fs.lstatSync(absolutePath);

      if (stat.isDirectory()) {
        visitDirectory(absolutePath);
      } else if (stat.isFile() && path.resolve(absolutePath) !== bundlePath) {
        const fileInfo: ReleaseFileInfo = {
          path: normalizeRelativePath(path.relative(outputFolder, absolutePath)),
          size: stat.size,
        };

        if (stat.size > MAX_ASSET_SIZE_BYTES) {
          oversizedAssets.push(fileInfo);
        }

        if (path.extname(absolutePath).toLowerCase() === ".map") {
          sourceMaps.push(fileInfo);
        }
      }
    }
  }

  visitDirectory(outputFolder);
  oversizedAssets.sort((left, right) => comparePaths(left.path, right.path));
  sourceMaps.sort((left, right) => comparePaths(left.path, right.path));

  return {
    bundleSize: bundleStat.size,
    oversizedAssets,
    sourceMaps,
  };
}

export function enforceAssetSizeLimit(analysis: ReleaseSizeAnalysis, force: boolean): void {
  if (analysis.oversizedAssets.length > 0 && !force) {
    throw new Error(formatOversizedAssetsError(analysis.oversizedAssets));
  }
}

export function formatReleaseSizeWarnings(analysis: ReleaseSizeAnalysis, force: boolean): string | null {
  const sections: string[] = [];

  if (force && analysis.oversizedAssets.length > 0) {
    sections.push(
      [
        "Release completed because --force was used, but these assets exceed the 500 KiB per-file limit:",
        formatAssetList(analysis.oversizedAssets),
        `Learn how to optimize OTA assets: ${ASSET_OPTIMIZATION_DOCS_URL}`,
      ].join("\n")
    );
  }

  if (analysis.bundleSize > MAX_BUNDLE_SIZE_BYTES) {
    sections.push(
      [
        `The generated JS/Hermes bundle is ${formatFileSize(analysis.bundleSize)}, exceeding the 10 MiB warning threshold.`,
        "To reduce the update size, use diff updates.",
      ].join("\n")
    );
  }

  if (sections.length === 0) {
    return null;
  }

  return ["[Warning] Release size checks:", sections.join("\n\n")].join("\n");
}

export function formatSourceMapWarning(sourceMaps: ReleaseFileInfo[]): string | null {
  if (sourceMaps.length === 0) {
    return null;
  }

  return [
    "[Warning] Source map files were found in the generated release:",
    sourceMaps.map((sourceMap) => `- ${sourceMap.path}`).join("\n"),
    `Configure source map upload to Sentry: ${SENTRY_SOURCE_MAP_DOCS_URL}`,
  ].join("\n");
}

export function formatFileSize(size: number): string {
  const divisor = size >= MEBIBYTE ? MEBIBYTE : KIBIBYTE;
  const unit = size >= MEBIBYTE ? "MiB" : "KiB";
  return `${(size / divisor).toFixed(2)} ${unit} (${size} bytes)`;
}

function formatOversizedAssetsError(assets: ReleaseFileInfo[]): string {
  return [
    "Generated assets exceed the 500 KiB per-file limit:",
    formatAssetList(assets),
    "",
    "Optimize or remove these files, or rerun the command with --force to release anyway.",
    `Learn how to optimize OTA assets: ${ASSET_OPTIMIZATION_DOCS_URL}`,
  ].join("\n");
}

function formatAssetList(assets: ReleaseFileInfo[]): string {
  return assets.map((asset) => `- ${asset.path} (${formatFileSize(asset.size)})`).join("\n");
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function comparePaths(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

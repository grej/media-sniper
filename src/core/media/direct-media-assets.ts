import type { DirectMediaAsset, VideoMetadata } from "../types";
import { hasM4sMediaHint, normalizeUrl } from "../utils/url-utils";

function positive(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : 0;
}

function inferredHeight(asset: DirectMediaAsset): number {
  if (positive(asset.height)) return asset.height!;
  const text = `${asset.quality ?? ""} ${asset.url}`;
  const explicit = text.match(/(?:^|[^\d])(\d{3,4})p(?:[^\d]|$)/i)?.[1];
  if (explicit) return Number(explicit);
  const dimensions = text.match(/(?:^|[^\d])(\d{3,4})[x×](\d{3,4})(?:[^\d]|$)/i);
  return dimensions?.[2] ? Number(dimensions[2]) : 0;
}

function inferredWidth(asset: DirectMediaAsset): number {
  if (positive(asset.width)) return asset.width!;
  const dimensions = `${asset.quality ?? ""} ${asset.url}`
    .match(/(?:^|[^\d])(\d{3,4})[x×](\d{3,4})(?:[^\d]|$)/i);
  return dimensions?.[1] ? Number(dimensions[1]) : 0;
}

function compareAssets(left: DirectMediaAsset, right: DirectMediaAsset): number {
  const leftHeight = inferredHeight(left);
  const rightHeight = inferredHeight(right);
  return rightHeight - leftHeight
    || inferredWidth(right) - inferredWidth(left)
    || positive(right.bandwidth) - positive(left.bandwidth)
    || positive(right.contentLength) - positive(left.contentLength)
    || positive(right.observedAt) - positive(left.observedAt)
    || normalizeUrl(left.url).localeCompare(normalizeUrl(right.url));
}

export function directMediaAssetFromMetadata(
  metadata: VideoMetadata,
): DirectMediaAsset {
  return {
    url: metadata.url,
    kind: metadata.isSelfContainedFmp4 || hasM4sMediaHint(metadata.url)
      ? "self-contained-fmp4"
      : "progressive",
    sourceKey: metadata.sourceKey,
    sourceUrl: metadata.sourceUrl,
    observedAt: metadata.observedAt,
    contentType: metadata.contentType,
    contentLength: metadata.contentLength,
    width: metadata.width,
    height: metadata.height,
    quality: metadata.quality ?? metadata.resolution,
  };
}

export function mergeDirectMediaAssets(
  ...groups: Array<readonly DirectMediaAsset[] | undefined>
): DirectMediaAsset[] {
  const merged = new Map<string, DirectMediaAsset>();
  for (const asset of groups.flatMap((group) => group ?? [])) {
    if (!asset?.url) continue;
    const key = asset.sourceKey ?? normalizeUrl(asset.url);
    const existing = merged.get(key);
    const defined = Object.fromEntries(
      Object.entries(asset).filter(([, value]) => value !== undefined),
    ) as unknown as DirectMediaAsset;
    merged.set(key, existing ? { ...existing, ...defined } : defined);
  }
  return [...merged.values()].sort(compareAssets);
}

export function selectBestDirectMediaAsset(
  metadata: VideoMetadata,
): DirectMediaAsset {
  return mergeDirectMediaAssets(
    metadata.mediaAssets,
    [directMediaAssetFromMetadata(metadata)],
  )[0]!;
}

export function applySelectedDirectMediaAsset(
  metadata: VideoMetadata,
  selected: DirectMediaAsset,
  assets: readonly DirectMediaAsset[] = metadata.mediaAssets ?? [],
): VideoMetadata {
  return {
    ...metadata,
    url: selected.url,
    sourceKey: selected.sourceKey ?? metadata.sourceKey,
    sourceUrl: selected.sourceUrl ?? metadata.sourceUrl,
    observedAt: selected.observedAt ?? metadata.observedAt,
    contentType: selected.contentType ?? metadata.contentType,
    contentLength: selected.contentLength ?? metadata.contentLength,
    fileExtension: selected.kind === "self-contained-fmp4"
      ? "mp4"
      : metadata.fileExtension,
    isSelfContainedFmp4: selected.kind === "self-contained-fmp4",
    mediaAssets: [...assets],
  };
}

/** Apply the best complete asset while retaining every discovered variant. */
export function applyBestDirectMediaAsset(
  metadata: VideoMetadata,
  assets: readonly DirectMediaAsset[],
): VideoMetadata {
  const merged = mergeDirectMediaAssets(
    metadata.mediaAssets,
    assets,
    [directMediaAssetFromMetadata(metadata)],
  );
  const best = merged[0]!;
  return applySelectedDirectMediaAsset(metadata, best, merged);
}

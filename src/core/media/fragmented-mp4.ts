const MIN_BOX_HEADER_BYTES = 8;
const MAX_TOP_LEVEL_BOXES = 64;

export interface IsoBmffInspection {
  complete: boolean;
  hasFtyp: boolean;
  hasMoov: boolean;
  hasMoof: boolean;
  hasMdat: boolean;
  reason?: string;
}

interface BoxHeader {
  type: string;
  size: number;
  headerSize: number;
}

function readUint64(view: DataView, offset: number): number | undefined {
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  const value = high * 2 ** 32 + low;
  return Number.isSafeInteger(value) ? value : undefined;
}

function readBoxHeader(view: DataView, offset: number): BoxHeader | undefined {
  if (view.byteLength - offset < MIN_BOX_HEADER_BYTES) return undefined;
  const size32 = view.getUint32(offset, false);
  const type = String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7),
  );
  if (!/^[\x20-\x7e]{4}$/.test(type)) return undefined;
  if (size32 === 1) {
    if (view.byteLength - offset < 16) return undefined;
    const size = readUint64(view, offset + 8);
    return size && size >= 16 ? { type, size, headerSize: 16 } : undefined;
  }
  if (size32 === 0) {
    return { type, size: view.byteLength - offset, headerSize: 8 };
  }
  return size32 >= 8 ? { type, size: size32, headerSize: 8 } : undefined;
}

/**
 * Inspect complete bytes or a sufficiently large prefix for the required
 * top-level fMP4 order. The mdat payload itself need not fit in the prefix;
 * seeing its valid header after ftyp, moov, and moof is sufficient.
 */
export function inspectSelfContainedFragmentedMp4(
  data: ArrayBuffer | Uint8Array,
): IsoBmffInspection {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let boxCount = 0;
  let hasFtyp = false;
  let hasMoov = false;
  let hasMoof = false;
  let hasMdat = false;

  while (offset < view.byteLength && boxCount < MAX_TOP_LEVEL_BOXES) {
    const box = readBoxHeader(view, offset);
    if (!box) break;
    boxCount += 1;

    if (box.type === "ftyp" && offset === 0) hasFtyp = true;
    if (box.type === "moov" && hasFtyp && !hasMoof) hasMoov = true;
    if (box.type === "moof" && hasFtyp && hasMoov) hasMoof = true;
    if (box.type === "mdat" && hasFtyp && hasMoov && hasMoof) {
      hasMdat = true;
      break;
    }

    if (box.size < box.headerSize || offset + box.size > view.byteLength) break;
    offset += box.size;
  }

  const complete = hasFtyp && hasMoov && hasMoof && hasMdat;
  return {
    complete,
    hasFtyp,
    hasMoov,
    hasMoof,
    hasMdat,
    reason: complete
      ? undefined
      : "The resource does not contain top-level ftyp, moov, moof, and mdat boxes in order.",
  };
}

export interface ParsedContentRange {
  start: number;
  end: number;
  total: number;
}

export function parseCompleteContentRange(
  value: string | null | undefined,
): ParsedContentRange | undefined {
  const match = value?.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) return undefined;
  return { start, end, total };
}

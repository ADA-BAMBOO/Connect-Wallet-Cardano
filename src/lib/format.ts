/**
 * Các hàm tiện ích format dữ liệu Cardano.
 * Không import gì từ Mesh SDK để có thể dùng ở cả server lẫn client.
 */

/** 1 ADA = 1.000.000 lovelace */
export const LOVELACE_PER_ADA = 1_000_000n;

/** Đổi lovelace (chuỗi số nguyên) sang ADA dạng chuỗi, không mất chính xác. */
export function lovelaceToAda(lovelace: string | undefined, decimals = 6): string {
  if (!lovelace) return "0";

  let value: bigint;
  try {
    value = BigInt(lovelace);
  } catch {
    return "0";
  }

  const negative = value < 0n;
  if (negative) value = -value;

  const whole = value / LOVELACE_PER_ADA;
  const fraction = (value % LOVELACE_PER_ADA).toString().padStart(6, "0").slice(0, decimals);

  const wholeFormatted = whole.toLocaleString("en-US");
  const result = decimals > 0 ? `${wholeFormatted}.${fraction}` : wholeFormatted;

  return negative ? `-${result}` : result;
}

/** Đổi ADA người dùng nhập (vd "1.5") sang lovelace dạng chuỗi. Trả về null nếu không hợp lệ. */
export function adaToLovelace(ada: string): string | null {
  const trimmed = ada.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;

  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > 6) return null; // ADA chỉ có 6 chữ số thập phân

  const lovelace = BigInt(whole || "0") * LOVELACE_PER_ADA + BigInt(fraction.padEnd(6, "0") || "0");
  return lovelace.toString();
}

/** Rút gọn địa chỉ/hash dài: addr1qx…9f3k */
export function truncate(value: string | undefined, head = 12, tail = 8): string {
  if (!value) return "";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** true nếu chuỗi chỉ chứa ký tự in được (không có control character). */
function isPrintable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Giải mã hex sang UTF-8, trả về null nếu không phải chuỗi đọc được. */
export function hexToUtf8(hex: string): string | null {
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;

  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Dữ liệu nhị phân có thể decode "thành công" nhưng chứa control char — không phải tên thật.
    return isPrintable(text) ? text : null;
  } catch {
    return null;
  }
}

export type ParsedUnit = {
  /** unit gốc: policyId + assetNameHex */
  unit: string;
  /** 56 ký tự hex đầu */
  policyId: string;
  /** phần hex còn lại */
  assetNameHex: string;
  /** Tên đọc được nếu decode được, ngược lại rơi về hex rút gọn */
  displayName: string;
};

/** Tách `unit` của native token thành policy ID và asset name. */
export function parseUnit(unit: string): ParsedUnit {
  const policyId = unit.slice(0, 56);
  const assetNameHex = unit.slice(56);
  const decoded = hexToUtf8(assetNameHex);

  return {
    unit,
    policyId,
    assetNameHex,
    displayName:
      decoded || (assetNameHex ? `#${truncate(assetNameHex, 6, 4)}` : truncate(policyId, 6, 4)),
  };
}

/** Format số lượng token theo số thập phân của nó (mặc định 0 — token thường là số nguyên). */
export function formatQuantity(quantity: string, decimals = 0): string {
  try {
    if (decimals === 0) return BigInt(quantity).toLocaleString("en-US");

    const divisor = 10n ** BigInt(decimals);
    const value = BigInt(quantity);
    const whole = (value / divisor).toLocaleString("en-US");
    const fraction = (value % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");

    return fraction ? `${whole}.${fraction}` : whole;
  } catch {
    return quantity;
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/*
 * Swatch sinh từ policy ID — dùng làm placeholder cho NFT và token chưa có ảnh.
 *
 * Bản cũ là `hsl(hue 70% 55%)`: hue thay đổi thì ĐỘ CHÓI cũng thay đổi theo, vì
 * ở cùng một lightness thì vàng chói gấp nhiều lần lam. Hệ quả là hai thứ cùng
 * hỏng — dải neon vàng/lơ phá tông giao diện tối, và chữ trắng đặt lên nửa vòng
 * màu sáng tụt xuống dưới 3:1.
 *
 * Ở đây lightness được dò riêng cho từng hue sao cho MỌI swatch có cùng độ chói
 * (~0.105). Hue vẫn chạy đủ 360° để phân biệt asset, nhưng độ chói không đổi:
 * swatch nào cũng đủ tối để hợp nền, và chữ sáng luôn đạt ≥5.8:1 trên tất cả.
 */
const SWATCH_SATURATION = 0.58;
const SWATCH_LUMINANCE = 0.105;

/** Màu chữ đặt lên swatch. Cố định được vì mọi swatch có cùng độ chói. */
export const SWATCH_FOREGROUND = "#e7f0ea";

/** Sinh màu ổn định từ một chuỗi — dùng làm avatar/placeholder cho NFT. */
export function colorFromString(value: string): string {
  const hue = hashString(value) % 360;
  const lightness = lightnessForLuminance(hue, SWATCH_LUMINANCE);
  return `hsl(${hue} ${Math.round(SWATCH_SATURATION * 100)}% ${(lightness * 100).toFixed(1)}%)`;
}

/**
 * Lightness nhỏ nhất khiến hue này đạt đúng độ chói mong muốn.
 * Không có công thức đảo ngược nên chia đôi — 18 vòng là dưới 1e-5, thừa chính
 * xác cho một giá trị CSS, và chỉ chạy một lần cho mỗi asset.
 */
function lightnessForLuminance(hue: number, target: number): number {
  let low = 0;
  let high = 1;

  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    if (relativeLuminance(hslToRgb(hue, SWATCH_SATURATION, mid)) < target) low = mid;
    else high = mid;
  }

  return (low + high) / 2;
}

/** Độ chói tương đối theo WCAG. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;

  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];

  return [r + m, g + m, b + m];
}

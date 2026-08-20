"use client";

import { useMemo } from "react";
import qrcode from "qrcode-generator";

import { useDict } from "@/lib/i18n/client";

/**
 * Mã QR vẽ bằng SVG.
 *
 * Vì sao dùng thư viện thay vì tự vẽ: bộ mã hoá QR đúng chuẩn cần Reed-Solomon,
 * chèn pattern, chọn mask theo điểm phạt và ghi format info — khoảng 300 dòng mà
 * chỉ cần sai một bước là mã không quét được, và không có bộ giải mã thì cũng
 * không có cách nào biết là mình đã sai. `qrcode-generator` chỉ một file, không
 * phụ thuộc gì thêm.
 */

/**
 * Vùng lặng bắt buộc quanh mã (4 module theo chuẩn).
 *
 * Thiếu nó thì máy quét không tách được mã khỏi nền — đây là lý do phổ biến nhất
 * khiến một QR "trông đúng" nhưng quét mãi không ra.
 */
const QUIET_ZONE = 4;

export function PaymentQr({
  value,
  label,
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const t = useDict();

  const { path, size } = useMemo(() => {
    // 0 = tự chọn phiên bản theo độ dài dữ liệu. "M" = sửa lỗi ~15%, đủ để quét
    // được cả khi màn hình loá hoặc bản in hơi bẩn.
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();

    const count = qr.getModuleCount();
    let d = "";

    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
        }
      }
    }

    return { path: d, size: count + QUIET_ZONE * 2 };
  }, [value]);

  return (
    <div className={`inline-flex flex-col items-center gap-2 ${className}`}>
      {/*
        Nền TRẮNG cố định, không theo theme tối của trang: máy quét cần tương phản
        sáng-tối đúng chiều. QR trắng trên nền đen thì phần lớn máy quét chịu thua.
      */}
      <div className="rounded-2xl bg-white p-3 ring-1 ring-leaf-500/40">
        <svg
          viewBox={`0 0 ${size} ${size}`}
          width={188}
          height={188}
          shapeRendering="crispEdges"
          role="img"
          aria-label={label ? t.a11y.qrLabelled(label) : t.a11y.qrGeneric}
        >
          <rect width={size} height={size} fill="#ffffff" />
          <path d={path} fill="#000000" />
        </svg>
      </div>
      {label && <div className="text-xs text-fg-subtle">{label}</div>}
    </div>
  );
}

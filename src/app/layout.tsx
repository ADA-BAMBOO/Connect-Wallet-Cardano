import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Ambient } from "@/components/Ambient";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "vietnamese"],
  // Chữ hiện ngay bằng font hệ thống rồi mới đổi sang webfont — không có khoảng
  // trắng chờ font tải (FOIT) trên mạng chậm.
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cardano Connect — Demo kết nối ví CIP-30",
  description:
    "Dự án mẫu kết nối ví hệ sinh thái Cardano: phát hiện ví, đọc số dư và NFT, đăng nhập bằng chữ ký, gửi giao dịch ADA.",
};

/**
 * `themeColor` khớp với nền trang để thanh địa chỉ trên mobile không lệch tông.
 * KHÔNG đặt `maximumScale`/`userScalable`: chặn zoom là chặn luôn cách người
 * mắt kém đọc được địa chỉ ví.
 */
export const viewport: Viewport = {
  themeColor: "#050e15",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    /*
     * suppressHydrationWarning trên <html> và <body>:
     *
     * Extension ví (Eternl, Lace, Nami…) chạy TRƯỚC khi React hydrate và thường
     * thêm/sửa attribute trên hai thẻ này (class, style, data-*). React so sánh
     * attribute do server render với DOM thực tế và báo:
     *   "some attributes of the server rendered HTML didn't match"
     *
     * Đây là nhiễu từ extension, không phải lỗi của app — dựng trang trong
     * browser không có extension thì console sạch hoàn toàn.
     *
     * Cờ này CHỈ bỏ qua cảnh báo cho attribute và text của đúng phần tử mang nó
     * (một cấp, không lan xuống con), nên không che được mismatch thật bên trong
     * các component. Đừng thêm nó vào component ứng dụng để "cho hết lỗi".
     */
    <html
      lang="vi"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col bg-canvas text-fg" suppressHydrationWarning>
        {/*
          Người dùng bàn phím không phải tab qua toàn bộ header mới tới nội dung.
          Link ẩn cho tới khi được focus.
        */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200]
            focus:rounded-lg focus:bg-leaf-500 focus:px-4 focus:py-2.5 focus:text-sm
            focus:font-medium focus:text-ink-950"
        >
          Bỏ qua, tới nội dung chính
        </a>

        <Ambient />
        {children}
      </body>
    </html>
  );
}

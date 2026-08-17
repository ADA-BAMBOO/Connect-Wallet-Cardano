import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "vietnamese"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cardano Connect — Demo kết nối ví CIP-30",
  description:
    "Dự án mẫu kết nối ví hệ sinh thái Cardano: phát hiện ví, đọc số dư và NFT, đăng nhập bằng chữ ký, gửi giao dịch ADA.",
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
      <body
        className="flex min-h-full flex-col bg-slate-950 text-slate-200"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}

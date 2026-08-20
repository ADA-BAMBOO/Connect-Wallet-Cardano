import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Ambient } from "@/components/Ambient";
import { LocaleProvider } from "@/lib/i18n/client";
import { getDictionary, getLocale } from "@/lib/i18n/server";

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

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDictionary();
  return { title: t.meta.homeTitle, description: t.meta.homeDescription };
}

/**
 * `themeColor` khớp với nền trang để thanh địa chỉ trên mobile không lệch tông.
 * KHÔNG đặt `maximumScale`/`userScalable`: chặn zoom là chặn luôn cách người
 * mắt kém đọc được địa chỉ ví.
 */
export const viewport: Viewport = {
  themeColor: "#050e15",
  colorScheme: "dark",
};

/**
 * Ngôn ngữ đọc từ cookie, nên layout gốc là dynamic — mọi trang bên dưới cũng vậy.
 * Đây là cái giá của việc chọn ngôn ngữ bằng cookie thay vì bằng đường dẫn; xem lý
 * do ở lib/i18n/locales.ts. Trang duy nhất từng tĩnh là trang chủ, mà nội dung của
 * nó vốn nằm trong một client component nạp với `ssr: false`.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  const t = await getDictionary();

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
      lang={locale}
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
          {t.a11y.skipToContent}
        </a>

        <Ambient />
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}

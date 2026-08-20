"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@meshsdk/react";

import { describeError, isRateLimited } from "@/lib/errors";

/**
 * Đọc dữ liệu từ ví đang kết nối — thay cho `useNetwork` / `useLovelace` /
 * `useAssets` / `useAddress` của Mesh.
 *
 * Có hai lý do phải tự viết, cả hai đều đã gây lỗi thật:
 *
 * 1. GỌI TRÙNG. Hook của Mesh gọi API ví một lần cho MỖI component dùng nó. Trang
 *    chủ có 5 thẻ cùng cần networkId và 2 thẻ cùng cần số dư, nên ví nhận một chùm
 *    lời gọi giống hệt nhau trong cùng một khoảnh khắc. Extension ví tự đặt rate
 *    limit cho API CIP-30, và chùm đó đủ để Eternl trả về "too many requests".
 *    Ở đây mỗi (wallet instance, loại dữ liệu) chỉ ứng với ĐÚNG MỘT lời gọi, mọi
 *    component dùng chung kết quả đó.
 *
 *    Đo được bằng `npm run verify:wallet-calls`: trước khi có file này, một lần tải
 *    trang chủ gọi getNetworkId 10 lần (5 thẻ × 2 vì StrictMode gọi effect hai lần
 *    lúc dev); sau khi có, còn đúng 1.
 *
 * 2. LỖI KHÔNG AI BẮT. Mesh viết thẳng `wallet.getX().then(setState)` — không có
 *    `.catch()`. Ví từ chối là promise rejected không ai xử lý, và Next.js dựng luôn
 *    màn hình đỏ "Runtime Error" đè lên trang, dù đây chỉ là lỗi tạm thời. Tệ hơn:
 *    ví CIP-30 ném object thuần `{code, info}` chứ không phải `Error`, nên màn hình
 *    đó chỉ hiện đúng một chữ "Object". Hook ở đây luôn bắt lỗi và trả nó ra dưới
 *    dạng dữ liệu.
 *
 * Rate limit là lỗi tạm thời nên còn được thử lại với backoff trước khi bỏ cuộc.
 */

type Wallet = ReturnType<typeof useWallet>["wallet"];

/** Chờ giữa các lần thử lại. Tổng cộng tối đa ~1.4s trước khi báo lỗi. */
const RETRY_DELAYS_MS = [200, 400, 800];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Một lời gọi cho mỗi (wallet instance, loại dữ liệu).
 *
 * WeakMap khoá theo chính object ví: Mesh giữ instance đó trong `useState` nên nó
 * ổn định suốt một phiên kết nối, và tự rụng khỏi cache khi người dùng ngắt kết nối
 * hoặc đổi ví. Không dùng Map thường — nó sẽ giữ instance ví sống mãi.
 */
const cache = new WeakMap<object, Map<string, Promise<unknown>>>();

async function withRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      // Chỉ thử lại khi ví chặn vì gọi quá dày. Lỗi khác (ví khoá, mất kết nối)
      // thử lại chỉ tổ chậm và làm ví thêm bận.
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRateLimited(err)) throw err;

      await sleep(delay);
    }
  }
}

function readOnce<T>(wallet: object, key: string, read: () => Promise<T>): Promise<T> {
  let perWallet = cache.get(wallet);
  if (!perWallet) {
    perWallet = new Map();
    cache.set(wallet, perWallet);
  }

  const cached = perWallet.get(key);
  if (cached) return cached as Promise<T>;

  const pending = withRetry(read);
  perWallet.set(key, pending);

  // Hỏng thì bỏ khỏi cache để lần mount sau còn được thử lại — nhưng phải gắn
  // handler ngay tại đây, nếu không chính promise trong cache lại thành một
  // rejection không ai bắt, đúng thứ file này sinh ra để tránh.
  pending.catch(() => perWallet.delete(key));

  return pending;
}

export type WalletValue<T> = {
  /** undefined khi chưa kết nối, chưa đọc xong, hoặc đọc lỗi. */
  value: T | undefined;
  /** Câu lỗi đọc được, null nếu không có lỗi. */
  error: string | null;
};

const EMPTY = { value: undefined, error: null } as const;

/**
 * `read` PHẢI là hàm ổn định (khai báo ở module scope). Truyền arrow inline vào đây
 * sẽ làm effect chạy lại mỗi lần render — đúng cái vòng lặp gọi ví mà file này tránh.
 */
function useWalletValue<T>(key: string, read: (wallet: Wallet) => Promise<T>): WalletValue<T> {
  const { wallet, connected } = useWallet();

  // `owner` ghi lại kết quả này thuộc về ví nào. Nhờ nó mà trạng thái "chưa kết nối"
  // được SUY RA lúc render thay vì phải setState trong effect để dọn — vừa tránh
  // cascading render mà React 19 cảnh báo, vừa không có khoảng nhấp nháy nào để lộ
  // dữ liệu của ví cũ ngay sau khi người dùng đổi ví.
  const [state, setState] = useState<WalletValue<T> & { owner: object | null }>({
    ...EMPTY,
    owner: null,
  });

  useEffect(() => {
    if (!connected || !wallet) return;

    let alive = true;

    readOnce(wallet, key, () => read(wallet)).then(
      (value) => alive && setState({ owner: wallet, value, error: null }),
      (err) => alive && setState({ owner: wallet, value: undefined, error: describeError(err) }),
    );

    return () => {
      alive = false;
    };
  }, [wallet, connected, key, read]);

  if (!connected || !wallet || state.owner !== wallet) return EMPTY;

  return { value: state.value, error: state.error };
}

/* ------------------------------------------------------------------ */
/* Reader — khai báo ở module scope để giữ identity ổn định            */
/* ------------------------------------------------------------------ */

const readNetworkId = (wallet: Wallet) => wallet.getNetworkId();
const readLovelace = (wallet: Wallet) => wallet.getLovelace();
const readAssets = (wallet: Wallet) => wallet.getAssets();

/**
 * Mesh `useAddress` chỉ lấy `getUsedAddresses()[0]` rồi thôi, nên ví mới tinh (chưa
 * có giao dịch nào) không hiện được địa chỉ nào cả — trên Preprod đây là trường hợp
 * bình thường, không phải ngoại lệ. Rơi về change address giống hệt cách chính
 * WalletContext của Mesh làm ở chỗ khác.
 */
const readAddress = async (wallet: Wallet): Promise<string | undefined> => {
  const used = await wallet.getUsedAddresses();
  return used[0] ?? (await wallet.getChangeAddress()) ?? undefined;
};

/* ------------------------------------------------------------------ */
/* API công khai                                                       */
/* ------------------------------------------------------------------ */

export type WalletNetwork = { networkId: number | undefined; error: string | null };

export function useWalletNetwork(): WalletNetwork {
  const { value, error } = useWalletValue("networkId", readNetworkId);
  return { networkId: value, error };
}

/** Cùng chữ ký trả về với `useNetwork()` của Mesh nên thay thẳng được. */
export function useNetworkId(): number | undefined {
  return useWalletNetwork().networkId;
}

/** Cùng chữ ký trả về với `useLovelace()` của Mesh. */
export function useLovelace(): string | undefined {
  return useWalletValue("lovelace", readLovelace).value;
}

/** Cùng chữ ký trả về với `useAssets()` của Mesh. */
export function useAssets() {
  return useWalletValue("assets", readAssets).value;
}

/** Cùng chữ ký trả về với `useAddress()` của Mesh. */
export function useWalletAddress(): string | undefined {
  return useWalletValue("address", readAddress).value;
}

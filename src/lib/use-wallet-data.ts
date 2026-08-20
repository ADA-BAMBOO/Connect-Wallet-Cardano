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

/**
 * Ví trả về MẢNG địa chỉ stake, nhưng một tài khoản CIP-30 chỉ có một. Lấy phần tử
 * đầu ngay tại đây để mọi chỗ dùng nhận cùng một hình dạng dữ liệu.
 *
 * Mảng rỗng là chuyện có thật chứ không phải lỗi: ví chỉ-đọc thêm bằng địa chỉ, và
 * một số ví phần cứng, không trả địa chỉ stake nào. Phân biệt với "hỏi ví thất bại"
 * là việc của `error` trong WalletValue.
 */
const readStakeAddress = async (wallet: Wallet): Promise<string | undefined> => {
  const rewards = await wallet.getRewardAddresses();
  return rewards[0] ?? undefined;
};

const readChangeAddress = async (wallet: Wallet): Promise<string | undefined> =>
  (await wallet.getChangeAddress()) ?? undefined;

/*
 * `await` chứ không trả thẳng: vài API CIP-30 trong Mesh khai kiểu `SometimesPromise`
 * — có ví trả Promise, có ví trả thẳng giá trị. `await` san phẳng cả hai.
 */
const readUtxos = async (wallet: Wallet) => await wallet.getUtxos();

/*
 * Khoá cache dùng chung giữa hook và bản gọi trực tiếp bên dưới. Viết thành hằng số
 * vì một chữ gõ lệch là hai lần hỏi ví thay vì một — mà đó chính là lỗi cả file này
 * sinh ra để chặn, và nó không biểu hiện thành lỗi biên dịch.
 */
const STAKE_KEY = "stakeAddress";
const CHANGE_KEY = "changeAddress";

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

/**
 * Địa chỉ stake — trả về cả `error` chứ không chỉ giá trị.
 *
 * Chỗ gọi PHẢI phân biệt được ba trạng thái, vì chúng cần ba câu trả lời khác nhau:
 *
 *   value=undefined, error=null   đang đọc, hoặc ví không có địa chỉ stake
 *   value=undefined, error="…"    hỏi ví thất bại — nói cho người dùng biết
 *   value="stake1…"               có địa chỉ
 *
 * Bản trước gộp cả ba vào một dấu gạch ngang trên giao diện, nên ví bị rate limit
 * trông y hệt ví không có địa chỉ stake, và không có cách nào biết được là cái nào.
 */
export function useStakeAddress(): WalletValue<string | undefined> {
  return useWalletValue(STAKE_KEY, readStakeAddress);
}

export function useChangeAddress(): WalletValue<string | undefined> {
  return useWalletValue(CHANGE_KEY, readChangeAddress);
}

export function useUtxos() {
  return useWalletValue("utxos", readUtxos);
}

/* ------------------------------------------------------------------ */
/* Bản gọi trực tiếp — cho handler, không phải cho render              */
/* ------------------------------------------------------------------ */

/*
 * Luồng đăng nhập cần địa chỉ NGAY LÚC BẤM, không phải lúc render, nên nó không dùng
 * được hook. Hai hàm dưới đi qua đúng cái cache của hook: thẻ Tài khoản đã đọc rồi
 * thì đây là cache hit, ví không bị hỏi lần hai. Và nếu người dùng bấm trước khi
 * thẻ kia đọc xong, cả hai cùng chờ MỘT lời gọi.
 */

export function fetchStakeAddress(wallet: Wallet): Promise<string | undefined> {
  return readOnce(wallet, STAKE_KEY, () => readStakeAddress(wallet));
}

export function fetchChangeAddress(wallet: Wallet): Promise<string | undefined> {
  return readOnce(wallet, CHANGE_KEY, () => readChangeAddress(wallet));
}

/**
 * Tái hiện chính xác luồng đăng nhập phía trình duyệt, KHÔNG cần extension ví.
 *
 * Dựng một ví CIP-30 giả cắm vào `window.cardano`, rồi chạy `BrowserWallet`
 * thật của Mesh (đúng lớp mà UI dùng) qua các API route thật.
 *
 * Ví giả ký bằng đúng key ứng với địa chỉ được yêu cầu: stake key cho reward
 * address, payment key cho base address — giống hành vi ví thật.
 *
 * Yêu cầu server đang chạy. Chạy: node scripts/verify-browser-login.mjs [baseUrl]
 */
import { BrowserWallet, MeshWallet } from "@meshsdk/core";
import { signData, Address } from "@meshsdk/core-cst";
import { describeError, isDataSigningUnsupported, isUserDeclined } from "../src/lib/errors.ts";

const BASE = process.argv[2] ?? "http://localhost:3000";
const NETWORK_ID = 0; // testnet

let failures = 0;
function assert(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` -> nhận ${JSON.stringify(actual)}, chờ ${JSON.stringify(expected)}`}`);
}

/* ------------------------------------------------------------------ */
/* Ví CIP-30 giả                                                       */
/* ------------------------------------------------------------------ */

async function createMockWallet({
  supportsStakeSigning,
  supportsDataSigning = true,
  stakeErrorMessage = null,
}) {
  const calls = { signData: 0 };
  const words = MeshWallet.brew();
  const mesh = new MeshWallet({
    networkId: NETWORK_ID,
    key: { type: "mnemonic", words: Array.isArray(words) ? words : words.split(" ") },
  });

  // Lấy key trực tiếp từ account của MeshWallet để đảm bảo key khớp đúng địa chỉ.
  // (Tự dẫn xuất lại bằng bip39 + buildKeys ra key KHÁC — đừng làm vậy.)
  const { paymentKey, stakeKey, baseAddressBech32, rewardAddressBech32 } =
    mesh._wallet.getAccount(0, 0);

  const toHex = (bech32) => Address.fromBech32(bech32).toBytes().toString();

  return {
    name: "MockWallet",
    icon: "data:image/svg+xml,",
    version: "1.0.0",
    apiVersion: "0.1.0",
    baseAddressBech32,
    rewardAddressBech32,
    calls,
    enable: async () => ({
      getNetworkId: async () => NETWORK_ID,
      getUtxos: async () => [],
      getCollateral: async () => [],
      getBalance: async () => "00",
      getUsedAddresses: async () => [toHex(baseAddressBech32)],
      getUnusedAddresses: async () => [],
      getChangeAddress: async () => toHex(baseAddressBech32),
      getRewardAddresses: async () => [toHex(rewardAddressBech32)],
      getExtensions: async () => [],
      submitTx: async () => "00".repeat(32),
      signTx: async () => "",

      // Đây là phần quan trọng: chọn key theo địa chỉ được yêu cầu.
      signData: async (addressHex, payloadHex) => {
        calls.signData++;

        // Eternl trả lỗi này khi tài khoản là hardware wallet / multi-sig / read-only.
        // Lỗi thuộc về cả ví, không riêng địa chỉ nào.
        if (!supportsDataSigning) {
          throw { code: 1, info: "This wallet doesn't support general data signing." };
        }

        const address = Address.fromBytes(addressHex);
        const bech32 = address.toBech32();

        if (bech32 === rewardAddressBech32) {
          if (!supportsStakeSigning) {
            // Ví thật ném object CIP-30 `{code, info}`, KHÔNG phải Error.
            // `stakeErrorMessage` cho phép mô phỏng ví trả câu lỗi gây hiểu nhầm
            // là "cả ví không ký được", dù thực ra chỉ stake address bị từ chối.
            throw stakeErrorMessage
              ? { code: 1, info: stakeErrorMessage }
              : { code: 2, info: "Address not a P2PK address" }; // DataSignError.AddressNotPK
          }
          return signData(payloadHex, { address, key: stakeKey });
        }

        if (bech32 === baseAddressBech32) {
          return signData(payloadHex, { address, key: paymentKey });
        }

        throw new Error(`Address ${bech32} does not belong to this wallet`);
      },
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Luồng đăng nhập — bản sao logic của SignInCard.signIn()             */
/* ------------------------------------------------------------------ */

async function login(wallet) {
  const [stakeAddress] = await wallet.getRewardAddresses();
  const changeAddress = await wallet.getChangeAddress();

  const candidates = [stakeAddress, changeAddress].filter((a) => typeof a === "string" && a);
  let lastError = null;
  let usedAddress = null;
  let cookie = null;

  for (const address of candidates) {
    try {
      const nonceRes = await fetch(`${BASE}/api/auth/nonce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const noncePayload = await nonceRes.json();
      if (!nonceRes.ok) throw new Error(noncePayload.error ?? "Không lấy được nonce.");

      const signature = await wallet.signData(noncePayload.nonce, address);

      const verifyRes = await fetch(`${BASE}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, signature }),
      });
      const verifyPayload = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verifyPayload.error ?? "Xác minh chữ ký thất bại.");

      cookie = (verifyRes.headers.get("set-cookie") ?? "").split(";")[0];
      usedAddress = address;
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      // Giống SignInCard: CHỈ dừng sớm khi người dùng chủ động huỷ.
      if (isUserDeclined(err, "data")) throw err;
    }
  }

  if (lastError) throw lastError;
  return { usedAddress, cookie };
}

/* ------------------------------------------------------------------ */

async function scenario(label, { supportsStakeSigning, expectStake, stakeErrorMessage = null }) {
  console.log(`\n--- ${label} ---`);

  const mock = await createMockWallet({ supportsStakeSigning, stakeErrorMessage });
  globalThis.window = { cardano: { mockwallet: mock } };

  const wallet = await BrowserWallet.enable("mockwallet");

  try {
    const { usedAddress, cookie } = await login(wallet);

    assert("đăng nhập thành công", typeof cookie === "string" && cookie.length > 0, true);
    assert(
      expectStake ? "dùng stake address" : "fallback sang payment address",
      usedAddress === (expectStake ? mock.rewardAddressBech32 : mock.baseAddressBech32),
      true,
    );

    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json();
    assert("me trả về đúng địa chỉ", me.address, usedAddress);
    assert("me: isStakeAddress đúng", me.isStakeAddress, expectStake);
  } catch (err) {
    failures++;
    console.log(`FAIL  đăng nhập ném lỗi: ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`Base URL: ${BASE}`);

// Ví hỗ trợ ký bằng stake key (Eternl, Lace, Typhon…)
await scenario("Ví hỗ trợ ký bằng stake address", { supportsStakeSigning: true, expectStake: true });

// Ví ném lỗi CIP-30 dạng object -> phải tự fallback sang payment address
await scenario("Ví KHÔNG hỗ trợ stake signing", { supportsStakeSigning: false, expectStake: false });

// Trường hợp gây hiểu nhầm: ví chỉ từ chối stake address nhưng trả về đúng câu
// "doesn't support general data signing". Nếu tin lời ví mà dừng sớm thì mất
// fallback — trong khi payment address ký hoàn toàn bình thường.
await scenario("Ví báo 'không hỗ trợ data signing' nhưng CHỈ với stake address", {
  supportsStakeSigning: false,
  expectStake: false,
  stakeErrorMessage: "This wallet doesn't support general data signing.",
});

/* Tài khoản Eternl kiểu hardware/multi-sig/read-only ------------------------- */
console.log("\n--- Ví không hỗ trợ data signing (Eternl hardware/multi-sig) ---");
{
  const mock = await createMockWallet({ supportsStakeSigning: true, supportsDataSigning: false });
  globalThis.window = { cardano: { mockwallet: mock } };
  const wallet = await BrowserWallet.enable("mockwallet");

  let caught = null;
  try {
    await login(wallet);
  } catch (err) {
    caught = err;
  }

  assert("đăng nhập thất bại (đúng như mong đợi)", caught !== null, true);
  assert("nhận diện đúng loại lỗi để hiện hướng dẫn", isDataSigningUnsupported(caught), true);
  assert("KHÔNG bị hiểu nhầm là user huỷ", isUserDeclined(caught, "data"), false);

  // Không được dừng sớm: có ví trả đúng câu lỗi này khi chỉ riêng stake address
  // không ký được, còn payment address vẫn ký bình thường. Phải thử hết candidate.
  assert("vẫn thử nốt payment address (2 lần ký)", mock.calls.signData, 2);
  assert(
    "thông báo giữ nguyên nội dung ví trả về",
    describeError(caught),
    "This wallet doesn't support general data signing.",
  );
}

/* Lỗi CIP-30 phải hiện thành câu đọc được, không phải "[object Object]" -------- */
console.log("\n--- Xử lý lỗi CIP-30 dạng object ---");
{
  assert("mô tả được lỗi {code, info}", describeError({ code: 2, info: "Address not a P2PK address" }), "Address not a P2PK address");
  assert("KHÔNG ra [object Object]", describeError({ code: 2 }).includes("[object Object]"), false);
  assert("nhận diện user declined qua code 3", isUserDeclined({ code: 3, info: "User declined" }, "data"), true);
  assert("nhận diện user declined qua code 2 (tx)", isUserDeclined({ code: 2, info: "User declined to sign" }, "tx"), true);
  assert("AddressNotPK KHÔNG bị coi là user declined", isUserDeclined({ code: 2, info: "Address not a P2PK address" }, "data"), false);

  // Chuỗi lỗi thật do Eternl trả về khi tài khoản là hardware/multi-sig/read-only.
  const eternl = { code: 1, info: "This wallet doesn't support general data signing." };
  assert("nhận diện Eternl 'không hỗ trợ data signing'", isDataSigningUnsupported(eternl), true);
  assert("dạng Error cũng nhận diện được", isDataSigningUnsupported(new Error("This wallet does not support general data signing")), true);
  assert("KHÔNG nhầm với user declined", isDataSigningUnsupported({ code: 3, info: "User declined" }), false);
  assert("KHÔNG nhầm với AddressNotPK", isDataSigningUnsupported({ code: 2, info: "Address not a P2PK address" }), false);
  assert("Eternl KHÔNG bị coi là user declined", isUserDeclined(eternl, "data"), false);
}

console.log(`\n${failures === 0 ? "Tất cả kiểm tra đã pass." : `${failures} kiểm tra thất bại.`}`);
process.exit(failures === 0 ? 0 : 1);

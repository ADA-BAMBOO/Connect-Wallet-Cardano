/**
 * Kiểm chứng luồng đăng nhập bằng ví mà không cần trình duyệt hay extension.
 *
 * Dùng MeshWallet (ví server-side sinh từ mnemonic) để đóng vai người dùng,
 * chạy đúng chuỗi generateNonce -> signData -> checkSignature mà API route dùng.
 *
 * LƯU Ý: MeshWallet luôn ký bằng *payment key*, kể cả khi truyền địa chỉ stake
 * (xem EmbeddedWallet.signData). Vì vậy script này kiểm tra bằng base address.
 * Ví CIP-30 trong trình duyệt thì ký đúng bằng stake key khi nhận reward address —
 * đó là lý do UI thử stake address trước rồi mới fallback về payment address.
 *
 * Chạy: node scripts/verify-auth.mjs
 */
import { MeshWallet, generateNonce, checkSignature } from "@meshsdk/core";

let failures = 0;

function assert(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${actual}`);
}

function makeWallet() {
  // MeshWallet 1.8.x khởi tạo ngay trong constructor, không có bước init() riêng.
  return new MeshWallet({
    networkId: 0, // testnet
    key: { type: "mnemonic", words: MeshWallet.brew() },
  });
}

const user = makeWallet();
const userAddress = user.getChangeAddress();
console.log("Địa chỉ dùng để ký:", userAddress, "\n");

// generateNonce trả về chuỗi HEX; signData nhận hex và giữ nguyên (fromUTF8 bỏ qua
// chuỗi đã là hex), nên payload hai bên khớp nhau.
const nonce = generateNonce("Dang nhap Cardano Wallet Demo. Nonce: ");
const signature = await user.signData(nonce, userAddress);

// 1. Đường đi đúng
assert("chữ ký hợp lệ với đúng nonce + đúng địa chỉ", checkSignature(nonce, signature, userAddress), true);

// 2. Đổi nonce -> chữ ký phải fail
assert("nonce khác bị từ chối", checkSignature(generateNonce("khac"), signature, userAddress), false);

// 3. Mạo danh: kẻ tấn công xin nonce của nạn nhân, ký bằng ví của mình,
//    rồi khai địa chỉ của nạn nhân.
const attacker = makeWallet();
const attackerAddress = attacker.getChangeAddress();
const attackerSig = await attacker.signData(nonce, attackerAddress);

assert("mạo danh bị từ chối khi có truyền address", checkSignature(nonce, attackerSig, userAddress), false);

// 4. Vì sao tham số address là BẮT BUỘC: bỏ nó đi thì chữ ký của kẻ tấn công
//    vẫn được coi là hợp lệ. Đây chính là lỗ hổng mà verify/route.ts phải tránh.
assert(
  "bỏ address => chữ ký kẻ tấn công lọt (nên route LUÔN truyền address)",
  checkSignature(nonce, attackerSig),
  true,
);

console.log(`\n${failures === 0 ? "Tất cả kiểm tra đã pass." : `${failures} kiểm tra thất bại.`}`);
process.exit(failures === 0 ? 0 : 1);

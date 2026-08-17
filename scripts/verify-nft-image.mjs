/**
 * Kiểm tra việc giải mã trường ảnh NFT với các dạng dữ liệu thật gặp trên chain.
 *
 * Chạy: node scripts/verify-nft-image.mjs
 */
import { resolveImageUrl, resolveLogoUrl, resolveImageCandidates } from "../src/lib/nft.ts";

const IPFS = "https://ipfs.io/ipfs/";
const CID0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

let failures = 0;
function assert(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${label}\n      nhận: ${actual}\n      chờ : ${expected}`);
  } else {
    console.log(`PASS  ${label}`);
  }
}

/* Dạng chuẩn -------------------------------------------------------- */
assert("ipfs:// + CIDv0", resolveImageUrl(`ipfs://${CID0}`), IPFS + CID0);
assert("ipfs:// + CIDv1", resolveImageUrl(`ipfs://${CID1}`), IPFS + CID1);
assert("https:// giữ nguyên", resolveImageUrl("https://x.io/a.png"), "https://x.io/a.png");
assert("data URI giữ nguyên", resolveImageUrl("data:image/png;base64,AAA"), "data:image/png;base64,AAA");

/* Các dạng mà bản cũ BỎ SÓT ---------------------------------------- */
assert("CID trần (CIDv0, không scheme)", resolveImageUrl(CID0), IPFS + CID0);
assert("CID trần (CIDv1, không scheme)", resolveImageUrl(CID1), IPFS + CID1);
assert("ipfs://ipfs/ lặp tiền tố", resolveImageUrl(`ipfs://ipfs/${CID0}`), IPFS + CID0);
assert("http:// (không phải https)", resolveImageUrl("http://x.io/a.png"), "http://x.io/a.png");
assert("CID kèm đường dẫn con", resolveImageUrl(`${CID0}/hinh.png`), `${IPFS}${CID0}/hinh.png`);
assert("ar:// Arweave", resolveImageUrl("ar://abc123"), "https://arweave.net/abc123");

/* Mảng bị cắt của CIP-25 (chuỗi >64 ký tự) -------------------------- */
assert(
  "mảng chuỗi bị cắt",
  resolveImageUrl(["ipfs://", CID0.slice(0, 20), CID0.slice(20)]),
  IPFS + CID0,
);

/* Đầu vào rác -> undefined (UI hiện placeholder) -------------------- */
assert("chuỗi rỗng", resolveImageUrl(""), undefined);
assert("null", resolveImageUrl(null), undefined);
assert("số", resolveImageUrl(123), undefined);
assert("chuỗi vô nghĩa", resolveImageUrl("khong-phai-anh"), undefined);
assert("mảng lẫn kiểu", resolveImageUrl(["a", 1]), undefined);
assert("chỉ có scheme", resolveImageUrl("ipfs://"), undefined);

/* Logo fungible token ---------------------------------------------- */
const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH";
assert("logo base64 không tiền tố", resolveLogoUrl(b64), `data:image/png;base64,${b64}`);
assert("logo dạng ipfs vẫn chạy", resolveLogoUrl(`ipfs://${CID0}`), IPFS + CID0);
assert("logo rác", resolveLogoUrl("abc"), undefined);

/* Failover gateway ------------------------------------------------- */
// Gateway IPFS đơn lẻ chỉ tải được ~50% ảnh NFT thật, nên phải có nhiều ứng viên.
const ipfsCandidates = resolveImageCandidates(`ipfs://${CID0}`);
assert("ảnh IPFS có nhiều gateway để thử", ipfsCandidates.length > 1, true);
assert("mọi ứng viên đều trỏ cùng CID", ipfsCandidates.every((u) => u.endsWith(CID0)), true);
assert("không có ứng viên trùng nhau", new Set(ipfsCandidates).size, ipfsCandidates.length);
assert("URL https chỉ có 1 ứng viên", resolveImageCandidates("https://x.io/a.png").length, 1);
assert("data URI chỉ có 1 ứng viên", resolveImageCandidates("data:image/png;base64,AAA").length, 1);
assert("đầu vào rác => mảng rỗng", resolveImageCandidates("xyz").length, 0);

console.log(`\n${failures === 0 ? "Tất cả kiểm tra đã pass." : `${failures} kiểm tra thất bại.`}`);
process.exit(failures === 0 ? 0 : 1);
